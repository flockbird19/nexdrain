// NEXDRAIN sensor box firmware v1.0 (ESP32 Dev Module, esp32 core 3.x, "LoRa" by Sandeep Mistry 0.8.0).
// Spec: NEXDRAIN_ESP32_Firmware_Brief.md. Pins: NEXDRAIN_Wiring_Sheet.md.
//
// Every 1 s: read MQ-4, MQ-7 and the level sensor, run the local alarm, print one $NX line on USB.
// Every 5 s: send the same line over LoRa. Raw mV and cm only; the receiver converts and predicts.
// USB commands: T (buzzer test), M (mute 5 min), U (unmute). S0..S3 from the receiver are ignored (no LEDs fitted).
// Runs with any part missing (bare board, no radio, no sensors). Watchdog restarts it if it ever hangs.

#include <SPI.h>
#include <LoRa.h>
#include <esp_task_wdt.h>

// ---------- settings you may need to change at the table ----------
#define BOX_ID            1
#define DIVIDER_RATIO     1.5f   // 10k top / 20k bottom divider. Measure your resistors: ratio = (top + bottom) / bottom
#define MQ7_HEATER_CYCLE  0      // 0 = heater always on (our wiring, 20 Nov: no MOSFET, GPIO 25 empty), phase sent as C, CO indicative only
#define MQ7_LOW_DUTY_PCT  8      // ~1.4 V worth of heater power: (1.4/5)^2 = 8%
#define BUZZER_PASSIVE    1      // 1 if the buzzer only clicks when on (it needs a tone); 0 = active buzzer
// Local alarm limits. PLACEHOLDERS, NOT CALIBRATED: set them from the clean-air and sanitiser readings (brief section 8).
#define CH4_ALARM_MV      2500
#define CO_ALARM_MV       3500   // only checked in phase L or C. Clean air read ~2655 mV with the heater always on (20 Nov)
#define LEVEL_ALARM_CM    30     // sewage closer than this to the sensor = nearly full

// ---------- pins (fixed, same as the wiring sheet) ----------
const int PIN_CH4 = 34, PIN_CO = 35, PIN_HEATER = 25, PIN_TRIG = 26, PIN_ECHO = 27;
const int PIN_BUZZER = 13;   // no LEDs fitted on this box (20 Nov)
const int PIN_NSS = 5, PIN_RST = 14, PIN_DIO0 = 2;

const uint32_t PHASE_H_MS = 60000, PHASE_L_MS = 90000, MUTE_MS = 300000UL, TEST_MS = 2500;

bool loraOk = false, muted = false;
uint32_t seq = 0, lastTick = 0, phaseStart = 0, muteStart = 0, testStart = 0;
bool testing = false;
char phase = MQ7_HEATER_CYCLE ? 'H' : 'C';
char cmd[8]; uint8_t cmdLen = 0;

struct Alarm { uint8_t over = 0, under = 0; bool on = false; } aCh4, aCo, aLevel;

// on after 3 readings over the limit, off after 10 under; state -1 = no valid reading, keep as is
void stepAlarm(Alarm &a, int state) {
  if (state < 0) return;
  if (state) { a.under = 0; if (a.over < 3 && ++a.over == 3) a.on = true; }
  else       { a.over = 0;  if (a.under < 10 && ++a.under == 10) a.on = false; }
}

int readMilliVolts(int pin) {    // 16-sample average, divider undone
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(pin);
  return (int)(sum / 16 * DIVIDER_RATIO);
}

float readDistanceCm() {         // median of 5 pings, 60 ms apart; -1 = no valid reading
  float d[5]; int n = 0;
  for (int i = 0; i < 5; i++) {
    digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
    digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(20);
    digitalWrite(PIN_TRIG, LOW);
    unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000);
    float cm = us * 0.0343f / 2;
    if (cm >= 20 && cm <= 450) d[n++] = cm;
    if (i < 4) delay(60);
  }
  if (!n) return -1;
  for (int i = 1; i < n; i++) for (int j = i; j > 0 && d[j] < d[j - 1]; j--) { float t = d[j]; d[j] = d[j - 1]; d[j - 1] = t; }
  return d[n / 2];
}

void setHeater(char p) { ledcWrite(PIN_HEATER, p == 'L' ? 256 * MQ7_LOW_DUTY_PCT / 100 : 256); }

void updateHeater(uint32_t now) {
  if (!MQ7_HEATER_CYCLE) return;
  if (now - phaseStart >= (phase == 'H' ? PHASE_H_MS : PHASE_L_MS)) {
    phase = phase == 'H' ? 'L' : 'H';
    phaseStart = now;
    setHeater(phase);
  }
}

void buzz(bool on) { ledcWrite(PIN_BUZZER, on ? (BUZZER_PASSIVE ? 128 : 256) : 0); }

void updateOutputs(uint32_t now) {
  bool blink = (now % 1000) < 500;
  if (testing) {                 // 1 s steady sound (active buzzer), pause, 1 s tone (passive buzzer)
    uint32_t t = now - testStart;
    if (t >= TEST_MS) { testing = false; Serial.println("# TEST OK"); return; }
    ledcWrite(PIN_BUZZER, t < 1000 ? 256 : t >= 1500 ? 128 : 0);
    return;
  }
  if (muted && now - muteStart >= MUTE_MS) muted = false;
  bool alarm = aCh4.on || aCo.on || aLevel.on;
  buzz(alarm && !muted && blink);  // 0.5 s on, 0.5 s off while in alarm
}

void handleCommand(const char *c) {
  if (!strcmp(c, "T")) { testing = true; testStart = millis(); Serial.println("# TEST: 1 s steady sound, then 1 s tone"); }
  else if (!strcmp(c, "M")) { muted = true; muteStart = millis(); Serial.println("# MUTED"); }
  else if (!strcmp(c, "U")) { muted = false; Serial.println("# UNMUTED"); }
}

void readCommands() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') { cmd[cmdLen] = 0; if (cmdLen) handleCommand(cmd); cmdLen = 0; }
    else if (cmdLen < sizeof(cmd) - 1) cmd[cmdLen++] = ch;
  }
}

void tick(uint32_t now) {
  int ch4 = readMilliVolts(PIN_CH4), co = readMilliVolts(PIN_CO);
  float dist = readDistanceCm();
  bool coValid = phase != 'H';

  stepAlarm(aCh4, ch4 > CH4_ALARM_MV);
  stepAlarm(aCo, coValid ? co > CO_ALARM_MV : -1);
  stepAlarm(aLevel, dist < 0 ? -1 : dist < LEVEL_ALARM_CM);
  int mask = aCh4.on | aCo.on << 1 | aLevel.on << 2;

  char d[12] = "";
  if (dist >= 0) snprintf(d, sizeof d, "%.1f", dist);
  uint32_t phaseS = MQ7_HEATER_CYCLE ? (now - phaseStart) / 1000 : now / 1000;
  char body[100], line[110];
  snprintf(body, sizeof body, "NX,%d,%lu,%lu,%d,%d,%c,%lu,%s,%d,%d", BOX_ID, (unsigned long)seq, (unsigned long)(now / 1000),
           ch4, co, phase, (unsigned long)phaseS, d, mask, muted ? 1 : 0);
  uint8_t cs = 0;
  for (char *p = body; *p; p++) cs ^= *p;
  snprintf(line, sizeof line, "$%s*%02X", body, cs);
  Serial.println(line);

  if (loraOk && seq % 5 == 0) {  // same line, same seq; the receiver expects gaps of 5
    LoRa.beginPacket();
    LoRa.print(line);
    LoRa.endPacket();            // about 0.25 s at SF9
  }
  seq++;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT); pinMode(PIN_ECHO, INPUT);
  if (MQ7_HEATER_CYCLE) { ledcAttach(PIN_HEATER, 5000, 8); setHeater(phase); }
  ledcAttach(PIN_BUZZER, 2700, 8);   // 2.7 kHz tone for a passive buzzer; full duty = steady on for an active one
  buzz(false);

  LoRa.setPins(PIN_NSS, PIN_RST, PIN_DIO0);
  if (LoRa.begin(433.5E6)) {         // must match the Pi exactly; never above 10 dBm (legal limit in India)
    LoRa.setSpreadingFactor(9);
    LoRa.setSignalBandwidth(125E3);
    LoRa.setCodingRate4(5);
    LoRa.setSyncWord(0x12);
    LoRa.enableCrc();
    LoRa.setTxPower(10);
    loraOk = true;
  }

  esp_task_wdt_config_t wdt = { .timeout_ms = 10000, .idle_core_mask = 0, .trigger_panic = true };
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);
  esp_task_wdt_add(NULL);

  Serial.printf("# NEXDRAIN box %d, firmware v1.0, LoRa: %s\n", BOX_ID, loraOk ? "OK" : "ABSENT");
  Serial.println(MQ7_HEATER_CYCLE ? "# MQ-7 heater cycle: ON" : "# MQ-7 heater cycle: OFF, continuous");
  Serial.printf("# Alarm limits (not calibrated): CH4 %d mV, CO %d mV, level %d cm\n", CH4_ALARM_MV, CO_ALARM_MV, LEVEL_ALARM_CM);
}

void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();
  readCommands();
  updateHeater(now);
  if (now - lastTick >= 1000) { lastTick = now; tick(now); }
  updateOutputs(millis());
  delay(5);
}
