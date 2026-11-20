#!/bin/sh
# Public VIEW-ONLY link to the dashboard through a free Cloudflare quick tunnel (no account).
# The address changes every start; the dashboard's Share button shows its QR. Requests that come in
# through the tunnel are refused for every control (receiver.py, do_POST), so judges can only watch.
# Needs internet on the hotspot. Stop it with: pkill -f "bin/cloudflared tunnel"
cd "$(dirname "$0")/.." || exit 1
pkill -f "bin/cloudflared tunnel" 2>/dev/null
sleep 1
: > data/tunnel.log
nohup bin/cloudflared tunnel --no-autoupdate --url http://localhost:8600 >> data/tunnel.log 2>&1 &
for i in $(seq 1 30); do
  url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' data/tunnel.log | tail -1)
  [ -n "$url" ] && echo "public view-only link: $url" && exit 0
  sleep 1
done
echo "no link yet: check internet, then see data/tunnel.log"
