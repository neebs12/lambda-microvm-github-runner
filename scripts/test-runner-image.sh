#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly IMAGE="${RUNNER_IMAGE_TEST_TAG:-lambda-microvm-github-runner:test}"
readonly FIXTURE_DIR="${REPOSITORY_ROOT}/runner-image/test/fixtures"

for command in curl docker python3 rg; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  }
done

docker build --tag "${IMAGE}" "${REPOSITORY_ROOT}/runner-image"

container_id=""
temporary_directory="$(mktemp -d)"
cleanup() {
  if [[ -n "${container_id}" ]]; then
    docker rm --force "${container_id}" >/dev/null 2>&1 || true
  fi
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

start_container() {
  container_id="$(
    docker run \
      --rm \
      --detach \
      "$@" \
      --publish 127.0.0.1::9000 \
      "${IMAGE}"
  )"
  port="$(docker port "${container_id}" 9000/tcp | sed 's/.*://')"
  for _attempt in $(seq 1 50); do
    if curl --fail --silent "http://127.0.0.1:${port}/healthz" >/dev/null; then
      return
    fi
    sleep 0.2
  done
  echo "Supervisor health check timed out" >&2
  exit 1
}

stop_container() {
  docker rm --force "${container_id}" >/dev/null
  container_id=""
}

hook() {
  local name="$1"
  local body="$2"
  curl \
    --silent \
    --output "${temporary_directory}/${name}.out" \
    --write-out '%{http_code}' \
    --request POST \
    --header 'Content-Type: application/json' \
    --data "${body}" \
    "http://127.0.0.1:${port}${HOOK_PREFIX}/${name}"
}

readonly HOOK_PREFIX="/aws/lambda-microvms/runtime/v1"

start_container
[[ "$(hook ready '{}')" == "200" ]]
docker exec "${container_id}" test ! -S /var/run/docker.sock
stop_container

start_container --privileged
[[ "$(hook validate '{}')" == "503" ]]
for _attempt in $(seq 1 120); do
  validation_status="$(hook validate '{}')"
  [[ "${validation_status}" == "200" ]] && break
  if rg -q 'validation failed' "${temporary_directory}/validate.out"; then
    exit 1
  fi
  sleep 1
done
[[ "${validation_status}" == "200" ]]
[[ "$(docker exec "${container_id}" docker info --format '{{.Driver}}')" == "vfs" ]]
docker exec "${container_id}" \
  docker run --rm public.ecr.aws/docker/library/busybox:1.37.0 true
stop_container

start_container \
  --privileged \
  --env RUNNER_ROOT=/opt/fake-runner \
  --volume "${FIXTURE_DIR}:/opt/fake-runner:ro"
payload="$(
  python3 -c 'import base64,gzip,json; print(json.dumps({"microvmId":"mvm-local-fixture","runHookPayload":base64.b64encode(gzip.compress(b"fake-jit-config")).decode()}))'
)"
[[ "$(hook run "${payload}")" == "200" ]]
[[ "$(hook resume '{}')" == "200" ]]
[[ "$(hook suspend '{}')" == "200" ]]
[[ "$(hook terminate '{}')" == "200" ]]
for _attempt in $(seq 1 50); do
  if ! docker exec "${container_id}" pgrep -x sleep >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if docker exec "${container_id}" pgrep -x sleep >/dev/null 2>&1; then
  echo "Fake runner process survived termination" >&2
  exit 1
fi
if docker exec "${container_id}" docker info >/dev/null 2>&1; then
  echo "Docker daemon survived termination" >&2
  exit 1
fi
docker logs "${container_id}" >"${temporary_directory}/container.log" 2>&1
if rg -q 'fake-jit-config' "${temporary_directory}/container.log"; then
  echo "JIT fixture content appeared in logs" >&2
  exit 1
fi

echo "Runner image smoke tests passed"
