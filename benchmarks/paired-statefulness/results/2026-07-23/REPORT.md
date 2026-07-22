# Fresh versus resumed MicroVM statefulness benchmark

Run ID: `full-20260723-6532e02`

Each workload uses 30 independent MicroVMs. Every MicroVM runs the
workload once fresh, suspends, resumes, and runs the exact workload once
more. Docker is the primary result.

## Results

| Workload | Fresh p50 | Fresh p90 | Resumed p50 | Resumed p90 | Paired median speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| docker | 13.40s | 16.18s | 0.26s | 0.36s | 52.50x |
| npm | 3.67s | 4.42s | 1.93s | 2.17s | 2.19x |
| rails | 56.13s | 56.56s | 0.93s | 1.27s | 56.04x |
| dotnet | 12.80s | 15.88s | 2.53s | 3.10s | 5.56x |

The ratio is fresh duration divided by resumed duration for the same
MicroVM, then the median across the 30 pairs. The report applies no
outlier removal or arbitrary performance threshold. At n=30, p90 is
descriptive rather than a high-confidence tail estimate.

## Docker paired observations

| Lane | Fresh | Resumed | Fresh/resumed |
| --- | ---: | ---: | ---: |
| lane-001 | 11.95s | 0.30s | 40.41x |
| lane-002 | 12.33s | 0.49s | 25.27x |
| lane-003 | 14.79s | 0.27s | 54.77x |
| lane-004 | 11.99s | 0.22s | 53.63x |
| lane-005 | 13.64s | 0.45s | 30.35x |
| lane-006 | 23.07s | 0.32s | 71.83x |
| lane-007 | 16.18s | 0.26s | 62.18x |
| lane-008 | 15.74s | 0.36s | 43.97x |
| lane-009 | 17.34s | 0.35s | 50.21x |
| lane-010 | 14.86s | 0.26s | 57.25x |
| lane-011 | 16.26s | 0.26s | 62.14x |
| lane-012 | 14.41s | 0.28s | 50.66x |
| lane-013 | 14.43s | 0.27s | 54.34x |
| lane-014 | 12.84s | 0.23s | 56.04x |
| lane-015 | 11.15s | 0.23s | 48.65x |
| lane-016 | 12.01s | 0.23s | 52.62x |
| lane-017 | 10.96s | 0.23s | 47.67x |
| lane-018 | 11.38s | 0.24s | 47.42x |
| lane-019 | 12.68s | 0.23s | 55.22x |
| lane-020 | 14.32s | 0.25s | 56.17x |
| lane-021 | 16.01s | 0.31s | 51.71x |
| lane-022 | 13.40s | 0.23s | 58.86x |
| lane-023 | 13.98s | 0.26s | 54.52x |
| lane-024 | 14.76s | 0.28s | 52.44x |
| lane-025 | 15.54s | 0.30s | 52.56x |
| lane-026 | 10.84s | 0.43s | 25.34x |
| lane-027 | 11.12s | 0.32s | 34.72x |
| lane-028 | 10.49s | 0.33s | 31.83x |
| lane-029 | 11.55s | 0.25s | 46.84x |
| lane-030 | 13.04s | 0.24s | 55.18x |

## Interpretation boundaries

- Docker preserves normal BuildKit layers and its base-image state.
- npm removes `node_modules` before each run and preserves only npm's
  normal download cache.
- Bundler preserves installed production gems and normal bundle state.
- .NET preserves its NuGet global packages and normal project restore
  state.
- Container-runtime image pulls for npm, Bundler, and .NET occur during
  untimed setup. Dockerfile base pulls remain part of the Docker build.

See `raw.json` and `summary.json` for every observation and correctness
proof. Lifecycle timing is recorded separately from workload duration.
