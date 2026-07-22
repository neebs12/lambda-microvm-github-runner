# Paired MicroVM statefulness benchmark

This benchmark measures one simple comparison: an unchanged workload on a fresh
Lambda MicroVM versus that exact workload on the same MicroVM after it suspends
and resumes once.

Four workloads use completely separate MicroVM populations:

- a layered multi-stage Docker image build;
- `npm ci` for a frozen production-like API dependency tree;
- `bundle install` for Mastodon's pinned production Rails dependencies; and
- `dotnet restore` for Microsoft's pinned eShop production web/server solution.

Each published workload has 30 fresh measurements and 30 matched resumed
measurements from the same 30 MicroVM IDs. No MicroVM crosses workloads.

## Published result

The [2026-07-23 report](results/2026-07-23/REPORT.md) contains the headline
statistics and all 30 Docker pairs. The complete
[raw data](results/2026-07-23/raw.json) and generated
[summary](results/2026-07-23/summary.json) are published for independent
inspection. The [cleanup evidence](results/2026-07-23/cleanup.json) records the
independent audit of all 120 IDs and removal of the temporary AWS resources. The
[adversarial results](results/2026-07-23/adversarial.json) show the real dataset
passing while 11 deliberately corrupted variants are rejected.

| Workload             | Fresh p50 | Resumed p50 | Paired median fresh/resumed ratio |
| -------------------- | --------: | ----------: | --------------------------------: |
| Docker build         |   13.40 s |     0.262 s |                            52.50x |
| npm ci               |    3.67 s |      1.93 s |                             2.19x |
| Rails bundle install |   56.13 s |     0.934 s |                            56.04x |
| .NET restore         |   12.80 s |      2.53 s |                             5.56x |

The image requested a 2,048 MiB minimum. AWS exposed 8,406,073,344 bytes of
memory, four logical CPUs, an 8,283,189,248-byte root filesystem, and the
`overlay2` Docker driver to every measured guest. The report uses observed
resources rather than presenting the requested minimum as the allocation.

## Reproduce

Read the frozen [implementation contract](IMPLEMENTATION.md) first. The harness
requires Python 3.9 or newer, AWS CLI support for `lambda-microvms`, `expect`,
`websocat`, a private S3 bucket, a runtime role scoped to the run prefix, and a
warm-capable ARM64 MicroVM image.

```bash
python3 benchmarks/paired-statefulness/orchestrate.py \
  --image-arn "$IMAGE_ARN" \
  --image-version "$IMAGE_VERSION" \
  --execution-role-arn "$RUNTIME_ROLE_ARN" \
  --log-group "$RUNTIME_LOG_GROUP" \
  --bucket "$PRIVATE_RESULT_BUCKET" \
  --sample-count 30 \
  --wave-size 10 \
  --workloads docker npm rails dotnet \
  --output build/paired-statefulness

python3 benchmarks/paired-statefulness/summarize.py \
  build/paired-statefulness/<run-id>/raw.json \
  --summary build/paired-statefulness/<run-id>/summary.json \
  --report build/paired-statefulness/<run-id>/REPORT.md
```

The orchestrator caps a wave at ten live MicroVMs. It writes each verified fresh
and resumed result to a lane-specific S3 key before changing lifecycle state. A
failed resumed attempt never gets paired with another VM's fresh result; the
complete pair must be rerun.

This benchmark creates billable resources. Verify every launched ID is
`TERMINATED` and remove the temporary image, IAM additions, logs, and S3 bucket
after downloading the result artifacts.
