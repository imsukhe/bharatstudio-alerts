#!/usr/bin/env sh
# Local-only Step 0.25 gate. Does not deploy, contact providers, or use secrets.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec python3 "$ROOT/scripts/measurement/run_local_measurement.py" "$@"
