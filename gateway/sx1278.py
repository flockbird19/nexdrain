"""Receive-only SX1278 (Ra-02) driver for the Raspberry Pi, over spidev. Polls the IRQ register,
so DIO0 does not have to be read. Settings must match the ESP32 (firmware brief, section 5.8):
433.5 MHz, SF9, BW 125 kHz, CR 4/5, sync word 0x12, explicit header, CRC on.

Wiring: NSS on CE0 (pin 24), RST on GPIO 22 (pin 15). See NEXDRAIN_Wiring_Sheet.md, section 9.
"""
import time

import spidev

FREQ_HZ, SF, SYNC_WORD = 433.5e6, 9, 0x12
RST_GPIO = 22


class SX1278:
    def __init__(self, bus=0, cs=0):
        self.crc_errors = 0
        self._reset()
        self.spi = spidev.SpiDev()
        self.spi.open(bus, cs)
        self.spi.max_speed_hz = 1_000_000
        self.spi.mode = 0
        version = self.read(0x42)
        if version != 0x12:
            self.spi.close()
            raise RuntimeError(f"no SX1278 found (version register 0x{version:02X}, expected 0x12)")
        self.write(0x01, 0x80)                      # sleep + LoRa mode
        frf = int(FREQ_HZ * 2**19 / 32e6)
        self.write(0x06, frf >> 16); self.write(0x07, (frf >> 8) & 0xFF); self.write(0x08, frf & 0xFF)
        self.write(0x0F, 0x00)                      # FIFO RX base address
        self.write(0x0C, self.read(0x0C) | 0x03)    # LNA boost
        self.write(0x1D, 0x72)                      # BW 125 kHz, CR 4/5, explicit header
        self.write(0x1E, (SF << 4) | 0x04)          # SF9, RX payload CRC on
        self.write(0x26, 0x04)                      # AGC auto (low data rate optimise not needed at SF9/125k)
        self.write(0x39, SYNC_WORD)
        self.write(0x01, 0x85)                      # continuous receive

    @staticmethod
    def _reset():
        try:
            import gpiod
            from gpiod.line import Direction, Value
            with gpiod.request_lines("/dev/gpiochip0", consumer="nexdrain",
                                     config={RST_GPIO: gpiod.LineSettings(direction=Direction.OUTPUT,
                                                                           output_value=Value.INACTIVE)}) as req:
                time.sleep(0.01)
                req.set_value(RST_GPIO, Value.ACTIVE)
                time.sleep(0.01)
        except Exception:
            pass  # ponytail: the Ra-02 RST pin has its own pull-up, so a missed reset only matters after a hang

    def read(self, reg):
        return self.spi.xfer2([reg & 0x7F, 0])[1]

    def write(self, reg, val):
        self.spi.xfer2([reg | 0x80, val])

    def receive(self):
        """Returns (payload bytes, rssi dBm, snr dB) for a good packet, or None."""
        flags = self.read(0x12)
        if not flags & 0x40:                        # RxDone
            return None
        self.write(0x12, 0xFF)                      # clear IRQs
        if flags & 0x20:                            # CRC error: drop it
            self.crc_errors += 1
            return None
        n = self.read(0x13)
        self.write(0x0D, self.read(0x10))           # FIFO pointer to start of this packet
        data = bytes(self.read(0x00) for _ in range(n))
        snr = ((self.read(0x19) ^ 0x80) - 0x80) / 4  # signed
        rssi = self.read(0x1A) - 164                # low-frequency port
        return data, rssi, snr
