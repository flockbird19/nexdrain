"""NEXDRAIN receiver: box lines in (USB serial, LoRa, or stdin) -> prediction software -> SQLite + HTTP API + dashboard.

Line format from the box (see NEXDRAIN_ESP32_Firmware_Brief.md, section 5.7):
    $NX,box,seq,uptime_s,ch4_mV,co_mV,co_phase,co_phase_s,dist_cm,alarm,muted*CS

Run:  python gateway/receiver.py                 (USB auto-detect + LoRa if present, dashboard on :8600)
      python gateway/fake_box.py | python gateway/receiver.py --stdin --no-serial --no-lora
"""
import argparse
import collections
import json
import math
import sqlite3
import sys
import threading
import time
from functools import reduce
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import config  # noqa: E402
from generator.synthetic_gas_data import generate_gas_data  # noqa: E402
from pipeline.aggregator import MultiGasAggregator  # noqa: E402
from pipeline.level import LevelMonitor  # noqa: E402

DATA = ROOT / "data"
DASHBOARD = ROOT / "dashboard"
ALL_GASES = ["H2S", "CH4", "CO", "NH3"]  # O2 is shown as "not installed" by the dashboard; no pipeline exists for it
LIVE_GASES = {"CH4": "ch4", "CO": "co"}  # gas -> field in the box line
STATUS_CODE = {"Safe": 0, "Early Warning": 1, "Imminent": 2, "Critical": 3}

# Estimated ppm from the datasheet curves, ppm = A * (Rs/R0)^B, and Rs/R0 in clean air.
# Values are the widely used fits from the MQUnifiedsensor library. NOT calibrated against
# real gas: the dashboard labels every number "estimated, not calibrated".
CURVES = {"CH4": (1012.7, -2.786, 4.4), "CO": (99.042, -1.518, 27.5)}
VC_MV = 5000.0          # MQ module supply
R0_LEARN_SAMPLES = 30   # clean-air readings used to learn each sensor's R0


def parse_line(line: str):
    """Returns a dict for a valid $NX line, else None (bad checksum, debug line, garbage)."""
    line = line.strip()
    if not line.startswith("$NX,") or "*" not in line:
        return None
    body, cs = line[1:].rsplit("*", 1)
    try:
        if reduce(lambda a, c: a ^ ord(c), body, 0) != int(cs, 16):
            return None
        f = body.split(",")
        if len(f) != 11:
            return None
        return {"box": int(f[1]), "seq": int(f[2]), "uptime": int(f[3]),
                "ch4": float(f[4]), "co": float(f[5]), "co_phase": f[6], "co_phase_s": int(f[7]),
                "dist": float(f[8]) if f[8] else None, "alarm": int(f[9]), "muted": f[10] == "1"}
    except ValueError:
        return None


def with_checksum(body: str) -> str:
    return f"${body}*{reduce(lambda a, c: a ^ ord(c), body, 0):02X}"


class Converter:
    """mV at the sensor -> estimated ppm. R0 is learned from the first clean-air readings and saved,
    so the load resistor on the module cancels out. Delete data/r0.json (or POST /api/relearn) to relearn."""

    def __init__(self, path: Path):
        self.path = path
        self.r0 = json.loads(path.read_text()) if path.exists() else {}
        self.samples = collections.defaultdict(list)

    def relearn(self):
        self.r0, self.samples = {}, collections.defaultdict(list)
        self.path.unlink(missing_ok=True)

    def ppm(self, gas: str, mv: float):
        if not 50 < mv < VC_MV:      # sensor unplugged or saturated: no reading
            return None
        rs = (VC_MV - mv) / mv       # Rs / RL
        if gas not in self.r0:
            self.samples[gas].append(rs)
            if len(self.samples[gas]) < R0_LEARN_SAMPLES:
                return None
            a, b, clean_ratio = CURVES[gas]
            self.r0[gas] = sorted(self.samples[gas])[R0_LEARN_SAMPLES // 2] / clean_ratio
            self.path.write_text(json.dumps(self.r0))
        a, b, _ = CURVES[gas]
        return min(a * (rs / self.r0[gas]) ** b, config.GAS_CONFIGS[gas].max_ppm)

    def learning(self):
        return {g: len(self.samples[g]) for g in LIVE_GASES if g not in self.r0}


def gas_view(res, installed=True, **extra):
    if not installed:
        return {"installed": False}
    return {"installed": True, "status": res["status"], "pct": round(res["pct_of_threshold"], 1),
            "ppm_est": round(res["smoothed_value"], 2), "eta": res["eta_label"], "reason": res["reason"],
            "held": res["held"], **extra}


def level_view(lv):
    return lv and {"status": lv["status"], "fill_pct": round(lv["fill_pct"], 1), "dist_cm": lv["raw_value"],
                   "eta": lv["eta_label"], "reason": lv["reason"], "held": lv["held"]}


class Live:
    """The real box: one aggregator for the gases that are actually fitted."""

    def __init__(self, args):
        self.conv = Converter(DATA / "r0.json")
        self.args = args
        self.reset()
        self.db = sqlite3.connect(DATA / "nexdrain.db", check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS readings (ts REAL, source TEXT, line TEXT, site_status TEXT)")

    def reset(self):
        self.agg = MultiGasAggregator({g: config.GAS_CONFIGS[g] for g in LIVE_GASES},
                                      level_monitor=LevelMonitor(self.args.empty_cm, self.args.full_cm))
        # The box reports the MQ-7 heater phase itself (co_phase); turn off the receiver's own clock-based guess.
        self.agg.coordinators["CO"].heater_cycle = None
        self.state, self.last_rx, self.last_seq, self.lines, self.lost = None, None, None, 0, 0
        self.history = collections.deque(maxlen=600)

    def feed(self, line: str, source: str, rssi=None, snr=None):
        p = parse_line(line)
        if p is None:
            return
        now = time.time()
        step = 5 if source == "lora" else 1
        if self.last_seq is not None and p["seq"] > self.last_seq:
            self.lost += max(0, (p["seq"] - self.last_seq) // step - 1)
        self.last_seq, self.last_rx = p["seq"], now
        self.lines += 1

        readings = {"CH4": self.conv.ppm("CH4", p["ch4"]),
                    "CO": None if p["co_phase"] == "H" else self.conv.ppm("CO", p["co"])}
        r = self.agg.process_readings(readings, now, level_cm=p["dist"])
        g = r["gas_results"]
        self.state = {
            "site_status": r["site_status"], "master_status": r["master_status"],
            "multi_gas": r["multi_gas_pattern"],
            "gases": {
                "CH4": gas_view(g["CH4"], mv=p["ch4"]),
                "CO": gas_view(g["CO"], mv=p["co"], phase=p["co_phase"], phase_s=p["co_phase_s"]),
                "H2S": gas_view(None, False), "NH3": gas_view(None, False), "O2": gas_view(None, False),
            },
            "level": level_view(r["level"]),
            "box": {"id": p["box"], "uptime_s": p["uptime"], "alarm": p["alarm"], "muted": p["muted"],
                    "source": source, "rssi": rssi, "snr": snr},
            "learning": self.conv.learning(),
        }
        self.history.append([round(now, 1), g["CH4"]["pct_of_threshold"], g["CO"]["pct_of_threshold"],
                             r["level"]["fill_pct"] if r["level"] else None])
        self.db.execute("INSERT INTO readings VALUES (?,?,?,?)", (now, source, line.strip(), r["site_status"]))
        self.db.commit()

    def view(self):
        age = None if self.last_rx is None else round(time.time() - self.last_rx, 1)
        return {"state": self.state, "age_s": age, "lines": self.lines, "lost": self.lost,
                "history": list(self.history)}


class Sim:
    """Simulation mode: all four gases through the same software, on generated data. Always labelled SIMULATED."""
    SCENARIOS = ["slow_leak", "fast_leak", "sensor_fault", "baseline", "overflow"]
    EMPTY_CM, FULL_CM = 200.0, 25.0

    def __init__(self):
        self.thread, self.stop_flag, self.view_state = None, threading.Event(), {"running": False}
        self.history = collections.deque(maxlen=900)

    def start(self, scenario: str, gas: str, speed: float):
        if scenario not in self.SCENARIOS or gas not in ALL_GASES or not 0.5 <= speed <= 50:
            raise ValueError("bad simulation request")
        self.stop()
        self.stop_flag = threading.Event()
        self.thread = threading.Thread(target=self._run, args=(scenario, gas, speed, self.stop_flag), daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_flag.set()
        if self.thread:
            self.thread.join(timeout=2)
        self.view_state = {**self.view_state, "running": False}

    def _run(self, scenario, gas, speed, stop):
        duration = 600
        series = {g: generate_gas_data(scenario if (g == gas and scenario != "overflow") else "baseline", duration, g)
                  for g in ALL_GASES}
        agg = MultiGasAggregator(config.GAS_CONFIGS, level_monitor=LevelMonitor(self.EMPTY_CM, self.FULL_CM))
        self.history = collections.deque(maxlen=900)
        t0, critical_ticks = time.time(), 0
        for t in range(duration):
            if stop.is_set():
                return
            fill = 30 + (70 * t / 400 if scenario == "overflow" else 0) + 0.5 * math.sin(t / 7)
            dist = self.EMPTY_CM - min(fill, 100) / 100 * (self.EMPTY_CM - self.FULL_CM)
            r = agg.process_readings({g: float(series[g][t]) for g in ALL_GASES}, t0 + t, level_cm=dist)
            res = r["gas_results"]
            self.history.append([t] + [round(res[g]["pct_of_threshold"], 1) for g in ALL_GASES]
                                + [round(r["level"]["fill_pct"], 1)])
            self.view_state = {
                "running": True, "scenario": scenario, "gas": gas, "speed": speed, "t": t, "duration": duration,
                "state": {"site_status": r["site_status"], "master_status": r["master_status"],
                          "multi_gas": r["multi_gas_pattern"],
                          "gases": {**{g: gas_view(res[g]) for g in ALL_GASES}, "O2": gas_view(None, False)},
                          "level": level_view(r["level"])},
            }
            critical_ticks = critical_ticks + 1 if r["site_status"] == "Critical" else 0
            if critical_ticks >= 20:   # leak has played out; stop so the screen holds the result
                break
            stop.wait(1 / speed)
        self.view_state = {**self.view_state, "running": False, "finished": True}

    def view(self):
        return {**self.view_state, "history": list(self.history)}


class App:
    def __init__(self, args):
        self.args, self.lock = args, threading.Lock()
        self.live, self.sim = Live(args), Sim()
        self.ser, self.lora_ok = None, False

    def feed(self, line, source, **kw):
        with self.lock:
            self.live.feed(line, source, **kw)

    def send(self, cmd: str):
        ser = self.ser
        if ser:
            try:
                ser.write((cmd + "\n").encode())
            except Exception:
                pass

    # --- sources ---
    def serial_loop(self):
        import serial
        from serial.tools import list_ports
        while True:
            port = self.args.serial
            if port == "auto":
                found = [p.device for p in list_ports.comports() if p.vid is not None]
                port = found[0] if found else None
            if port:
                try:
                    with serial.Serial(port, 115200, timeout=1) as ser:
                        self.ser = ser
                        print(f"# serial: reading {port}", flush=True)
                        while True:
                            raw = ser.readline()
                            if raw:
                                self.feed(raw.decode(errors="replace"), "usb")
                except Exception as e:   # unplugged, busy, or gone: retry
                    print(f"# serial: {port}: {e}", flush=True)
                finally:
                    self.ser = None
            time.sleep(2)

    def lora_loop(self):
        try:
            from sx1278 import SX1278
            radio = SX1278()
        except Exception as e:
            print(f"# lora: not available ({e})", flush=True)
            return
        self.lora_ok = True
        print("# lora: listening on 433.5 MHz SF9 BW125", flush=True)
        while True:
            pkt = radio.receive()
            if pkt:
                data, rssi, snr = pkt
                self.feed(data.decode(errors="replace"), "lora", rssi=rssi, snr=snr)
            else:
                time.sleep(0.05)

    def stdin_loop(self):
        for line in sys.stdin:
            self.feed(line, "stdin")

    def status_to_box_loop(self):
        """Tell the box the receiver's verdict so its LEDs match the dashboard (firmware brief 5.5)."""
        while True:
            st = self.live.state
            if st and self.live.last_rx and time.time() - self.live.last_rx < 5:
                self.send(f"S{STATUS_CODE[st['site_status']]}")
            time.sleep(2)

    # --- http ---
    def handler(self):
        app = self

        class H(SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=str(DASHBOARD), **kw)

            def log_message(self, *a):
                pass

            def _json(self, obj, code=200):
                body = json.dumps(obj, default=float).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/api/state":
                    with app.lock:
                        live = app.live.view()
                    return self._json({"now": time.time(), "live": live, "sim": app.sim.view(),
                                       "links": {"usb": app.ser is not None, "lora": app.lora_ok}})
                return super().do_GET()

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                if n > 10_000:
                    return self._json({"error": "too large"}, 413)
                try:
                    body = json.loads(self.rfile.read(n) or b"{}")
                    if self.path == "/api/sim/start":
                        app.sim.start(body.get("scenario", "slow_leak"), body.get("gas", "H2S"),
                                      float(body.get("speed", 10)))
                    elif self.path == "/api/sim/stop":
                        app.sim.stop()
                    elif self.path == "/api/box" and body.get("cmd") in ("M", "U", "T"):
                        app.send(body["cmd"])
                    elif self.path == "/api/relearn":
                        with app.lock:
                            app.live.conv.relearn()
                            app.live.reset()
                    else:
                        return self._json({"error": "unknown"}, 404)
                except (ValueError, TypeError) as e:
                    return self._json({"error": str(e)}, 400)
                return self._json({"ok": True})

        return H

    def run(self):
        loops = [self.status_to_box_loop]
        if self.args.serial != "off":
            loops.append(self.serial_loop)
        if self.args.lora:
            loops.append(self.lora_loop)
        if self.args.stdin:
            loops.append(self.stdin_loop)
        for f in loops:
            threading.Thread(target=f, daemon=True).start()
        server = ThreadingHTTPServer((self.args.host, self.args.port), self.handler())
        print(f"# dashboard: http://{self.args.host}:{self.args.port}/", flush=True)
        server.serve_forever()


def main():
    ap = argparse.ArgumentParser(description="NEXDRAIN receiver")
    ap.add_argument("--serial", default="auto", help="auto, off, or a port such as /dev/ttyUSB0 or COM5")
    ap.add_argument("--no-serial", dest="serial", action="store_const", const="off")
    ap.add_argument("--no-lora", dest="lora", action="store_false")
    ap.add_argument("--stdin", action="store_true", help="read box lines from stdin (testing)")
    ap.add_argument("--empty-cm", type=float, default=60.0, help="level sensor reading when the tank is empty")
    ap.add_argument("--full-cm", type=float, default=25.0, help="level sensor reading when the tank is full")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8600)
    args = ap.parse_args()
    DATA.mkdir(exist_ok=True)
    sys.path.insert(0, str(Path(__file__).parent))
    App(args).run()


if __name__ == "__main__":
    main()
