#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--jitconfig" || -z "${2:-}" ]]; then
  exit 2
fi

# Keep the fake child alive until the terminate hook exercises supervision.
exec sleep 300
