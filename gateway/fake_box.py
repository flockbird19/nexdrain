"""Pretends to be the ESP32 box: prints $NX lines once a second, with the MQ-7 heater cycle.
Use it to test the receiver and dashboard before the hardware is ready, and as a self-check.

    python gateway/fake_box.py | python gateway/receiver.py --stdin --no-serial --no-lora
    python gateway/fake_box.py --leak 120     (methane starts rising after 120 s)
    python gateway/fake_box.py --test         (checks the line format round-trips)
"""
import argparse
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from receiver import parse_line, with_checksum  # noqa: E402


def line(seq, ch4, co, phase, phase_s, dist, alarm=0, muted=0):
    d = f"{dist:.1f}" if dist is not None else ""
    return with_checksum(f"NX,1,{seq},{seq},{ch4:.0f},{co:.0f},{phase},{phase_s},{d},{alarm},{muted}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leak", type=int, default=0, help="seconds before methane starts rising (0 = never)")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()

    if a.test:
        p = parse_line(line(7, 1620, 980, "L", 37, 143.2))
        assert p == {"box": 1, "seq": 7, "uptime": 7, "ch4": 1620.0, "co": 980.0, "co_phase": "L",
                     "co_phase_s": 37, "dist": 143.2, "alarm": 0, "muted": False}, p
        assert parse_line(line(8, 1, 1, "H", 0, None))["dist"] is None
        assert parse_line(line(7, 1620, 980, "L", 37, 143.2).replace("1620", "1621")) is None  # bad checksum
        assert parse_line("# NEXDRAIN box 1") is None
        assert line(1834, 1620, 980, "L", 37, 143.2).endswith("*71")  # matches the brief's example

        # Same reading over USB and LoRa is counted once; gaps count as lost; a reboot (seq back to 0) is accepted.
        import tempfile
        import types
        import receiver
        receiver.DATA = Path(tempfile.mkdtemp())
        live = receiver.Live(types.SimpleNamespace(empty_cm=60.0, full_cm=25.0))
        for s, src in ((0, "usb"), (1, "usb"), (1, "lora"), (2, "usb")):
            live.feed(line(s, 900, 700, "L", 10, 50.0), src)
        assert (live.lines, live.lost) == (3, 0), (live.lines, live.lost)
        live.feed(line(5, 900, 700, "L", 10, 50.0), "usb")
        assert live.lost == 2, live.lost
        live.feed(line(20, 900, 700, "L", 10, 50.0), "usb")
        live.feed(line(0, 900, 700, "L", 10, 50.0), "usb")   # reboot: seq and uptime back to 0
        assert live.lines == 6 and live.last_seq == 0, (live.lines, live.last_seq)
        live.db.close()
        print("fake_box self-check OK")
        return

    seq = 0
    while True:
        t = seq % 150
        phase, phase_s = ("H", t) if t < 60 else ("L", t - 60)
        rise = max(0, seq - a.leak) * 4 if a.leak else 0          # mV per second once the leak starts
        ch4 = 900 + rise + random.gauss(0, 8)
        co = (2200 if phase == "H" else 700) + random.gauss(0, 8)
        dist = 50 + random.gauss(0, 0.5) if random.random() > 0.03 else None
        print(line(seq, min(ch4, 4900), co, phase, phase_s, dist), flush=True)
        seq += 1
        time.sleep(1 / a.speed)


if __name__ == "__main__":
    main()
