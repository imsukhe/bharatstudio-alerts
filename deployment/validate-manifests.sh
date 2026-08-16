#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for file in "$root"/cloud-run/*.yaml "$root"/cloud-tasks/*.yaml; do
  test -f "$file" || exit 1
  grep -q 'RELEASE_DIGEST\|PROJECT\|REGION' "$file" || {
    echo "manifest has no release substitution markers: $file" >&2
    exit 1
  }
done
echo 'BSA_DEPLOYMENT_MANIFESTS=PASS'
