#!/bin/bash
# Run N consecutive shifts. Usage: scripts/batch.sh [shifts] [shift_ms]
# Each shift is an independent browser launch (fresh arena draw), telemetry accumulates per shift.
set -u
SHIFTS="${1:-4}"
MS="${2:-900000}"
cd "$(dirname "$0")/.."
echo "batch: $SHIFTS shifts x $((MS / 60000))min, doctrine $(node -e "import('./bot/brain/doctrine.mjs').then(m=>console.log('v'+m.DOCTRINE.version))")"
for i in $(seq 1 "$SHIFTS"); do
  echo "=== shift $i/$SHIFTS ==="
  GAMEMODE=FFA SHIFT_MS="$MS" caffeinate -i node bot/runner.mjs 2>&1 | grep -vE '^\[page\]'
  sleep 5
done
echo "=== batch done ==="
node analysis/summary.mjs | tail -12
