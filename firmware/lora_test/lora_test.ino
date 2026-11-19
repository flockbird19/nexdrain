// NEXDRAIN LoRa link test (ESP32 + Ra-02). Sends "hello 1", "hello 2", ... every 5 s.
// Settings match the Pi receiver exactly: 433.5 MHz, SF9, BW 125 kHz, CR 4/5, sync word 0x12, CRC on, 10 dBm.
// Not the real firmware: it sends no sensor data, so the Pi's receiver ignores it.
// Watch it on the Pi with gateway/lora_check.py.
//
// Library: "LoRa" by Sandeep Mistry (Arduino Library Manager). Board: ESP32 Dev Module.
// Wiring (NEXDRAIN_Wiring_Sheet.md): 3.3V->3V3, GND->GND, SCK->18, MISO->19, MOSI->23, NSS->5, RST->14, DIO0->2.
// Screw the antenna on BEFORE powering. Never raise the power above 10 dBm (legal limit in India).

#include <SPI.h>
#include <LoRa.h>

const int PIN_NSS = 5, PIN_RST = 14, PIN_DIO0 = 2;
unsigned long count = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  LoRa.setPins(PIN_NSS, PIN_RST, PIN_DIO0);
  if (!LoRa.begin(433.5E6)) {
    Serial.println("# LoRa: ABSENT. Check 3.3V, GND, NSS (5), RST (14) and the SPI wires.");
    while (true) delay(1000);
  }
  LoRa.setSpreadingFactor(9);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  LoRa.setSyncWord(0x12);
  LoRa.enableCrc();
  LoRa.setTxPower(10);
  Serial.println("# LoRa: OK. Sending 'hello N' every 5 s.");
}

void loop() {
  count++;
  LoRa.beginPacket();
  LoRa.print("hello ");
  LoRa.print(count);
  LoRa.endPacket();
  Serial.print("sent hello ");
  Serial.println(count);
  delay(5000);
}
