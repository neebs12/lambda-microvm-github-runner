#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT

readonly REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
readonly GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}"
readonly PROJECT_NAME="${PROJECT_NAME:-lambda-microvm-github-runner}"
readonly GITHUB_DEFAULT_BRANCH="${GITHUB_DEFAULT_BRANCH:-main}"
readonly GITHUB_OIDC_SUBJECT="${GITHUB_OIDC_SUBJECT:-repo:${GITHUB_REPOSITORY}:ref:refs/heads/${GITHUB_DEFAULT_BRANCH}}"
readonly LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"
readonly OUTPUT_FILE="${OUTPUT_FILE:-${REPOSITORY_ROOT}/build/aws-setup.json}"

log() {
  echo "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

: "${REGION:?Set AWS_REGION or AWS_DEFAULT_REGION}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY to owner/repository}"

[[ "${GITHUB_REPOSITORY}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] ||
  fail "GITHUB_REPOSITORY must use owner/repository format"
[[ "${PROJECT_NAME}" =~ ^[A-Za-z0-9+=,.@_-]{1,48}$ ]] ||
  fail "PROJECT_NAME contains unsupported characters or is longer than 48 characters"
[[ "${LOG_RETENTION_DAYS}" =~ ^[0-9]+$ ]] ||
  fail "LOG_RETENTION_DAYS must be a positive integer"
((LOG_RETENTION_DAYS > 0)) ||
  fail "LOG_RETENTION_DAYS must be a positive integer"

for command in aws jq mktemp sed tr; do
  command -v "${command}" >/dev/null 2>&1 ||
    fail "Required command is unavailable: ${command}"
done

export AWS_MAX_ATTEMPTS=6
export AWS_RETRY_MODE=standard
export AWS_PAGER=""

identity_json="$(aws sts get-caller-identity --region "${REGION}" --output json)"
readonly identity_json
account_id="$(jq -er '.Account' <<<"${identity_json}")"
readonly account_id
caller_arn="$(jq -er '.Arn' <<<"${identity_json}")"
readonly caller_arn
partition="${caller_arn#arn:}"
partition="${partition%%:*}"
readonly partition

bucket_fragment="$(
  tr '[:upper:]_' '[:lower:]-' <<<"${PROJECT_NAME}" |
    sed -E 's/[^a-z0-9.-]+/-/g; s/^[^a-z0-9]+//; s/[^a-z0-9]+$//'
)"
readonly bucket_fragment
readonly ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-${bucket_fragment}-${account_id}-${REGION}}"
[[ "${ARTIFACT_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
  fail "ARTIFACT_BUCKET is not a valid S3 bucket name"

readonly BUILD_ROLE_NAME="${BUILD_ROLE_NAME:-${PROJECT_NAME}-image-build}"
readonly EXECUTION_ROLE_NAME="${EXECUTION_ROLE_NAME:-${PROJECT_NAME}-runtime}"
readonly GITHUB_ROLE_NAME="${GITHUB_ROLE_NAME:-${PROJECT_NAME}-github-launch}"
readonly BUILD_LOG_GROUP="${BUILD_LOG_GROUP:-/lambda-microvms/${PROJECT_NAME}/build}"
readonly RUNTIME_LOG_GROUP="${RUNTIME_LOG_GROUP:-/lambda-microvms/${PROJECT_NAME}/runtime}"
readonly OIDC_PROVIDER_ARN="arn:${partition}:iam::${account_id}:oidc-provider/token.actions.githubusercontent.com"
readonly BUILD_ROLE_ARN="arn:${partition}:iam::${account_id}:role/${BUILD_ROLE_NAME}"
readonly EXECUTION_ROLE_ARN="arn:${partition}:iam::${account_id}:role/${EXECUTION_ROLE_NAME}"
readonly GITHUB_ROLE_ARN="arn:${partition}:iam::${account_id}:role/${GITHUB_ROLE_NAME}"
readonly IMAGE_RESOURCE_ARN="arn:${partition}:lambda:${REGION}:${account_id}:microvm-image:*"
readonly MICROVM_RESOURCE_ARN="arn:${partition}:lambda:${REGION}:${account_id}:microvm:*"
readonly INTERNET_EGRESS_ARN="arn:${partition}:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
readonly NO_INGRESS_ARN="arn:${partition}:lambda:${REGION}:aws:network-connector:aws-network-connector:NO_INGRESS"

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

create_log_group() {
  local log_group="$1"
  local count
  count="$(
    aws logs describe-log-groups \
      --region "${REGION}" \
      --log-group-name-prefix "${log_group}" \
      --query "length(logGroups[?logGroupName=='${log_group}'])" \
      --output text
  )"
  if [[ "${count}" == "0" ]]; then
    log "Creating CloudWatch log group ${log_group}"
    aws logs create-log-group \
      --region "${REGION}" \
      --log-group-name "${log_group}" \
      --tags "Project=${PROJECT_NAME},ManagedBy=lambda-microvm-github-runner"
  else
    log "Using CloudWatch log group ${log_group}"
  fi
  aws logs put-retention-policy \
    --region "${REGION}" \
    --log-group-name "${log_group}" \
    --retention-in-days "${LOG_RETENTION_DAYS}"
}

upsert_role() {
  local role_name="$1"
  local trust_policy="$2"
  local permissions_policy="$3"
  local description="$4"

  if aws iam get-role --role-name "${role_name}" >/dev/null 2>&1; then
    log "Updating IAM role ${role_name}"
    aws iam update-assume-role-policy \
      --role-name "${role_name}" \
      --policy-document "file://${trust_policy}"
    aws iam tag-role \
      --role-name "${role_name}" \
      --tags \
      "Key=Project,Value=${PROJECT_NAME}" \
      "Key=ManagedBy,Value=lambda-microvm-github-runner"
  else
    log "Creating IAM role ${role_name}"
    aws iam create-role \
      --role-name "${role_name}" \
      --description "${description}" \
      --assume-role-policy-document "file://${trust_policy}" \
      --tags \
      "Key=Project,Value=${PROJECT_NAME}" \
      "Key=ManagedBy,Value=lambda-microvm-github-runner" \
      >/dev/null
  fi

  aws iam put-role-policy \
    --role-name "${role_name}" \
    --policy-name "${PROJECT_NAME}-permissions" \
    --policy-document "file://${permissions_policy}"
  aws iam wait role-exists --role-name "${role_name}"
}

if aws s3api head-bucket --bucket "${ARTIFACT_BUCKET}" >/dev/null 2>&1; then
  log "Using S3 bucket ${ARTIFACT_BUCKET}"
else
  log "Creating S3 bucket ${ARTIFACT_BUCKET}"
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket \
      --region "${REGION}" \
      --bucket "${ARTIFACT_BUCKET}" \
      >/dev/null
  else
    aws s3api create-bucket \
      --region "${REGION}" \
      --bucket "${ARTIFACT_BUCKET}" \
      --create-bucket-configuration "LocationConstraint=${REGION}" \
      >/dev/null
  fi
fi

aws s3api put-public-access-block \
  --region "${REGION}" \
  --bucket "${ARTIFACT_BUCKET}" \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
aws s3api put-bucket-encryption \
  --region "${REGION}" \
  --bucket "${ARTIFACT_BUCKET}" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":false}]}'
aws s3api put-bucket-versioning \
  --region "${REGION}" \
  --bucket "${ARTIFACT_BUCKET}" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-tagging \
  --region "${REGION}" \
  --bucket "${ARTIFACT_BUCKET}" \
  --tagging "TagSet=[{Key=Project,Value=${PROJECT_NAME}},{Key=ManagedBy,Value=lambda-microvm-github-runner}]"

create_log_group "${BUILD_LOG_GROUP}"
create_log_group "${RUNTIME_LOG_GROUP}"

if oidc_json="$(
  aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "${OIDC_PROVIDER_ARN}" \
    --output json 2>/dev/null
)"; then
  log "Using GitHub Actions OIDC provider ${OIDC_PROVIDER_ARN}"
  if ! jq -e '.ClientIDList | index("sts.amazonaws.com")' \
    <<<"${oidc_json}" >/dev/null; then
    aws iam add-client-id-to-open-id-connect-provider \
      --open-id-connect-provider-arn "${OIDC_PROVIDER_ARN}" \
      --client-id sts.amazonaws.com
  fi
else
  log "Creating GitHub Actions OIDC provider"
  aws iam create-open-id-connect-provider \
    --url "https://token.actions.githubusercontent.com" \
    --client-id-list sts.amazonaws.com \
    --tags \
    "Key=Project,Value=${PROJECT_NAME}" \
    "Key=ManagedBy,Value=lambda-microvm-github-runner" \
    >/dev/null
fi

jq -n '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: {Service: "lambda.amazonaws.com"},
    Action: ["sts:AssumeRole", "sts:TagSession"]
  }]
}' >"${temporary_directory}/lambda-trust.json"

jq -n \
  --arg provider "${OIDC_PROVIDER_ARN}" \
  --arg subject "${GITHUB_OIDC_SUBJECT}" \
  '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: {Federated: $provider},
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": $subject
        }
      }
    }]
  }' >"${temporary_directory}/github-trust.json"

jq -n \
  --arg objectArn "arn:${partition}:s3:::${ARTIFACT_BUCKET}/*" \
  --arg logsArn "arn:${partition}:logs:${REGION}:${account_id}:log-group:${BUILD_LOG_GROUP}:*" \
  '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadImageArtifact",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: $objectArn
      },
      {
        Sid: "WriteBuildLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: $logsArn
      }
    ]
  }' >"${temporary_directory}/build-permissions.json"

jq -n \
  --arg logsArn "arn:${partition}:logs:${REGION}:${account_id}:log-group:${RUNTIME_LOG_GROUP}:*" \
  '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "WriteRuntimeLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: $logsArn
      },
      {
        Sid: "TerminateSelf",
        Effect: "Allow",
        Action: "lambda:TerminateMicrovm",
        Resource: "*"
      }
    ]
  }' >"${temporary_directory}/runtime-permissions.json"

jq -n \
  --arg imageArn "${IMAGE_RESOURCE_ARN}" \
  --arg microvmArn "${MICROVM_RESOURCE_ARN}" \
  --arg executionRoleArn "${EXECUTION_ROLE_ARN}" \
  --arg internetEgressArn "${INTERNET_EGRESS_ARN}" \
  --arg noIngressArn "${NO_INGRESS_ARN}" \
  '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ManageRunnerMicrovms",
        Effect: "Allow",
        Action: [
          "lambda:RunMicrovm",
          "lambda:GetMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:GetMicrovmImage"
        ],
        Resource: [$imageArn, $microvmArn]
      },
      {
        Sid: "PassRuntimeRole",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: $executionRoleArn
      },
      {
        Sid: "PassManagedNetworkConnectors",
        Effect: "Allow",
        Action: "lambda:PassNetworkConnector",
        Resource: [$internetEgressArn, $noIngressArn]
      }
    ]
  }' >"${temporary_directory}/github-permissions.json"

upsert_role \
  "${BUILD_ROLE_NAME}" \
  "${temporary_directory}/lambda-trust.json" \
  "${temporary_directory}/build-permissions.json" \
  "Builds the Lambda MicroVM GitHub runner image"
upsert_role \
  "${EXECUTION_ROLE_NAME}" \
  "${temporary_directory}/lambda-trust.json" \
  "${temporary_directory}/runtime-permissions.json" \
  "Runtime permissions for single-use Lambda MicroVM GitHub runners"
upsert_role \
  "${GITHUB_ROLE_NAME}" \
  "${temporary_directory}/github-trust.json" \
  "${temporary_directory}/github-permissions.json" \
  "GitHub OIDC role for launching and terminating runner MicroVMs"

mkdir -p "$(dirname -- "${OUTPUT_FILE}")"
jq -n \
  --arg region "${REGION}" \
  --arg artifactBucket "${ARTIFACT_BUCKET}" \
  --arg buildRoleArn "${BUILD_ROLE_ARN}" \
  --arg executionRoleArn "${EXECUTION_ROLE_ARN}" \
  --arg githubLaunchRoleArn "${GITHUB_ROLE_ARN}" \
  --arg buildLogGroup "${BUILD_LOG_GROUP}" \
  --arg runtimeLogGroup "${RUNTIME_LOG_GROUP}" \
  --arg githubOidcSubject "${GITHUB_OIDC_SUBJECT}" \
  '{
    region: $region,
    artifactBucket: $artifactBucket,
    buildRoleArn: $buildRoleArn,
    executionRoleArn: $executionRoleArn,
    githubLaunchRoleArn: $githubLaunchRoleArn,
    buildLogGroup: $buildLogGroup,
    runtimeLogGroup: $runtimeLogGroup,
    githubOidcSubject: $githubOidcSubject
  }' | tee "${OUTPUT_FILE}"

log "AWS setup saved to ${OUTPUT_FILE}"
