#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

make_fixture() {
  rm -rf "$scratch/deployment" "$scratch/apps"
  mkdir -p "$scratch/deployment/cloud-run" "$scratch/deployment/cloud-tasks" "$scratch/apps/api"
  cp "$repo_root"/deployment/cloud-run/*.yaml "$scratch/deployment/cloud-run/"
  cp "$repo_root"/deployment/cloud-tasks/*.yaml "$scratch/deployment/cloud-tasks/"
  cp "$repo_root/apps/api/Dockerfile" "$scratch/apps/api/Dockerfile"
}

run_validator() {
  BSA_DEPLOYMENT_ROOT="$scratch/deployment" \
    BSA_API_DOCKERFILE="$scratch/apps/api/Dockerfile" \
    sh "$repo_root/deployment/validate-manifests.sh"
}

expect_failure() {
  expected=$1
  if output=$(run_validator 2>&1); then
    echo 'expected manifest validator to reject the mutated fixture' >&2
    exit 1
  fi
  printf '%s\n' "$output" | grep -Fq "$expected" || {
    echo "validator failed for an unexpected reason; expected: $expected" >&2
    printf '%s\n' "$output" >&2
    exit 1
  }
}

make_fixture
run_validator | grep -Fx 'BSA_DEPLOYMENT_MANIFESTS=PASS'

make_fixture
perl -0pi -e 's/name: GOOGLE_CLIENT_ID/name: MISSING_GOOGLE_CLIENT_ID/' "$scratch/deployment/cloud-run/api.service.yaml"
expect_failure 'API manifest is missing the production-required GOOGLE_CLIENT_ID binding'

make_fixture
perl -0pi -e 's/name: DATABASE_URL_DIRECT/name: MISSING_DATABASE_URL_DIRECT/' "$scratch/deployment/cloud-run/api.service.yaml"
expect_failure 'API manifest is missing the production-required DATABASE_URL_DIRECT binding'

make_fixture
perl -0pi -e 's/dist\/src\/index\.js/dist\/src\/server\.js/' "$scratch/apps/api/Dockerfile"
expect_failure 'API Dockerfile does not start the compiled API binary'

make_fixture
for manifest in "$scratch"/deployment/cloud-run/*.yaml "$scratch"/deployment/cloud-tasks/*.yaml; do
  perl -0pi -e 's/RELEASE_DIGEST|PROJECT|REGION/IMMUTABLE_IMAGE_REQUIRED/g' "$manifest"
done
expect_failure 'manifest has no release substitution markers:'

echo 'BSA_DEPLOYMENT_MANIFEST_TESTS=PASS (1 positive, 4 negative)'
