# Warm build-server benchmark

The proposed [repeated suspend/resume methodology](METHODOLOGY.md) defines the
next benchmark: every measured changed-image build happens immediately after a
resume and before the following suspension, across multiple cycles on the same
MicroVM. The current scripts and published run below use the earlier
single-resume methodology.

This benchmark measures whether a suspended Lambda MicroVM preserves useful
build state. It runs the workload directly inside disposable MicroVMs so GitHub
queueing and runner-registration time do not contaminate the cache timings.

The workload creates a 500-module TypeScript project and measures:

- a first Docker build, exact cache hits, and builds after a source change;
- npm installs with an empty and then populated npm cache volume;
- full and incremental TypeScript artifact builds;
- warm container start/run/remove time;
- batches of three concurrent Docker builds; and
- exact Docker builds and container starts after suspend/resume.

`orchestrate.py` launches the requested servers, starts the guest workload as a
detached process, polls it over short-lived shell connections, suspends and
resumes every server, retrieves the results, and terminates every server in a
`finally` block. The detached process is necessary because preview shell
connections have a bounded session lifetime.

## Requirements

- Python 3.9 or newer
- AWS CLI with the `lambda-microvms` commands
- `expect` and `websocat`
- an active AWS profile with MicroVM lifecycle and shell-token permissions
- a warm-capable MicroVM image with Docker and Python 3

The image should request a 2,048 MiB minimum and use the same runtime supervisor
as the Action. The guest records the memory actually visible at runtime because
the service can allocate more than the requested minimum.

## Run

```bash
python3 benchmarks/warm-build-server/orchestrate.py \
  --image-arn "$IMAGE_ARN" \
  --image-version "$IMAGE_VERSION" \
  --image-artifact-sha256 "$IMAGE_ARTIFACT_SHA256" \
  --execution-role-arn "$RUNTIME_ROLE_ARN" \
  --log-group "$RUNTIME_LOG_GROUP" \
  --server-count 9 \
  --minimum-server-count 9 \
  --shell-workers 9 \
  --iterations 5 \
  --parallel-batches 2 \
  --output build/benchmark-raw.json

python3 benchmarks/warm-build-server/summarize.py \
  build/benchmark-raw.json \
  --output build/benchmark-summary.json
```

This creates billable resources and consumes regional MicroVM quota. Confirm
that no non-terminated benchmark MicroVM remains if the host process is killed
with an uncatchable signal.

Percentiles use the nearest-rank method. The summary separates the first exact
build after resume from subsequent exact builds because the first call pays a
repeatable page-cache/daemon rewarming penalty even though the Docker layer
cache survives.

## Published run

See the [2026-07-19 report](results/2026-07-19/REPORT.md),
[raw samples](results/2026-07-19/raw.json), and
[generated summary](results/2026-07-19/summary.json).
