# Paired statefulness benchmark implementation

Status: frozen implementation contract for the four-workload AWS run.

This benchmark answers one question only:

> How long does an unchanged workload take on a fresh MicroVM, compared with the
> exact same workload on that same MicroVM after one suspend and resume?

It does not attempt to measure GitHub Actions scheduling, changed-source builds,
exported caches, or repeated warm cycles.

## Required result

Run four independent workload populations:

| Workload                 | Fresh MicroVMs | Matched resumes | Timed command    |
| ------------------------ | -------------: | --------------: | ---------------- |
| Docker image build       |             30 |              30 | `docker build`   |
| npm dependency install   |             30 |              30 | `npm ci`         |
| Rails dependency install |             30 |              30 | `bundle install` |
| .NET dependency restore  |             30 |              30 | `dotnet restore` |

The result therefore contains 120 unique MicroVMs and 240 timed executions.
Every MicroVM belongs to exactly one workload. A Docker MicroVM is never reused
for npm, Bundler, or .NET, and each MicroVM contributes exactly one matched
fresh/resumed pair.

Docker is the primary result. The other three workloads show whether persisted
guest state is useful beyond Docker's layer cache.

## Execution unit and concurrency

A lane is one predeclared workload/sample pair, such as `docker/lane-017`. Its
state machine is:

```text
PLANNED -> LAUNCHED -> FRESH_VERIFIED -> SUSPENDED -> RESUMED
        -> RESUMED_VERIFIED -> TERMINATED
```

Only the workload command is timed. Provisioning, setup, verification, result
upload, suspension, and resumption are recorded separately.

The default wave size is ten lanes, capped at ten non-terminal MicroVMs. Each
workload therefore runs in three waves. Workloads run sequentially, producing 12
waves in total. A command-line override may reduce concurrency, but may not
increase it beyond ten without changing this contract and recording the reason.

## Inputs and normal state

All input archives, scripts, container references, dependency manifests, and
lockfiles are content-addressed in the run manifest before the first MicroVM is
launched. Setup downloads and container-image pulls happen before the workload
timer starts. Network access required by the workload itself remains part of the
timed command.

The fresh run must prove its workload-owned state paths do not exist before it
starts. Nothing clears those paths before the resumed run.

### Docker build

Build the deterministic, layered, multi-stage Node 24/TypeScript image used by
the existing exact-job benchmark. It has a package-manifest stage, BuildKit npm
cache mount, source stage, compile and verification stages, and a slim runtime
stage. The generated source contains 500 TypeScript modules.

- Do not pre-pull the Dockerfile's base images: those pulls are part of a fresh
  Docker build and their resulting state is precisely what this workload tests.
- Use BuildKit, the same tag, Dockerfile, context, and base-image digests twice.
- Do not use `--pull`, `--no-cache`, prune, import, or export.
- Verify the container output, resulting image ID, input-tree hash, and cached
  BuildKit step count.
- A fresh lane must report zero benchmark-created cached steps. The resumed lane
  must produce the same image ID and expected output.

### npm install

Use a frozen production-like Node application manifest with exact direct
versions and a lockfile committed with the harness. It includes HTTP, database,
Redis, authentication, validation, logging, and utility dependencies so the
transitive tree is not a one-package toy.

- Pull the digest-pinned Node 24 runtime image during setup.
- Delete `node_modules` immediately before both timed executions; `npm ci` would
  replace it, and this makes that rule explicit.
- Persist only the normal npm download cache in a workload-owned host path.
- Run identical `npm ci --prefer-offline --no-audit --no-fund` commands.
- Verify `npm ls --all`, the lockfile hash, installed package count, and
  selected direct-package versions.

This measures an empty npm cache versus the cache created by the exact same
install, not a pre-existing `node_modules` no-op.

### Rails Bundler install

Use the production dependency manifests from Mastodon, pinned to commit
`9d51f51cc07aca1dc8e5ddfeadd1b6ed33815f43`. The source archive hash, Ruby
container digest, Ruby version, Bundler version, Gemfile, and lockfile hashes
are frozen into the run manifest.

- Pull the digest-pinned Ruby runtime and prepare required operating-system
  libraries during setup.
- Run in frozen/deployment mode with development and test groups excluded.
- Use the same `bundle install` command and persistent bundle path twice.
- Preserve normal Bundler-installed gems and cache state across suspension.
- Verify `bundle check`, the locked and installed gem counts, Rails version,
  lockfile hash, and selected native-extension loads.

The resumed command may legitimately become mostly a consistency check because
that is normal `bundle install` behavior with the installed bundle intact.

### .NET restore

Use Microsoft's eShop reference application pinned to commit
`9b4f9434f46fdc5c1a6e9e936af2868340cdbc48`. Freeze the source archive hash, SDK
container digest, `global.json`, solution, central package manifest, and any
lockfile hashes in the run manifest.

- Pull the digest-pinned .NET 10 SDK image during setup.
- Use a workload-owned persistent NuGet global-packages directory.
- Run the same `eShop.Web.slnf` restore command twice. This is the repository's
  production web/server solution filter; the full solution also contains MAUI
  mobile tests that require unrelated platform workloads.
- Preserve normal global-package and project `obj` state across suspension.
- Verify restore success, generated assets, resolved package graph hashes, SDK
  version, and selected expected projects/packages.

If the pinned repository does not provide NuGet lockfiles, the harness must not
claim `--locked-mode`; it instead freezes every input manifest and records the
resolved assets hashes.

## Per-lane procedure

For every lane, the orchestrator performs these steps in order:

1. Write the lane's `PLANNED` record to local disk and S3.
2. Launch one MicroVM using the run's unique temporary image and a deterministic
   client token.
3. Immediately persist the returned MicroVM ID locally and to S3.
4. Wait for `RUNNING`, establish shell access, and run untimed setup.
5. Prove the benchmark-owned state is absent and record input/resource facts.
6. Run and time the workload once as `fresh`.
7. Stop the timer, verify the result, and upload the guest result atomically.
8. Have the host download, parse, and validate the fresh result.
9. Suspend the same ID and wait for `SUSPENDED`.
10. Resume that ID and wait for `RUNNING`.
11. Re-establish shell access and prove the input hash and MicroVM ID match.
12. Run and time the identical workload once as `resumed`.
13. Stop the timer, verify, and atomically upload the resumed result.
14. Have the host validate the complete pair, then terminate the MicroVM and
    wait for `TERMINATED`.

The host never treats shell output as benchmark data. The guest writes JSON to a
temporary key and copies it to the final S3 key only after validation. The host
independently downloads the final object before advancing the lifecycle.

## S3 ledger and schemas

S3 is the durable ledger; DynamoDB is unnecessary because there is one
orchestrator and no competing worker lease. The bucket remains private and all
keys are scoped to a unique run ID:

```text
paired-statefulness/runs/<run-id>/
  manifest.json
  events/<monotonic-sequence>-<event-id>.json
  fixtures/<sha256>/<name>
  lanes/<workload>/lane-<001..030>/host.json
  lanes/<workload>/lane-<001..030>/attempts/<attempt>/fresh.json
  lanes/<workload>/lane-<001..030>/attempts/<attempt>/resumed.json
  output/raw.json
  output/summary.json
```

`manifest.json` declares all 120 lanes before execution and contains the fixture
hashes, image identity, requested sample counts, concurrency cap, timestamps,
region, and harness git commit. Each host record includes the client token,
attempt number, MicroVM ID, image ARN/version, control-plane timestamps, last
validated state, result object ETags, error history, and termination status.

Every state transition appends an immutable event object before updating the
convenience host record. This avoids losing history if a process dies while
overwriting a record.

## Crash recovery and retries

The orchestrator supports `run`, `resume-run`, `status`, and `cleanup-run`.
These commands are idempotent for a run ID.

On restart it reads S3, lists MicroVMs, and reconciles by recorded MicroVM ID.
If launch returned but the host died before recording the ID, the unique
temporary image, deterministic client token, run start time, and lane attempt
history bound the orphan search. The orchestrator refuses to guess when more
than one candidate exists; cleanup reports the ambiguity and terminates every
candidate belonging to the run image.

A lane attempt that fails before a validated fresh result may be terminated and
restarted. A failure after fresh validation cannot be replaced only on the
resumed side: the whole pair is discarded, retained as a failed attempt, and a
new MicroVM reruns both fresh and resumed measurements. Published results use
exactly one successful attempt for every predeclared lane and disclose failed
attempt counts. Missing lanes never silently reduce `n`.

All normal exits and exceptions invoke cleanup. `cleanup-run` terminates every
non-terminal MicroVM found in S3 or associated with the unique run image, then
removes the temporary image, logs, role/policy, and other run-owned AWS
resources after final artifacts have been downloaded. Cleanup is verified with
fresh list/get calls rather than assumed from successful API responses.

## Timing and recorded facts

Guest workload durations use a monotonic clock and are stored in milliseconds to
microsecond precision. Verification and S3 upload begin only after the workload
timer stops. Record separately:

- provision-to-running, setup, suspend-to-suspended, suspended dwell,
  resume-to-running, verification, and result-upload durations;
- observed architecture, CPU count, total memory, root-disk usage before and
  after each workload, Docker storage driver, and runner-image identity;
- MicroVM ID and input, dependency, artifact, container-image, and output
  hashes; and
- command exit status and workload-specific correctness evidence.

Fresh and resumed results are invalid if the observed storage driver or input
identity changes within a pair. Results from different drivers are not pooled.

## Validation and report

The validator must reject a run unless it contains:

- exactly 30 successful fresh and 30 successful resumed samples per workload;
- 30 distinct MicroVM IDs per workload and 120 across the whole run;
- the same MicroVM ID on both sides of each pair;
- one observed `SUSPENDED` transition between measurements;
- identical commands and input hashes within every pair;
- successful workload-specific correctness checks; and
- verified termination for every launched MicroVM, including failed attempts.

Publish the complete raw JSON and a generated report. For each side and workload
report count, mean, standard deviation, p50, p90, min, and max. For matched
pairs report the duration difference and fresh/resumed ratio, including the
paired median and a seeded bootstrap 95% confidence interval. P90 at `n = 30` is
explicitly descriptive. No arbitrary pass/fail speed threshold is used, and no
outlier is removed.

The report leads with Docker, shows all 30 paired Docker observations, then npm,
Bundler, and .NET. It states exactly what persisted for each workload so a
near-no-op Bundler or .NET restore is not confused with npm's forced reinstall.

## Delivery gates

Before the full run:

1. Unit-test schemas, percentile/bootstrap calculations, state transitions,
   recovery reconciliation, and validation failures.
2. Run all local fixture/correctness tests.
3. Complete one fresh/resumed AWS pilot lane for each workload.
4. Inspect disk growth and duration; reduce wave concurrency if resource or API
   pressure appears. Never alter the timed command after sampling starts.

After the full run:

1. Re-download every S3 object and regenerate results from raw inputs.
2. Run adversarial mutations proving that missing, duplicated, cross-paired,
   hash-changed, unverified, and unterminated samples are rejected.
3. Verify AWS cleanup and record the empty-resource evidence.
4. Commit fixtures, harness, raw data, generated summary, report, and cleanup
   evidence to the feature branch and update the existing pull request.

The pull request is not merged by this benchmark process.
