# Fresh versus resumed exact-job benchmark

On 22 July 2026, ten fresh Lambda MicroVMs each ran one fixed build job and then
ran that exact job five more times, with a real suspend and resume before every
repeat. All 60 jobs produced the expected output.

The simple result: the complete job had a 16.31 s fresh p50 and a 3.17 s resumed
p50. The unchanged Docker build accounted for most of the difference, with a
12.78 s fresh p50 and a 0.252 s resumed p50.

## Results

| Measured workload            | Fresh p50 | Fresh p90 | Resumed p50 | Resumed p90 |
| ---------------------------- | --------: | --------: | ----------: | ----------: |
| Complete exact job           |   16.31 s |   20.20 s |      3.17 s |      4.34 s |
| Layered Docker build         |   12.78 s |   15.70 s |     0.252 s |     0.311 s |
| `npm ci`                     |    1.36 s |    1.65 s |      1.27 s |      1.81 s |
| Incremental TypeScript build |    1.71 s |    2.29 s |      1.12 s |      1.38 s |

Fresh statistics contain 10 samples. Resumed statistics contain 50 samples: five
repeated observations on each of the same ten servers. Percentiles use the
nearest-rank method.

The resumed complete-job p50 was stable across the five cycles: 3.11 s, 2.99 s,
3.04 s, 3.17 s, and 2.87 s. There was no progressive slowdown in this short run.

Every fresh Docker build reported zero cached BuildKit steps. Every resumed
Docker build reported ten cached steps, and each lane kept the same image ID
through all five suspend/resume cycles.

## What ran

Every sample ran the same three workloads, in order:

1. Build and execute an unchanged, pinned, multi-stage Node 24 Docker image with
   separate manifest, dependency, source, compile, verification, and runtime
   layers.
2. Remove `node_modules`, then run `npm ci` in pinned Node 24 while preserving
   the npm download cache.
3. Build and execute an unchanged 500-module TypeScript project while preserving
   its incremental build state and output artifacts.

The input-tree SHA-256 remained
`3876eb948541701eb9fb44ec5582fda8b28021ef78cfc4d62e4cbb5f14cf716b` for every
job. Each output was checked against the fixed expected value.

The benchmark used harness commit `be798d3` and MicroVM image artifact
`36aebc7fe387f6effcbc2dcd65ff6fcb69522f5fcd6eea2b877ef255cc0c0656` in
`us-east-1`. The requested memory minimum was 2,048 MiB; the guests actually
reported four logical CPUs and 8,406,073,344 bytes of memory, so these results
must not be described as a 2 GiB execution environment. Every guest reported the
`overlay2` Docker storage driver.

Each lane atomically checkpointed its result to a private, run-scoped S3 object
after the fresh job and every resumed job. Uploads began only after the workload
timer stopped. The final JSON was downloaded from S3 rather than transported
through the interactive shell.

## Adversarial reading

- This demonstrates reuse for one exact unchanged job. It does not measure a
  changed source tree, changed dependencies, registry traffic, or cache
  invalidation.
- Docker's fully cached repeat is the dominant result. It would be misleading to
  apply the 50.7× Docker p50 ratio to arbitrary image builds.
- npm did not improve uniformly: resumed p50 was modestly lower, while resumed
  p90 was higher than fresh p90. The evidence does not support a blanket npm
  speedup claim.
- The five resumed observations per server are correlated repeats, not 50
  independent machines. Per-server and per-cycle distributions are retained in
  the generated summary.
- Provision/resume-to-job-complete observations include benchmark script
  transfer and shell polling overhead. They are retained in raw data for audit
  but are not runner-startup performance claims.
- Root free space fell from about 5.62 GB before the first job to about 4.05 GB
  after the sixth. Final Docker data roots were about 1.53 GB. Longer and
  changed-input workloads still need disk-pressure testing.
- The production `vfs` fallback remains a correctness path. These `overlay2`
  timings say nothing about `vfs` performance.

## Reproduction and evidence

- [Frozen methodology](../../METHODOLOGY.md)
- [Benchmark harness](../../README.md)
- [Raw samples](raw.json)
- [Generated summary](summary.json)

The summarizer accepted exactly 10 servers, 10 fresh samples, 50 resumed
samples, six jobs per server, cycles one through five, one input hash, and 60
successful verification flags. After collection, the harness terminated every
MicroVM. The temporary image, S3 bucket, IAM roles, and log groups were then
deleted and the account was checked for remaining non-terminal benchmark
MicroVMs.
