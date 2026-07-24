#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPOSITORY_ROOT
temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

mkdir -p "${temporary_directory}/bin"

cat >"${temporary_directory}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"${MOCK_AWS_LOG}"

case "$1 $2" in
  "sts get-caller-identity")
    jq -n '{
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/bootstrap"
    }'
    ;;
  "iam get-user")
    [[ "${MOCK_USER_EXISTS}" == "true" ]]
    ;;
  "iam create-user" | "iam tag-user")
    ;;
  "iam put-user-policy")
    for argument in "$@"; do
      if [[ "${argument}" == file://* ]]; then
        cp "${argument#file://}" "${MOCK_POLICY_CAPTURE}"
      fi
    done
    ;;
  "iam list-access-keys")
    printf '%s\n' "${MOCK_OLD_KEYS}"
    ;;
  "iam create-access-key")
    jq -n \
      --arg id "${MOCK_NEW_ACCESS_KEY_ID}" \
      --arg secret "${MOCK_NEW_SECRET_ACCESS_KEY}" \
      '{AccessKey: {AccessKeyId: $id, SecretAccessKey: $secret}}'
    ;;
  "iam delete-access-key")
    ;;
  *)
    echo "Unexpected aws invocation: $*" >&2
    exit 1
    ;;
esac
EOF

cat >"${temporary_directory}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"${MOCK_GH_LOG}"

case "$1 $2" in
  "secret set")
    secret_input="$(cat)"
    expected="$(
      printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s' \
        "${MOCK_NEW_ACCESS_KEY_ID}" \
        "${MOCK_NEW_SECRET_ACCESS_KEY}"
    )"
    [[ "${secret_input}" == "${expected}" ]]
    ;;
  "variable set")
    ;;
  *)
    echo "Unexpected gh invocation: $*" >&2
    exit 1
    ;;
esac
EOF

chmod 0755 "${temporary_directory}/bin/aws" "${temporary_directory}/bin/gh"

run_case() {
  local case_name="$1"
  local user_exists="$2"
  local old_keys="$3"
  local case_directory="${temporary_directory}/${case_name}"
  mkdir -p "${case_directory}"

  jq -n '{
    region: "us-east-1",
    artifactBucket: "runner-artifacts",
    buildRoleArn: "arn:aws:iam::123456789012:role/runner-build",
    executionRoleArn: "arn:aws:iam::123456789012:role/runner-runtime",
    githubLaunchRoleArn: "arn:aws:iam::123456789012:role/runner-launch",
    buildLogGroup: "/lambda-microvms/runner/build",
    runtimeLogGroup: "/lambda-microvms/runner/runtime",
    warmStateTable: "runner-warm-state"
  }' >"${case_directory}/setup.json"

  export MOCK_AWS_LOG="${case_directory}/aws.log"
  export MOCK_GH_LOG="${case_directory}/gh.log"
  export MOCK_POLICY_CAPTURE="${case_directory}/policy.json"
  export MOCK_USER_EXISTS="${user_exists}"
  export MOCK_OLD_KEYS="${old_keys}"
  export MOCK_NEW_ACCESS_KEY_ID="AKIAQUICKSTARTTEST"
  export MOCK_NEW_SECRET_ACCESS_KEY="quickstart-secret-must-not-leak"

  output="$(
    PATH="${temporary_directory}/bin:${PATH}" \
      AWS_SETUP_FILE="${case_directory}/setup.json" \
      GITHUB_REPOSITORY="owner/repository" \
      PROJECT_NAME="runner" \
      "${REPOSITORY_ROOT}/scripts/configure-quickstart-credentials.sh" 2>&1
  )"

  [[ "${output}" != *"${MOCK_NEW_SECRET_ACCESS_KEY}"* ]]
  jq -e '
    .quickstartUserArn ==
      "arn:aws:iam::123456789012:user/runner-quickstart"
  ' "${case_directory}/setup.json" >/dev/null
  jq -e '
    [.Statement[].Action] | flatten | . as $actions |
    ($actions | index("lambda:*Microvm*")) != null and
    ($actions | index("iam:PassRole")) != null and
    ($actions | index("s3:PutObject")) != null and
    ($actions | index("dynamodb:TransactWriteItems")) != null and
    ($actions | index("iam:CreateRole")) == null and
    ($actions | index("iam:PutRolePolicy")) == null and
    ($actions | index("iam:CreateUser")) == null and
    ($actions | index("iam:CreateAccessKey")) == null and
    ($actions | index("iam:CreateOpenIDConnectProvider")) == null and
    ($actions | index("s3:CreateBucket")) == null and
    ([$actions[] | select(startswith("logs:"))] | length) == 0
  ' "${case_directory}/policy.json" >/dev/null
  grep -q "secret set.*--env-file -" \
    "${case_directory}/gh.log"
}

run_case "create" "false" ""
grep -q "iam create-user" "${temporary_directory}/create/aws.log"

run_case "rotate" "true" "AKIAOLDKEY"
grep -q "iam delete-access-key.*AKIAOLDKEY" \
  "${temporary_directory}/rotate/aws.log"

echo "Quickstart credential tests passed"
