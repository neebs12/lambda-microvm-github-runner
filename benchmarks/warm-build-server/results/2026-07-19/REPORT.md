# Warm build-server benchmark: 2026-07-19

## Result

The persistent build-cache concept worked on all nine tested Lambda MicroVMs. An
unchanged Docker build had a 294.6 ms p50 before suspension and a 283.2 ms p50
after the first post-resume rewarming build. That is respectively 45.12x and
46.94x faster than the 13.295 s first-build p50.

The important qualification is that resume is not completely free. The first
exact build after each resume had a 2.128 s p50; the following 36 builds
returned to a 283.2 ms p50. The disk cache survives suspension, while hot
process and page-cache behavior still needs one request to settle.

## Percentiles

| Measurement                                             |   n |      p50 |      p90 |
| ------------------------------------------------------- | --: | -------: | -------: |
| First Docker build                                      |   9 | 13.295 s | 15.641 s |
| Exact Docker cache hit, before suspend                  |  45 | 294.6 ms | 330.3 ms |
| Docker build after a source change                      |  45 |  1.805 s |  2.368 s |
| First exact Docker build after resume                   |   9 |  2.128 s |  2.870 s |
| Subsequent exact Docker builds after resume             |  36 | 283.2 ms | 327.0 ms |
| npm install, empty cache volume                         |   9 |  1.265 s |  1.531 s |
| npm install, populated cache volume                     |  45 | 884.3 ms |  1.057 s |
| TypeScript full artifact build                          |   9 |  1.649 s |  2.249 s |
| TypeScript incremental artifact build                   |  45 |  1.069 s |  1.261 s |
| Container start/run/remove, before suspend              |  90 | 499.7 ms | 549.0 ms |
| Container start/run/remove, after resume                |  45 | 509.7 ms | 582.2 ms |
| Three concurrent changed-source builds, batch wall time |  18 |  3.034 s |  3.860 s |
| Cold provision to `RUNNING`                             |   9 |  9.885 s | 16.903 s |
| Suspend to `SUSPENDED`                                  |   9 |  2.070 s |  4.144 s |
| Resume to `RUNNING`                                     |   9 |  4.547 s |  7.743 s |

Nearest-rank p90 for a nine-sample measurement is the maximum observation. Raw
values are retained so readers can apply a different percentile convention.

## What the numbers support

- Exact Docker cache hits reduced p50 build time by 97.8% before suspend and
  97.9% after the first post-resume build.
- A changed-source Docker build was 7.37x faster than the first build at p50.
- A populated npm cache reduced install p50 by 30.1%; TypeScript incremental
  state reduced artifact-build p50 by 35.2%.
- All nine servers used `overlay2` before and after resume, retained the built
  image, and returned the expected application output.
- Post-resume container time was within 2.0% of the pre-suspend p50.
- Resume reached the API's `RUNNING` state 2.17x faster than cold provisioning
  at p50. These are control-plane state timings, not end-to-end GitHub job
  pickup timings.
- Three concurrent changed-source builds completed in 3.034 s p50. Compared with
  three times the 1.805 s single-build p50, that is about 1.78x aggregate
  throughput, with the expected per-build slowdown from contention.

Docker data occupied about 1.39 GiB after phase one. Phase two added a median
2.6 MiB to Docker's data root and consumed a median 8.7 MiB of additional root
filesystem space. This short run demonstrates reuse, not long-horizon disk
growth; production pools still need lifetime and free-space admission checks.

## Method

- Region: `us-east-1`
- Servers: nine ARM64 Lambda MicroVMs, run concurrently
- Image resource request: 2,048 MiB minimum
- Guest resources observed: 4 logical CPUs and 8,406,073,344 memory bytes (7.83
  GiB) on every server
- Root filesystem observed: 8,283,189,248 bytes
- Docker storage driver: `overlay2` on all servers before and after resume
- Docker workload: a 500-module TypeScript 6.0.3 project built with Node 24
  Bookworm multi-stage images and a BuildKit npm cache mount
- Repetitions per server: five warm exact, five changed-source, five warm npm,
  five incremental artifact, ten container, two three-build batches, then five
  exact and five container measurements after resume
- Image artifact SHA-256:
  `36aebc7fe387f6effcbc2dcd65ff6fcb69522f5fcd6eea2b877ef255cc0c0656`

The first Docker measurement is the first build of this benchmark context. It
does not claim a cold network pull: the benchmark image can already contain
base-image layers. Container measurements include Docker CLI, create, run,
application execution, and removal. The source mutation adds a file to the
context, invalidating the source-copy and compile portion while retaining
eligible dependency layers.

## Limits

This is one run in one AWS account and Region against a preview service. It is
descriptive evidence, not an SLA or a universal performance claim. It does not
measure GitHub queueing, JIT registration, real monorepos, registry pushes,
cross-account variance, an eight-hour lifetime, or `fuse-overlayfs`/`vfs`
performance. The runtime fallback chain was validated separately; `vfs` remains
a correctness fallback and should not be presented as a high-performance Docker
build-server driver.

The requested 2 GiB value is a minimum image resource request, not a guarantee
that the service exposes exactly 2 GiB. This run observed 7.83 GiB in every
guest, so the results must not be advertised as fixed-2-GiB performance.

## Reproducibility

The exact [raw samples](raw.json), [nearest-rank summary](summary.json), guest
workload, orchestration code, and summarizer are committed beside this report.
AWS identifiers and account numbers were removed from the published raw file;
measurement values are unchanged.
