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
  "lambda-microvms list-microvms")
    printf '%s\n' "microvm-teardown"
    ;;
  "lambda-microvms terminate-microvm" | "lambda-microvms delete-microvm-image")
    ;;
  "iam list-access-keys")
    printf '%s\n' "AKIATEARDOWNTEST"
    ;;
  "iam delete-access-key")
    ;;
  "iam list-user-policies")
    printf '%s\n' "runner-quickstart"
    ;;
  "iam delete-user-policy" | "iam delete-user")
    ;;
  "iam list-role-policies")
    printf '%s\n' "runner-permissions"
    ;;
  "iam delete-role-policy" | "iam delete-role")
    ;;
  "s3api list-object-versions")
    if [[ -f "${MOCK_BUCKET_EMPTY}" ]]; then
      jq -n '{}'
    else
      jq -n '{
        Versions: [{Key: "runner/image.zip", VersionId: "v1"}],
        DeleteMarkers: [{Key: "runner/old.zip", VersionId: "v2"}]
      }'
    fi
    ;;
  "s3api delete-objects")
    touch "${MOCK_BUCKET_EMPTY}"
    ;;
  "s3api delete-bucket")
    ;;
  "logs delete-log-group")
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
  "secret delete" | "variable delete")
    ;;
  *)
    echo "Unexpected gh invocation: $*" >&2
    exit 1
    ;;
esac
EOF

chmod 0755 "${temporary_directory}/bin/aws" "${temporary_directory}/bin/gh"

make_files() {
  local directory="$1"
  mkdir -p "${directory}"
  jq -n '{
    projectName: "runner",
    region: "us-east-1",
    artifactBucket: "runner-artifacts",
    buildRoleArn: "arn:aws:iam::123456789012:role/runner-build",
    executionRoleArn: "arn:aws:iam::123456789012:role/runner-runtime",
    githubLaunchRoleArn: "arn:aws:iam::123456789012:role/runner-launch",
    buildLogGroup: "/lambda-microvms/runner/build",
    runtimeLogGroup: "/lambda-microvms/runner/runtime",
    warmStateTable: "runner-warm-state",
    quickstartUserArn: "arn:aws:iam::123456789012:user/runner-quickstart"
  }' >"${directory}/setup.json"
  jq -n '{
    imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
    imageVersion: "1.0"
  }' >"${directory}/image.json"
}

run_teardown() {
  local case_name="$1"
  shift
  local case_directory="${temporary_directory}/${case_name}"
  make_files "${case_directory}"
  export MOCK_AWS_LOG="${case_directory}/aws.log"
  export MOCK_GH_LOG="${case_directory}/gh.log"
  export MOCK_BUCKET_EMPTY="${case_directory}/bucket-empty"
  rm -f "${MOCK_AWS_LOG}" "${MOCK_GH_LOG}" "${MOCK_BUCKET_EMPTY}"

  PATH="${temporary_directory}/bin:${PATH}" \
    AWS_SETUP_FILE="${case_directory}/setup.json" \
    MICROVM_IMAGE_FILE="${case_directory}/image.json" \
    GITHUB_REPOSITORY="owner/repository" \
    "${REPOSITORY_ROOT}/scripts/teardown-quickstart.sh" "$@" \
    >"${case_directory}/stdout.log" \
    2>"${case_directory}/stderr.log"
}

run_teardown "dry-run"
grep -q "Dry run only" "${temporary_directory}/dry-run/stderr.log"
if grep -q "delete-user" "${temporary_directory}/dry-run/aws.log"; then
  exit 1
fi
if [[ -f "${temporary_directory}/dry-run/gh.log" ]] &&
  grep -q "secret delete" "${temporary_directory}/dry-run/gh.log"; then
  exit 1
fi

run_teardown "apply" --yes
grep -q "lambda-microvms terminate-microvm" \
  "${temporary_directory}/apply/aws.log"
grep -q "lambda-microvms delete-microvm-image" \
  "${temporary_directory}/apply/aws.log"
grep -q "dynamodb delete-table.*runner-warm-state" \
  "${temporary_directory}/apply/aws.log"
grep -q "iam delete-user.*runner-quickstart" \
  "${temporary_directory}/apply/aws.log"
grep -q "iam delete-role.*runner-build" \
  "${temporary_directory}/apply/aws.log"
grep -q "iam delete-role.*runner-runtime" \
  "${temporary_directory}/apply/aws.log"
grep -q "iam delete-role.*runner-launch" \
  "${temporary_directory}/apply/aws.log"
grep -q "s3api delete-objects" "${temporary_directory}/apply/aws.log"
grep -q "s3api delete-bucket" "${temporary_directory}/apply/aws.log"
grep -q "logs delete-log-group.*runner/build" \
  "${temporary_directory}/apply/aws.log"
grep -q "logs delete-log-group.*runner/runtime" \
  "${temporary_directory}/apply/aws.log"
grep -q "secret delete AWS_ACCESS_KEY_ID" \
  "${temporary_directory}/apply/gh.log"
grep -q "secret delete GH_PERSONAL_ACCESS_TOKEN" \
  "${temporary_directory}/apply/gh.log"
grep -q "variable delete MICROVM_RUNNER_IMAGE_VERSION" \
  "${temporary_directory}/apply/gh.log"

echo "Quickstart teardown tests passed"
