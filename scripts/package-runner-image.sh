#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly SOURCE_DIR="${REPOSITORY_ROOT}/runner-image"
readonly OUTPUT="${1:-${REPOSITORY_ROOT}/build/runner-image.zip}"

for command in cp mktemp touch zip; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  }
done

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

cp "${SOURCE_DIR}/Dockerfile" "${temporary_directory}/Dockerfile"
cp "${SOURCE_DIR}/supervisor.py" "${temporary_directory}/supervisor.py"

# Fixed metadata makes the artifact reproducible across clean checkouts.
touch -t 202601010000 \
  "${temporary_directory}/Dockerfile" \
  "${temporary_directory}/supervisor.py"
mkdir -p "$(dirname -- "${OUTPUT}")"
rm -f "${OUTPUT}"
(
  cd "${temporary_directory}"
  zip -X -q "${OUTPUT}" Dockerfile supervisor.py
)

echo "${OUTPUT}"
shasum -a 256 "${OUTPUT}"
