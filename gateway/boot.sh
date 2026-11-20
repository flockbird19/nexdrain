#!/bin/sh
# Runs at every Pi start (user crontab: @reboot). Starts the receiver, then the public view-only link.
# The tunnel needs internet, which can take a while after boot, so it keeps trying for about 5 minutes.
# Log: ~/nexdrain/data/boot.log
cd "$(dirname "$0")/.." || exit 1
exec >> data/boot.log 2>&1
echo "--- boot $(date)"
sleep 15                      # let Wi-Fi and SPI come up
./gateway/run.sh
for i in $(seq 1 36); do      # wait up to 3 min for internet before starting the public link
  curl -s -m 4 -o /dev/null https://api.trycloudflare.com && break
  sleep 5
done
for i in 1 2 3 4 5 6 7 8 9 10; do
  ./gateway/tunnel.sh && exit 0
  sleep 20
done
echo "no public link: no internet on the hotspot? Run gateway/tunnel.sh by hand later"
