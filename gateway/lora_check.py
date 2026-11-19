"""First radio test on the Pi: checks the Ra-02 answers, then prints every packet heard, raw.
Only one program can use the radio, so stop the receiver first:

    pkill -f gateway/receiver.py
    cd ~/nexdrain && .venv/bin/python gateway/lora_check.py
    (Ctrl+C to stop, then start the receiver again with gateway/run.sh)
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sx1278 import SX1278  # noqa: E402

try:
    radio = SX1278()
except Exception as e:
    sys.exit(f"FAIL: {e}\nCheck the wiring sheet, section 9: 3.3V on pin 1, GND pin 6, MOSI 19, MISO 21, "
             "SCK 23, NSS 24, RST 15. A version of 0x00 or 0xFF means the chip is not answering at all.")

frf = (radio.read(0x06) << 16) | (radio.read(0x07) << 8) | radio.read(0x08)
checks = {
    "mode (LoRa, receiving)": (radio.read(0x01), 0x85),
    "frequency 433.5 MHz": (round(frf * 32e6 / 2**19 / 1e5) / 10, 433.5),
    "bandwidth 125 kHz, CR 4/5": (radio.read(0x1D), 0x72),
    "spreading factor 9, CRC on": (radio.read(0x1E) & 0xF4, 0x94),
    "sync word 0x12": (radio.read(0x39), 0x12),
}
bad = [k for k, (got, want) in checks.items() if got != want]
for k, (got, want) in checks.items():
    print(f"  {'ok ' if got == want else 'BAD'}  {k}: read {got if isinstance(got, float) else hex(got)}")
if bad:
    sys.exit("FAIL: the chip answered but did not keep these settings: " + ", ".join(bad)
             + ". Usually a loose MOSI wire or a bad solder joint on the header.")
print("Ra-02 OK: the chip answered. Listening on 433.5 MHz, SF9, BW 125 kHz, sync word 0x12. Ctrl+C to stop.")
count, crc_seen = 0, 0
while True:
    pkt = radio.receive()
    if pkt:
        data, rssi, snr = pkt
        count += 1
        print(f"{time.strftime('%H:%M:%S')}  #{count}  signal {rssi} dBm  snr {snr:+.1f} dB  {data!r}", flush=True)
    elif radio.crc_errors != crc_seen:
        crc_seen = radio.crc_errors
        print(f"{time.strftime('%H:%M:%S')}  damaged packet (CRC error), total {crc_seen}: radio works, signal weak or noisy",
              flush=True)
    else:
        time.sleep(0.02)
