#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly SETUP_FILE="${AWS_SETUP_FILE:-${REPOSITORY_ROOT}/build/aws-setup.json}"
readonly OUTPUT_FILE="${OUTPUT_FILE:-${REPOSITORY_ROOT}/build/microvm-image.json}"

setup_region=""
setup_artifact_bucket=""
setup_build_role_arn=""
setup_build_log_group=""
if [[ -f "${SETUP_FILE}" ]]; then
  command -v jq >/dev/null 2>&1 || {
    echo "Required command is unavailable: jq" >&2
    exit 1
  }
  setup_region="$(jq -r '.region // empty' "${SETUP_FILE}")"
  setup_artifact_bucket="$(jq -r '.artifactBucket // empty' "${SETUP_FILE}")"
  setup_build_role_arn="$(jq -r '.buildRoleArn // empty' "${SETUP_FILE}")"
  setup_build_log_group="$(jq -r '.buildLogGroup // empty' "${SETUP_FILE}")"
fi

readonly REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-${setup_region}}}"
readonly ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-${setup_artifact_bucket}}"
readonly BUILD_ROLE_ARN="${BUILD_ROLE_ARN:-${setup_build_role_arn}}"
readonly BUILD_LOG_GROUP="${BUILD_LOG_GROUP:-${setup_build_log_group}}"
readonly NAME="${IMAGE_NAME:-lambda-microvm-github-runner}"
readonly MEMORY_MIB="${MEMORY_MIB:-4096}"
readonly RETAIN_VERSIONS="${RETAIN_VERSIONS:-5}"
readonly BUILD_TIMEOUT_SECONDS="${BUILD_TIMEOUT_SECONDS:-1800}"
readonly BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1}"
readonly INTERNET_EGRESS="${INTERNET_EGRESS_CONNECTOR_ARN:-arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS}"
artifact_override="${ARTIFACT:-}"
readonly artifact_override
readonly ARTIFACT="${artifact_override:-${REPOSITORY_ROOT}/build/runner-image.zip}"
readonly HOOKS='{
  "port": 9000,
  "microvmImageHooks": {
    "ready": "ENABLED",
    "readyTimeoutInSeconds": 120,
    "validate": "ENABLED",
    "validateTimeoutInSeconds": 300
  },
  "microvmHooks": {
    "run": "ENABLED",
    "runTimeoutInSeconds": 60,
    "resume": "ENABLED",
    "resumeTimeoutInSeconds": 60,
    "suspend": "ENABLED",
    "suspendTimeoutInSeconds": 30,
    "terminate": "ENABLED",
    "terminateTimeoutInSeconds": 30
  }
}'

: "${REGION:?Set AWS_REGION or AWS_DEFAULT_REGION}"
: "${ARTIFACT_BUCKET:?Set ARTIFACT_BUCKET}"
: "${BUILD_ROLE_ARN:?Set BUILD_ROLE_ARN}"

[[ "${NAME}" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || {
  echo "IMAGE_NAME must match [A-Za-z0-9_-] and be at most 64 characters" >&2
  exit 1
}
if ! [[ "${MEMORY_MIB}" =~ ^[0-9]+$ ]] || ((MEMORY_MIB < 1024)); then
  echo "MEMORY_MIB must be an integer of at least 1024" >&2
  exit 1
fi
if ! [[ "${RETAIN_VERSIONS}" =~ ^[0-9]+$ ]] ||
  ((RETAIN_VERSIONS < 1)); then
  echo "RETAIN_VERSIONS must be a positive integer" >&2
  exit 1
fi
if ! [[ "${BUILD_TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] ||
  ((BUILD_TIMEOUT_SECONDS < 300)); then
  echo "BUILD_TIMEOUT_SECONDS must be an integer of at least 300" >&2
  exit 1
fi

for command in aws jq shasum; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  }
done

if [[ -z "${artifact_override}" ]]; then
  "${SCRIPT_DIR}/package-runner-image.sh" "${ARTIFACT}" >/dev/null
elif [[ ! -f "${ARTIFACT}" ]]; then
  echo "ARTIFACT does not exist: ${ARTIFACT}" >&2
  exit 1
fi

ARTIFACT_SHA="$(shasum -a 256 "${ARTIFACT}" | awk '{print $1}')"
readonly ARTIFACT_SHA
readonly ARTIFACT_KEY="${NAME}/${ARTIFACT_SHA}.zip"
readonly CLIENT_TOKEN="image-${ARTIFACT_SHA:0:64}"

export AWS_MAX_ATTEMPTS=6
export AWS_RETRY_MODE=standard
export AWS_PAGER=""

aws s3 cp \
  --region "${REGION}" \
  --only-show-errors \
  "${ARTIFACT}" \
  "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}"

common_arguments=(
  --region "${REGION}"
  --base-image-arn "${BASE_IMAGE_ARN}"
  --build-role-arn "${BUILD_ROLE_ARN}"
  --code-artifact "uri=s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}"
  --description "Single-use GitHub Actions runner"
  --logging "cloudWatch={logGroup=${BUILD_LOG_GROUP:-/lambda-microvms/${NAME}/build}}"
  --egress-network-connectors "[\"${INTERNET_EGRESS}\"]"
  --cpu-configurations '[{"architecture":"ARM_64"}]'
  --resources "[{\"minimumMemoryInMiB\":${MEMORY_MIB}}]"
  --additional-os-capabilities '["ALL"]'
  --hooks "${HOOKS}"
  --client-token "${CLIENT_TOKEN}"
  --cli-connect-timeout 10
  --cli-read-timeout 60
)

image_arn="$(
  aws lambda-microvms list-microvm-images \
    --region "${REGION}" \
    --query "items[?name=='${NAME}'].imageArn | [0]" \
    --output text
)"

if [[ -n "${image_arn}" && "${image_arn}" != "None" ]]; then
  echo "Updating ${image_arn}" >&2
  read -r image_arn image_version < <(
    aws lambda-microvms update-microvm-image \
      --image-identifier "${image_arn}" \
      "${common_arguments[@]}" \
      --query '[imageArn,imageVersion]' \
      --output text
  )
else
  echo "Creating ${NAME}" >&2
  read -r image_arn image_version < <(
    aws lambda-microvms create-microvm-image \
      --name "${NAME}" \
      --tags "Project=${NAME},ManagedBy=lambda-microvm-github-runner" \
      "${common_arguments[@]}" \
      --query '[imageArn,imageVersion]' \
      --output text
  )
fi

if [[ -z "${image_arn}" || "${image_arn}" == "None" ||
  -z "${image_version}" || "${image_version}" == "None" ]]; then
  echo "AWS did not return an image ARN and version" >&2
  exit 1
fi

deadline=$((SECONDS + BUILD_TIMEOUT_SECONDS))
while ((SECONDS < deadline)); do
  read -r state status < <(
    aws lambda-microvms get-microvm-image-version \
      --region "${REGION}" \
      --image-identifier "${image_arn}" \
      --image-version "${image_version}" \
      --query '[state,status]' \
      --output text
  )
  echo "Image version ${image_version}: state=${state} status=${status}" >&2
  case "${state}" in
    SUCCESSFUL)
      break
      ;;
    FAILED | DELETED | DELETE_FAILED)
      echo "Image build failed; inspect ${BUILD_LOG_GROUP:-/lambda-microvms/${NAME}/build}" >&2
      exit 1
      ;;
  esac
  sleep $((3 + RANDOM % 5))
done

if [[ "${state:-}" != "SUCCESSFUL" ]]; then
  echo "Timed out waiting for image version ${image_version}" >&2
  exit 1
fi

aws lambda-microvms update-microvm-image-version \
  --region "${REGION}" \
  --image-identifier "${image_arn}" \
  --image-version "${image_version}" \
  --status ACTIVE \
  >/dev/null

previous_active_versions=()
previous_active_count=0
while IFS= read -r version; do
  previous_active_versions[previous_active_count]="${version}"
  previous_active_count=$((previous_active_count + 1))
done < <(
  aws lambda-microvms list-microvm-image-versions \
    --region "${REGION}" \
    --image-identifier "${image_arn}" \
    --query "items[?status=='ACTIVE' && imageVersion!='${image_version}'].imageVersion" \
    --output text |
    tr '\t' '\n' |
    sed '/^$/d'
)
for ((index = 0; index < previous_active_count; index++)); do
  version="${previous_active_versions[index]}"
  aws lambda-microvms update-microvm-image-version \
    --region "${REGION}" \
    --image-identifier "${image_arn}" \
    --image-version "${version}" \
    --status INACTIVE \
    >/dev/null
done

inactive_versions=()
inactive_count=0
while IFS= read -r version; do
  inactive_versions[inactive_count]="${version}"
  inactive_count=$((inactive_count + 1))
done < <(
  aws lambda-microvms list-microvm-image-versions \
    --region "${REGION}" \
    --image-identifier "${image_arn}" \
    --query "items[?status=='INACTIVE' && state=='SUCCESSFUL'].imageVersion" \
    --output text |
    tr '\t' '\n' |
    sed '/^$/d' |
    sort -Vr
)
for ((index = RETAIN_VERSIONS - 1; index < inactive_count; index++)); do
  aws lambda-microvms delete-microvm-image-version \
    --region "${REGION}" \
    --image-identifier "${image_arn}" \
    --image-version "${inactive_versions[index]}" \
    >/dev/null
done

mkdir -p "$(dirname -- "${OUTPUT_FILE}")"
jq -n \
  --arg imageArn "${image_arn}" \
  --arg imageVersion "${image_version}" \
  --arg region "${REGION}" \
  --arg artifactSha256 "${ARTIFACT_SHA}" \
  '{
    imageArn: $imageArn,
    imageVersion: $imageVersion,
    region: $region,
    artifactSha256: $artifactSha256
  }' | tee "${OUTPUT_FILE}"

echo "MicroVM image details saved to ${OUTPUT_FILE}" >&2
