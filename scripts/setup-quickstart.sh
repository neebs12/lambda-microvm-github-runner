#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

log() {
  echo "$*" >&2
}

: "${AWS_REGION:=${AWS_DEFAULT_REGION:-}}"
: "${AWS_REGION:?Set AWS_REGION or AWS_DEFAULT_REGION}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY to owner/repository}"
readonly ENABLE_GITHUB_OIDC=false
export AWS_REGION GITHUB_REPOSITORY ENABLE_GITHUB_OIDC

"${SCRIPT_DIR}/bootstrap-aws.sh"
"${SCRIPT_DIR}/build-microvm-image.sh"
"${SCRIPT_DIR}/configure-github.sh"
"${SCRIPT_DIR}/configure-quickstart-credentials.sh"

if [[ -n "${GH_PERSONAL_ACCESS_TOKEN:-}" ]]; then
  printf '%s' "${GH_PERSONAL_ACCESS_TOKEN}" |
  gh secret set GH_PERSONAL_ACCESS_TOKEN \
      --repo "${GITHUB_REPOSITORY}" \
      --app actions
  unset GH_PERSONAL_ACCESS_TOKEN
else
  log "Paste a classic GitHub PAT with the repo scope when prompted."
  gh secret set GH_PERSONAL_ACCESS_TOKEN \
    --repo "${GITHUB_REPOSITORY}" \
    --app actions
fi

log "Quickstart setup complete for ${GITHUB_REPOSITORY}"
