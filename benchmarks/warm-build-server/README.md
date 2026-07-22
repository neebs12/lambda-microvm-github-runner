# Fresh versus resumed exact-job benchmark

This benchmark compares one fixed build job on a fresh Lambda MicroVM with the
exact same job after that MicroVM suspends and resumes. Read the frozen
[methodology](METHODOLOGY.md) before changing or running it.

The default run launches ten persistent ARM64 MicroVMs. Each server runs one
fresh job, then completes five `suspend → resume → exact same job` cycles. The
result contains exactly 10 fresh samples and 50 resumed samples.

The fixed job times:

- an unchanged, layered multi-stage Node 24 Docker build;
- `npm ci` with `node_modules` removed and the npm download cache preserved;
- an unchanged incremental TypeScript artifact build; and
- the complete job containing all three workloads and their verification.

The workload runs directly inside disposable MicroVMs so GitHub queueing and
runner-registration time do not contaminate the build measurements. The
orchestrator separately records provision/resume-to-job-complete timings.

## Requirements

- Python 3.9 or newer
- AWS CLI with the `lambda-microvms` commands
- `expect` and `websocat`
- an active AWS profile with MicroVM lifecycle and shell-token permissions
- a warm-capable MicroVM image with Docker and Python 3

The image should request a 2,048 MiB minimum and use the same runtime supervisor
as the Action. The guest records the resources actually visible at runtime.

## Run

```bash
python3 benchmarks/warm-build-server/orchestrate.py \
  --image-arn "$IMAGE_ARN" \
  --image-version "$IMAGE_VERSION" \
  --image-artifact-sha256 "$IMAGE_ARTIFACT_SHA256" \
  --execution-role-arn "$RUNTIME_ROLE_ARN" \
  --log-group "$RUNTIME_LOG_GROUP" \
  --server-count 10 \
  --minimum-server-count 10 \
  --shell-workers 10 \
  --cycles 5 \
  --output build/exact-job-benchmark-raw.json

python3 benchmarks/warm-build-server/summarize.py \
  build/exact-job-benchmark-raw.json \
  --output build/exact-job-benchmark-summary.json
```

This creates billable resources and consumes regional MicroVM quota. The
orchestrator terminates every server in a `finally` block, but an uncatchable
host termination still requires a manual check for non-terminal MicroVMs.

The summarizer rejects incomplete runs, changed inputs, missing cycles, and
failed verification. Percentiles use the nearest-rank method. Because cycles on
one server are repeated observations, the output includes per-server and
per-cycle results rather than presenting all 50 samples as independent servers.

## Earlier published run

The [2026-07-19 report](results/2026-07-19/REPORT.md),
[raw samples](results/2026-07-19/raw.json), and
[summary](results/2026-07-19/summary.json) used the earlier single-resume
methodology. They remain historical evidence and must not be mixed into the new
exact-job statistics.
