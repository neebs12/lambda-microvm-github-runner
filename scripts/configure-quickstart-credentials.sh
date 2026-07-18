#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly SETUP_FILE="${AWS_SETUP_FILE:-${REPOSITORY_ROOT}/build/aws-setup.json}"
readonly PROJECT_NAME="${PROJECT_NAME:-lambda-microvm-github-runner}"
readonly USER_NAME="${QUICKSTART_IAM_USER_NAME:-${PROJECT_NAME}-quickstart}"
readonly POLICY_NAME="${QUICKSTART_IAM_POLICY_NAME:-${PROJECT_NAME}-quickstart}"

log() {
  echo "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command in aws gh jq mktemp tr; do
  command -v "${command}" >/dev/null 2>&1 ||
    fail "Required command is unavailable: ${command}"
done

[[ -f "${SETUP_FILE}" ]] ||
  fail "Run scripts/bootstrap-aws.sh first; ${SETUP_FILE} does not exist"
[[ "${USER_NAME}" =~ ^[A-Za-z0-9+=,.@_-]{1,64}$ ]] ||
  fail "QUICKSTART_IAM_USER_NAME is invalid"
[[ "${POLICY_NAME}" =~ ^[A-Za-z0-9+=,.@_-]{1,128}$ ]] ||
  fail "QUICKSTART_IAM_POLICY_NAME is invalid"

repository="${GITHUB_REPOSITORY:-}"
if [[ -z "${repository}" ]]; then
  repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi
[[ "${repository}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] ||
  fail "GITHUB_REPOSITORY must use owner/repository format"

REGION="$(jq -er '.region' "${SETUP_FILE}")"
readonly REGION
ARTIFACT_BUCKET="$(jq -er '.artifactBucket' "${SETUP_FILE}")"
readonly ARTIFACT_BUCKET
BUILD_ROLE_ARN="$(jq -er '.buildRoleArn' "${SETUP_FILE}")"
readonly BUILD_ROLE_ARN
EXECUTION_ROLE_ARN="$(jq -er '.executionRoleArn' "${SETUP_FILE}")"
readonly EXECUTION_ROLE_ARN
WARM_STATE_TABLE="$(jq -er '.warmStateTable' "${SETUP_FILE}")"
readonly WARM_STATE_TABLE

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

readonly USER_ARN="arn:${partition}:iam::${account_id}:user/${USER_NAME}"
readonly BUCKET_ARN="arn:${partition}:s3:::${ARTIFACT_BUCKET}"
readonly INTERNET_EGRESS_ARN="arn:${partition}:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
readonly NO_INGRESS_ARN="arn:${partition}:lambda:${REGION}:aws:network-connector:aws-network-connector:NO_INGRESS"
readonly ALL_INGRESS_ARN="arn:${partition}:lambda:${REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS"
readonly WARM_STATE_TABLE_ARN="arn:${partition}:dynamodb:${REGION}:${account_id}:table/${WARM_STATE_TABLE}"

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

jq -n \
  --arg bucketArn "${BUCKET_ARN}" \
  --arg buildRoleArn "${BUILD_ROLE_ARN}" \
  --arg executionRoleArn "${EXECUTION_ROLE_ARN}" \
  --arg internetEgressArn "${INTERNET_EGRESS_ARN}" \
  --arg noIngressArn "${NO_INGRESS_ARN}" \
  --arg allIngressArn "${ALL_INGRESS_ARN}" \
  --arg stateTableArn "${WARM_STATE_TABLE_ARN}" \
  '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "IdentifyAccount",
        Effect: "Allow",
        Action: "sts:GetCallerIdentity",
        Resource: "*"
      },
      {
        Sid: "UseArtifactBucket",
        Effect: "Allow",
        Action: [
          "s3:GetBucketLocation",
          "s3:ListBucket"
        ],
        Resource: $bucketArn
      },
      {
        Sid: "ManageImageArtifacts",
        Effect: "Allow",
        Action: [
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject"
        ],
        Resource: ($bucketArn + "/*")
      },
      {
        Sid: "PassProjectRoles",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: [$buildRoleArn, $executionRoleArn]
      },
      {
        Sid: "ManageLambdaMicrovms",
        Effect: "Allow",
        Action: [
          "lambda:*Microvm*",
          "lambda:ListTags",
          "lambda:TagResource",
          "lambda:UntagResource"
        ],
        Resource: "*"
      },
      {
        Sid: "PassManagedNetworkConnectors",
        Effect: "Allow",
        Action: "lambda:PassNetworkConnector",
        Resource: [$internetEgressArn, $noIngressArn, $allIngressArn]
      },
      {
        Sid: "ManageWarmPoolState",
        Effect: "Allow",
        Action: [
          "dynamodb:DescribeTable",
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:TransactWriteItems"
        ],
        Resource: $stateTableArn
      }
    ]
  }' >"${temporary_directory}/quickstart-policy.json"

if aws iam get-user --user-name "${USER_NAME}" >/dev/null 2>&1; then
  log "Updating IAM user ${USER_NAME}"
  aws iam tag-user \
    --user-name "${USER_NAME}" \
    --tags \
    "Key=Project,Value=${PROJECT_NAME}" \
    "Key=ManagedBy,Value=lambda-microvm-github-runner"
else
  log "Creating IAM user ${USER_NAME}"
  aws iam create-user \
    --user-name "${USER_NAME}" \
    --tags \
    "Key=Project,Value=${PROJECT_NAME}" \
    "Key=ManagedBy,Value=lambda-microvm-github-runner" \
    >/dev/null
fi

aws iam put-user-policy \
  --user-name "${USER_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "file://${temporary_directory}/quickstart-policy.json"

old_access_keys=()
old_access_key_count=0
while IFS= read -r access_key_id; do
  if [[ -n "${access_key_id}" ]]; then
    old_access_keys[old_access_key_count]="${access_key_id}"
    old_access_key_count=$((old_access_key_count + 1))
  fi
done < <(
  aws iam list-access-keys \
    --user-name "${USER_NAME}" \
    --query 'AccessKeyMetadata[].AccessKeyId' \
    --output text |
    tr '\t' '\n'
)

old_access_key_start=0
if ((old_access_key_count >= 2)); then
  log "Removing the oldest access key before rotation"
  aws iam delete-access-key \
    --user-name "${USER_NAME}" \
    --access-key-id "${old_access_keys[0]}"
  old_access_key_start=1
fi

new_access_key_json="$(aws iam create-access-key --user-name "${USER_NAME}")"
new_access_key_id="$(jq -er '.AccessKey.AccessKeyId' <<<"${new_access_key_json}")"
new_secret_access_key="$(
  jq -er '.AccessKey.SecretAccessKey' <<<"${new_access_key_json}"
)"
unset new_access_key_json

if ! printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' \
  "${new_access_key_id}" \
  "${new_secret_access_key}" |
  gh secret set --repo "${repository}" --app actions --env-file -; then
  aws iam delete-access-key \
    --user-name "${USER_NAME}" \
    --access-key-id "${new_access_key_id}" ||
    true
  fail "GitHub secret update failed; the new AWS access key was revoked"
fi

for ((
  index = old_access_key_start;
  index < old_access_key_count;
  index++
)); do
  aws iam delete-access-key \
    --user-name "${USER_NAME}" \
    --access-key-id "${old_access_keys[index]}"
done

unset new_secret_access_key
gh variable set MICROVM_AWS_REGION \
  --repo "${repository}" \
  --body "${REGION}"

jq --arg quickstartUserArn "${USER_ARN}" \
  '. + {quickstartUserArn: $quickstartUserArn}' \
  "${SETUP_FILE}" >"${temporary_directory}/aws-setup.json"
mv "${temporary_directory}/aws-setup.json" "${SETUP_FILE}"

log "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for ${repository}"
log "Quickstart IAM user: ${USER_ARN}"
