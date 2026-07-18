#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly SETUP_FILE="${AWS_SETUP_FILE:-${REPOSITORY_ROOT}/build/aws-setup.json}"
readonly IMAGE_FILE="${MICROVM_IMAGE_FILE:-${REPOSITORY_ROOT}/build/microvm-image.json}"

apply=false

usage() {
  cat >&2 <<'EOF'
Usage: scripts/teardown-quickstart.sh [--yes]

Deletes resources created by scripts/setup-quickstart.sh.

By default this prints the teardown plan only. Pass --yes to delete:
  - repository Actions secrets and variables when GITHUB_REPOSITORY is set
  - the dedicated Quickstart IAM user and its access keys
  - the MicroVM image from build/microvm-image.json
  - project IAM roles
  - artifact bucket objects, delete markers, and bucket
  - DynamoDB warm-state table
  - build/runtime CloudWatch log groups

Environment:
  AWS_SETUP_FILE       Defaults to build/aws-setup.json
  MICROVM_IMAGE_FILE   Defaults to build/microvm-image.json
  GITHUB_REPOSITORY    Optional owner/repository for repo config removal
  PROJECT_NAME         Optional fallback for older setup files
EOF
}

while (($# > 0)); do
  case "$1" in
    --yes)
      apply=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
  shift
done

log() {
  echo "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 ||
    fail "Required command is unavailable: ${command}"
done

[[ -f "${SETUP_FILE}" ]] ||
  fail "AWS setup file does not exist: ${SETUP_FILE}"

export AWS_MAX_ATTEMPTS=6
export AWS_RETRY_MODE=standard
export AWS_PAGER=""

json_string() {
  local expression="$1"
  local file="$2"
  jq -r "${expression} // empty" "${file}"
}

REGION="$(json_string '.region' "${SETUP_FILE}")"
readonly REGION
SETUP_PROJECT_NAME="$(json_string '.projectName' "${SETUP_FILE}" || true)"
readonly SETUP_PROJECT_NAME
readonly project_name="${SETUP_PROJECT_NAME:-${PROJECT_NAME:-lambda-microvm-github-runner}}"

ARTIFACT_BUCKET="$(json_string '.artifactBucket' "${SETUP_FILE}")"
readonly ARTIFACT_BUCKET
BUILD_ROLE_ARN="$(json_string '.buildRoleArn' "${SETUP_FILE}")"
readonly BUILD_ROLE_ARN
EXECUTION_ROLE_ARN="$(json_string '.executionRoleArn' "${SETUP_FILE}")"
readonly EXECUTION_ROLE_ARN
GITHUB_ROLE_ARN="$(json_string '.githubLaunchRoleArn' "${SETUP_FILE}")"
readonly GITHUB_ROLE_ARN
BUILD_LOG_GROUP="$(json_string '.buildLogGroup' "${SETUP_FILE}")"
readonly BUILD_LOG_GROUP
RUNTIME_LOG_GROUP="$(json_string '.runtimeLogGroup' "${SETUP_FILE}")"
readonly RUNTIME_LOG_GROUP
QUICKSTART_USER_ARN="$(json_string '.quickstartUserArn' "${SETUP_FILE}")"
readonly QUICKSTART_USER_ARN
WARM_STATE_TABLE="$(json_string '.warmStateTable' "${SETUP_FILE}")"
readonly WARM_STATE_TABLE

[[ -n "${REGION}" ]] || fail "Setup file is missing region"
[[ -n "${ARTIFACT_BUCKET}" ]] || fail "Setup file is missing artifactBucket"

role_name_from_arn() {
  local arn="$1"
  if [[ -z "${arn}" ]]; then
    return
  fi
  basename "${arn}"
}

user_name_from_arn() {
  local arn="$1"
  if [[ -n "${arn}" ]]; then
    basename "${arn}"
  else
    printf '%s-quickstart' "${project_name}"
  fi
}

image_arn=""
if [[ -f "${IMAGE_FILE}" ]]; then
  image_arn="$(json_string '.imageArn' "${IMAGE_FILE}")"
fi
readonly image_arn

quickstart_user_name="$(user_name_from_arn "${QUICKSTART_USER_ARN}")"
readonly quickstart_user_name
build_role_name="$(role_name_from_arn "${BUILD_ROLE_ARN}")"
readonly build_role_name
execution_role_name="$(role_name_from_arn "${EXECUTION_ROLE_ARN}")"
readonly execution_role_name
github_role_name="$(role_name_from_arn "${GITHUB_ROLE_ARN}")"
readonly github_role_name

run() {
  if [[ "${apply}" == "true" ]]; then
    "$@"
  else
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
  fi
}

delete_github_config() {
  local repository="${GITHUB_REPOSITORY:-}"
  if [[ -z "${repository}" ]]; then
    log "Skipping GitHub repo config removal; GITHUB_REPOSITORY is not set"
    return
  fi
  command -v gh >/dev/null 2>&1 ||
    fail "Required command is unavailable when GITHUB_REPOSITORY is set: gh"
  [[ "${repository}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] ||
    fail "GITHUB_REPOSITORY must use owner/repository format"

  local secret
  for secret in \
    AWS_ACCESS_KEY_ID \
    AWS_SECRET_ACCESS_KEY \
    GH_PERSONAL_ACCESS_TOKEN; do
    run gh secret delete "${secret}" \
      --repo "${repository}" \
      --app actions \
      >/dev/null 2>&1 ||
      true
  done

  local variable
  for variable in \
    MICROVM_AWS_REGION \
    MICROVM_LAUNCH_ROLE_ARN \
    MICROVM_EXECUTION_ROLE_ARN \
    MICROVM_RUNTIME_LOG_GROUP \
    MICROVM_WARM_STATE_TABLE \
    MICROVM_RUNNER_IMAGE_ARN \
    MICROVM_RUNNER_IMAGE_VERSION; do
    run gh variable delete "${variable}" \
      --repo "${repository}" \
      >/dev/null 2>&1 ||
      true
  done
}

terminate_project_microvms() {
  if [[ -z "${image_arn}" ]]; then
    return
  fi
  local microvm_id
  while IFS= read -r microvm_id; do
    [[ -n "${microvm_id}" ]] || continue
    run aws lambda-microvms terminate-microvm \
      --region "${REGION}" \
      --microvm-identifier "${microvm_id}" \
      >/dev/null 2>&1 ||
      true
  done < <(
    aws lambda-microvms list-microvms \
      --region "${REGION}" \
      --query "items[?imageArn=='${image_arn}' && state!='TERMINATED'].microvmId" \
      --output text 2>/dev/null |
      tr '\t' '\n'
  )
}

delete_quickstart_user() {
  [[ -n "${quickstart_user_name}" ]] || return
  local access_key_id
  while IFS= read -r access_key_id; do
    [[ -n "${access_key_id}" ]] || continue
    run aws iam delete-access-key \
      --user-name "${quickstart_user_name}" \
      --access-key-id "${access_key_id}" \
      >/dev/null 2>&1 ||
      true
  done < <(
    aws iam list-access-keys \
      --user-name "${quickstart_user_name}" \
      --query 'AccessKeyMetadata[].AccessKeyId' \
      --output text 2>/dev/null |
      tr '\t' '\n'
  )

  local policy_name
  while IFS= read -r policy_name; do
    [[ -n "${policy_name}" ]] || continue
    run aws iam delete-user-policy \
      --user-name "${quickstart_user_name}" \
      --policy-name "${policy_name}" \
      >/dev/null 2>&1 ||
      true
  done < <(
    aws iam list-user-policies \
      --user-name "${quickstart_user_name}" \
      --query 'PolicyNames[]' \
      --output text 2>/dev/null |
      tr '\t' '\n'
  )

  run aws iam delete-user \
    --user-name "${quickstart_user_name}" \
    >/dev/null 2>&1 ||
    true
}

delete_role() {
  local role_name="$1"
  [[ -n "${role_name}" ]] || return

  local policy_name
  while IFS= read -r policy_name; do
    [[ -n "${policy_name}" ]] || continue
    run aws iam delete-role-policy \
      --role-name "${role_name}" \
      --policy-name "${policy_name}" \
      >/dev/null 2>&1 ||
      true
  done < <(
    aws iam list-role-policies \
      --role-name "${role_name}" \
      --query 'PolicyNames[]' \
      --output text 2>/dev/null |
      tr '\t' '\n'
  )

  run aws iam delete-role \
    --role-name "${role_name}" \
    >/dev/null 2>&1 ||
    true
}

delete_image() {
  [[ -n "${image_arn}" ]] || return
  run aws lambda-microvms delete-microvm-image \
    --region "${REGION}" \
    --image-identifier "${image_arn}" \
    >/dev/null 2>&1 ||
    true
}

delete_bucket() {
  local temporary_directory
  temporary_directory="$(mktemp -d)"
  cleanup_bucket_temp() {
    rm -rf "${temporary_directory}"
  }
  trap cleanup_bucket_temp RETURN

  while true; do
    if ! aws s3api list-object-versions \
      --region "${REGION}" \
      --bucket "${ARTIFACT_BUCKET}" \
      --output json >"${temporary_directory}/versions.json" 2>/dev/null; then
      break
    fi

    jq -c '{
      Objects: (
        ([.Versions[]? | {Key, VersionId}] +
         [.DeleteMarkers[]? | {Key, VersionId}])[:1000]
      ),
      Quiet: true
    }' "${temporary_directory}/versions.json" >"${temporary_directory}/delete.json"

    if [[ "$(jq '.Objects | length' "${temporary_directory}/delete.json")" == "0" ]]; then
      break
    fi

    run aws s3api delete-objects \
      --region "${REGION}" \
      --bucket "${ARTIFACT_BUCKET}" \
      --delete "file://${temporary_directory}/delete.json" \
      >/dev/null 2>&1 ||
      true

    if [[ "${apply}" != "true" ]]; then
      break
    fi
  done

  run aws s3api delete-bucket \
    --region "${REGION}" \
    --bucket "${ARTIFACT_BUCKET}" \
    >/dev/null 2>&1 ||
    true
}

delete_log_group() {
  local log_group="$1"
  [[ -n "${log_group}" ]] || return
  run aws logs delete-log-group \
    --region "${REGION}" \
    --log-group-name "${log_group}" \
    >/dev/null 2>&1 ||
    true
}

delete_warm_state_table() {
  [[ -n "${WARM_STATE_TABLE}" ]] || return
  run aws dynamodb delete-table \
    --region "${REGION}" \
    --table-name "${WARM_STATE_TABLE}" \
    >/dev/null 2>&1 ||
    true
}

log "Quickstart teardown plan"
log "  setup file: ${SETUP_FILE}"
log "  image file: ${IMAGE_FILE}"
log "  region: ${REGION}"
log "  repository: ${GITHUB_REPOSITORY:-<not set; repo config skipped>}"
log "  quickstart user: ${quickstart_user_name}"
log "  microvm image: ${image_arn:-<not found; image deletion skipped>}"
log "  artifact bucket: ${ARTIFACT_BUCKET}"
log "  warm state table: ${WARM_STATE_TABLE:-<none>}"
log "  roles: ${build_role_name:-<none>} ${execution_role_name:-<none>} ${github_role_name:-<none>}"
log "  log groups: ${BUILD_LOG_GROUP:-<none>} ${RUNTIME_LOG_GROUP:-<none>}"

if [[ "${apply}" != "true" ]]; then
  log "Dry run only. Re-run with --yes to delete these resources."
fi

delete_github_config
terminate_project_microvms
delete_image
delete_warm_state_table
delete_quickstart_user
delete_role "${github_role_name}"
delete_role "${build_role_name}"
delete_role "${execution_role_name}"
delete_bucket
delete_log_group "${BUILD_LOG_GROUP}"
delete_log_group "${RUNTIME_LOG_GROUP}"

if [[ "${apply}" == "true" ]]; then
  log "Quickstart teardown complete"
fi
