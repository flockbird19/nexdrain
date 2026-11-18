# NEXDRAIN: early warning for toxic gas in sewage tanks

Workers who enter sewage and septic tanks die when the air turns toxic and nobody has checked it. NEXDRAIN is a sensor box mounted just under the lid of each tank. It reads gas levels and sewage level, sends them by LoRa radio to one receiver per site, and the receiver warns **while a gas is still rising**, before it reaches the danger level, instead of only once it is already there.

This repository holds the software. It started as an undergraduate research project at RNS Institute of Technology, Bengaluru.

## How it works

```
Sensor box in the tank (ESP32, gas sensors, ultrasonic level sensor, buzzer)
        |  LoRa radio
        v
Receiver on site (Raspberry Pi): runs the detection software below
        v
Dashboard and alerts
```

The detection software is **statistical trend detection, not machine learning**. For each gas it:

1. rejects implausible jumps and dropouts from faulty sensors,
2. smooths the reading with a moving median,
3. tracks how fast it is rising, using EWMA and CUSUM with limits that adapt to each sensor's own noise,
4. requires several readings in a row to agree before raising or lowering a status,
5. reports one of Safe, Early Warning, Imminent or Critical, plus a time-to-danger range such as "3 to 5 min".

A reading at or above the danger level is Critical immediately, with no delay. If two or more gases rise together, the overall status goes up one step. Sewage level has its own plain thresholds (70, 85 and 95% full). A missing reading, such as a lost radio packet or the CO sensor's heater phase, holds the last state instead of being treated as zero.

Danger levels used: H2S 10 ppm, CO 35 ppm, methane 5,000 ppm (10% of its lower explosive limit), NH3 25 ppm (`src/config.py`).

## Status

- **Detection software:** built and tested, **on simulated data only**. In 100 random runs per gas and scenario (960,000 simulated readings) it raised no false alarms, never flip-flopped on a real leak, and gave about 7 minutes of warning on a slow leak. The true time to danger fell inside the reported range in 96 to 100% of runs.
- **Not yet validated on real sensors.** Calibration constants are placeholders, and there is no humidity, temperature or cross-sensitivity correction yet.
- **Not in this repository yet:** ESP32 firmware, the LoRa receiver and the dashboard.

## Run it

Requires Python 3.14 and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
python tests/test_pipeline.py            # unit checks
python tests/test_level.py               # level monitor and missing readings
python tests/test_detection_quality.py   # quality metrics, including the time-to-danger range
python tests/stress_sweep.py 100         # randomized sweep across all gases and scenarios (slow)
python src/main.py                       # live simulated demo in the terminal
```

## Layout

| Path | What it is |
|---|---|
| `src/config.py` | Every threshold and tuning constant, with the reason for each |
| `src/pipeline/coordinator.py` | Per-gas pipeline: fault rejection, smoothing, trend, confirmation |
| `src/pipeline/trend.py` | EWMA and CUSUM trend detection with noise-adaptive limits |
| `src/pipeline/eta.py` | Time-to-danger range (linear and exponential fits) |
| `src/pipeline/level.py` | Sewage level monitor |
| `src/pipeline/aggregator.py` | Combines all gases and the level into one site status |
| `src/generator/synthetic_gas_data.py` | Simulated sensor data used by the tests |
| `tests/` | Unit tests, quality metrics and stress sweeps |

## Safety note

NEXDRAIN is designed to support, not replace, the mandatory confined-space entry procedure: ventilation, a certified gas test before entry, and a trained attendant.
