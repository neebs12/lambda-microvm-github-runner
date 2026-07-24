#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly SETUP_FILE="${AWS_SETUP_FILE:-${REPOSITORY_ROOT}/build/aws-setup.json}"
readonly IMAGE_FILE="${MICROVM_IMAGE_FILE:-${REPOSITORY_ROOT}/build/microvm-image.json}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

for command in gh jq; do
  command -v "${command}" >/dev/null 2>&1 ||
    fail "Required command is unavailable: ${command}"
done

[[ -f "${SETUP_FILE}" ]] ||
  fail "Run scripts/bootstrap-aws.sh first; ${SETUP_FILE} does not exist"
[[ -f "${IMAGE_FILE}" ]] ||
  fail "Run scripts/build-microvm-image.sh first; ${IMAGE_FILE} does not exist"

repository="${GITHUB_REPOSITORY:-}"
if [[ -z "${repository}" ]]; then
  repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi
[[ "${repository}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] ||
  fail "GITHUB_REPOSITORY must use owner/repository format"

set_variable() {
  local name="$1"
  local value="$2"
  [[ -n "${value}" && "${value}" != "null" ]] ||
    fail "Cannot set ${name}: source value is empty"
  gh variable set "${name}" --repo "${repository}" --body "${value}"
  echo "Set ${name}" >&2
}

set_variable \
  MICROVM_AWS_REGION \
  "$(jq -r '.region // empty' "${SETUP_FILE}")"
if [[ "$(jq -r '.githubOidcEnabled // true' "${SETUP_FILE}")" == "true" ]]; then
  set_variable \
    MICROVM_LAUNCH_ROLE_ARN \
    "$(jq -r '.githubLaunchRoleArn // empty' "${SETUP_FILE}")"
fi
set_variable \
  MICROVM_EXECUTION_ROLE_ARN \
  "$(jq -r '.executionRoleArn // empty' "${SETUP_FILE}")"
set_variable \
  MICROVM_RUNTIME_LOG_GROUP \
  "$(jq -r '.runtimeLogGroup // empty' "${SETUP_FILE}")"
set_variable \
  MICROVM_WARM_STATE_TABLE \
  "$(jq -r '.warmStateTable // empty' "${SETUP_FILE}")"
set_variable \
  MICROVM_RUNNER_IMAGE_ARN \
  "$(jq -r '.imageArn // empty' "${IMAGE_FILE}")"
set_variable \
  MICROVM_RUNNER_IMAGE_VERSION \
  "$(jq -r '.imageVersion // empty' "${IMAGE_FILE}")"

if [[ -n "${RUNNER_APP_ID:-}" ]]; then
  set_variable RUNNER_APP_ID "${RUNNER_APP_ID}"
fi

if [[ -n "${RUNNER_APP_PRIVATE_KEY_FILE:-}" ]]; then
  [[ -f "${RUNNER_APP_PRIVATE_KEY_FILE}" ]] ||
    fail "RUNNER_APP_PRIVATE_KEY_FILE does not exist"
  gh secret set RUNNER_APP_PRIVATE_KEY \
    --repo "${repository}" \
    <"${RUNNER_APP_PRIVATE_KEY_FILE}"
  echo "Set RUNNER_APP_PRIVATE_KEY" >&2
fi

echo "Configured GitHub repository ${repository}"
