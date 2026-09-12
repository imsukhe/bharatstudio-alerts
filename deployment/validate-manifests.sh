#!/usr/bin/env sh
set -eu

root=${BSA_DEPLOYMENT_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
for file in "$root"/cloud-run/*.yaml "$root"/cloud-tasks/*.yaml; do
  test -f "$file" || exit 1
  grep -q 'RELEASE_DIGEST\|PROJECT\|REGION' "$file" || {
    echo "manifest has no release substitution markers: $file" >&2
    exit 1
  }
done

api_manifest="$root/cloud-run/api.service.yaml"
for required in \
  NODE_ENV \
  HOST \
  APP_ORIGIN \
  DATABASE_URL_APP \
  DATABASE_URL_DIRECT \
  GOOGLE_CLIENT_ID \
  PAYMENT_SERVICE_ORIGIN \
  PAYMENT_SERVICE_AUDIENCE \
  INTERNAL_SERVICE_AUDIENCES \
  NOTIFICATION_TOKEN_ENCRYPTION_KEY \
  PUBLIC_PAYMENT_TURNSTILE_REQUIRED \
  PUBLIC_PAYMENT_TURNSTILE_SECRET
do
  grep -q "name: $required" "$api_manifest" || {
    echo "API manifest is missing the production-required $required binding" >&2
    exit 1
  }
done

api_dockerfile=${BSA_API_DOCKERFILE:-"$root/../apps/api/Dockerfile"}
test -f "$api_dockerfile" || {
  echo 'API Cloud Run manifest has no corresponding Dockerfile' >&2
  exit 1
}
grep -Fq 'CMD ["node", "dist/src/index.js"]' "$api_dockerfile" || {
  echo 'API Dockerfile does not start the compiled API binary' >&2
  exit 1
}
echo 'BSA_DEPLOYMENT_MANIFESTS=PASS'
