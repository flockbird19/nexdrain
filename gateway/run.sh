#!/bin/sh
# Start (or restart) the NEXDRAIN receiver on the Pi in the background. Log: ~/nexdrain/data/receiver.log
# Level sensor: pass --empty-cm <reading when empty> once measured at the demo table.
cd "$(dirname "$0")/.." || exit 1
pkill -f "nexdrain/.venv/bin/python gateway/receiver.py" 2>/dev/null
sleep 1
nohup "$PWD/.venv/bin/python" gateway/receiver.py "$@" >> data/receiver.log 2>&1 &
echo "receiver started (pid $!), dashboard on http://$(hostname -I | cut -d' ' -f1):8600/"
