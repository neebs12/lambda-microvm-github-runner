#!/usr/bin/env python3
"""Run repeatable warm-build benchmarks inside a Lambda MicroVM."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path("/tmp/lmvm-warm-build-benchmark")
CONTEXT = ROOT / "context"
RESULT = ROOT / "result.json"
LOGS = ROOT / "logs"

PACKAGE_JSON = {
    "name": "lambda-microvm-warm-build-benchmark",
    "version": "1.0.0",
    "private": True,
    "scripts": {"build": "tsc -p tsconfig.json"},
    "devDependencies": {"typescript": "6.0.3"},
}

PACKAGE_LOCK = {
    "name": "lambda-microvm-warm-build-benchmark",
    "version": "1.0.0",
    "lockfileVersion": 3,
    "requires": True,
    "packages": {
        "": {
            "name": "lambda-microvm-warm-build-benchmark",
            "version": "1.0.0",
            "devDependencies": {"typescript": "6.0.3"},
        },
        "node_modules/typescript": {
            "version": "6.0.3",
            "resolved": "https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz",
            "integrity": "sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==",
            "dev": True,
            "license": "Apache-2.0",
            "bin": {"tsc": "bin/tsc", "tsserver": "bin/tsserver"},
            "engines": {"node": ">=14.17"},
        },
    },
}

TSCONFIG = {
    "compilerOptions": {
        "target": "ES2022",
        "module": "CommonJS",
        "strict": True,
        "incremental": True,
        "tsBuildInfoFile": ".cache/tsconfig.tsbuildinfo",
        "rootDir": "src",
        "outDir": "dist",
    },
    "include": ["src/**/*.ts"],
}

DOCKERFILE = """\
# syntax=docker/dockerfile:1
FROM public.ecr.aws/docker/library/node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=lmvm-benchmark-npm,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM public.ecr.aws/docker/library/node:24-bookworm-slim
COPY --from=build /app/dist /app/dist
CMD ["node", "/app/dist/index.js"]
"""


def run(
    command: list[str],
    *,
    log_name: str,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    LOGS.mkdir(parents=True, exist_ok=True)
    log_path = LOGS / f"{log_name}.log"
    started = time.perf_counter_ns()
    result = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    log_path.write_text(result.stdout, encoding="utf-8")
    if result.returncode != 0:
        tail = "\n".join(result.stdout.splitlines()[-40:])
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n{tail}"
        )
    result.elapsed_ms = round(elapsed_ms, 3)  # type: ignore[attr-defined]
    if not capture:
        result.stdout = ""
    return result


def elapsed(result: subprocess.CompletedProcess[str]) -> float:
    return result.elapsed_ms  # type: ignore[attr-defined,no-any-return]


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def create_context() -> None:
    shutil.rmtree(ROOT, ignore_errors=True)
    (CONTEXT / "src").mkdir(parents=True)
    LOGS.mkdir(parents=True)
    write_json(CONTEXT / "package.json", PACKAGE_JSON)
    write_json(CONTEXT / "package-lock.json", PACKAGE_LOCK)
    write_json(CONTEXT / "tsconfig.json", TSCONFIG)
    (CONTEXT / "Dockerfile").write_text(DOCKERFILE, encoding="utf-8")
    (CONTEXT / ".dockerignore").write_text(
        "node_modules\ndist\n.cache\n", encoding="utf-8"
    )

    imports: list[str] = []
    terms: list[str] = []
    for index in range(500):
        module = f"module{index:03d}"
        (CONTEXT / "src" / f"{module}.ts").write_text(
            f"export const {module}: number = {index};\n",
            encoding="utf-8",
        )
        imports.append(f'import {{ {module} }} from "./{module}";')
        terms.append(module)
    (CONTEXT / "src" / "index.ts").write_text(
        "\n".join(imports)
        + "\n"
        + f"console.log({'+'.join(terms)});\n",
        encoding="utf-8",
    )


def docker_build(
    context: Path, tag: str, log_name: str
) -> subprocess.CompletedProcess[str]:
    return run(
        [
            "docker",
            "build",
            "--progress=plain",
            "--tag",
            tag,
            str(context),
        ],
        log_name=log_name,
    )


def mutate_source(context: Path, token: str) -> None:
    path = context / "src" / "mutation.ts"
    path.write_text(
        f'export const mutation = "{token}";\n', encoding="utf-8"
    )


def disk_metadata() -> dict[str, int]:
    usage = shutil.disk_usage("/")
    docker_bytes = int(
        subprocess.run(
            ["du", "-sb", "/var/lib/docker"],
            text=True,
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.split()[0]
    )
    return {
        "root_total_bytes": usage.total,
        "root_used_bytes": usage.used,
        "root_free_bytes": usage.free,
        "docker_data_root_bytes": docker_bytes,
    }


def phase_one(server_id: str, iterations: int, parallel_batches: int) -> None:
    create_context()
    tag = f"lmvm-warm-benchmark:{server_id}"
    samples: dict[str, list[float]] = {
        "docker_cold_build_ms": [],
        "docker_warm_exact_build_ms": [],
        "docker_changed_source_build_ms": [],
        "npm_cold_install_ms": [],
        "npm_warm_install_ms": [],
        "typescript_cold_artifact_build_ms": [],
        "typescript_incremental_artifact_build_ms": [],
        "warm_container_start_ms": [],
        "parallel_three_build_individual_ms": [],
        "parallel_three_build_batch_ms": [],
        "post_resume_exact_build_ms": [],
        "post_resume_container_start_ms": [],
    }

    samples["docker_cold_build_ms"].append(
        elapsed(docker_build(CONTEXT, tag, "docker-cold"))
    )
    verification = run(
        ["docker", "run", "--rm", tag],
        log_name="docker-cold-run",
        capture=True,
    ).stdout.strip()
    if verification != "124750":
        raise RuntimeError(f"unexpected application result: {verification}")

    for index in range(iterations):
        samples["docker_warm_exact_build_ms"].append(
            elapsed(docker_build(CONTEXT, tag, f"docker-exact-{index}"))
        )

    for index in range(iterations):
        mutate_source(CONTEXT, f"changed-{server_id}-{index}")
        samples["docker_changed_source_build_ms"].append(
            elapsed(docker_build(CONTEXT, tag, f"docker-changed-{index}"))
        )

    volume = f"lmvm-benchmark-npm-{server_id}"
    run(["docker", "volume", "rm", "--force", volume], log_name="npm-volume-rm")
    run(["docker", "volume", "create", volume], log_name="npm-volume-create")

    def npm_install(log_name: str) -> float:
        shutil.rmtree(CONTEXT / "node_modules", ignore_errors=True)
        result = run(
            [
                "docker",
                "run",
                "--rm",
                "--volume",
                f"{volume}:/root/.npm",
                "--volume",
                f"{CONTEXT}:/work",
                "--workdir",
                "/work",
                "public.ecr.aws/docker/library/node:24-bookworm",
                "npm",
                "ci",
                "--prefer-offline",
                "--no-audit",
                "--no-fund",
            ],
            log_name=log_name,
        )
        return elapsed(result)

    samples["npm_cold_install_ms"].append(npm_install("npm-cold"))
    for index in range(iterations):
        samples["npm_warm_install_ms"].append(
            npm_install(f"npm-warm-{index}")
        )

    shutil.rmtree(CONTEXT / "dist", ignore_errors=True)
    shutil.rmtree(CONTEXT / ".cache", ignore_errors=True)

    def artifact_build(log_name: str) -> float:
        result = run(
            [
                "docker",
                "run",
                "--rm",
                "--volume",
                f"{CONTEXT}:/work",
                "--workdir",
                "/work",
                "public.ecr.aws/docker/library/node:24-bookworm",
                "npm",
                "run",
                "build",
            ],
            log_name=log_name,
        )
        return elapsed(result)

    samples["typescript_cold_artifact_build_ms"].append(
        artifact_build("artifact-cold")
    )
    for index in range(iterations):
        mutate_source(CONTEXT, f"artifact-{server_id}-{index}")
        samples["typescript_incremental_artifact_build_ms"].append(
            artifact_build(f"artifact-incremental-{index}")
        )

    for index in range(iterations * 2):
        samples["warm_container_start_ms"].append(
            elapsed(
                run(
                    ["docker", "run", "--rm", tag],
                    log_name=f"container-start-{index}",
                )
            )
        )

    parallel_root = ROOT / "parallel"
    parallel_root.mkdir()
    contexts: list[Path] = []
    for lane in range(3):
        lane_context = parallel_root / f"lane-{lane}"
        shutil.copytree(
            CONTEXT,
            lane_context,
            ignore=shutil.ignore_patterns("node_modules", "dist", ".cache"),
        )
        contexts.append(lane_context)

    for batch in range(parallel_batches):
        for lane, lane_context in enumerate(contexts):
            mutate_source(lane_context, f"parallel-{server_id}-{batch}-{lane}")
        batch_started = time.perf_counter_ns()
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = [
                executor.submit(
                    docker_build,
                    lane_context,
                    f"lmvm-warm-parallel:{server_id}-{batch}-{lane}",
                    f"parallel-{batch}-{lane}",
                )
                for lane, lane_context in enumerate(contexts)
            ]
            for future in futures:
                samples["parallel_three_build_individual_ms"].append(
                    elapsed(future.result())
                )
        samples["parallel_three_build_batch_ms"].append(
            round((time.perf_counter_ns() - batch_started) / 1_000_000, 3)
        )

    result: dict[str, Any] = {
        "schema_version": 1,
        "server_id": server_id,
        "metadata": {
            "storage_driver": subprocess.run(
                ["docker", "info", "--format", "{{.Driver}}"],
                text=True,
                stdout=subprocess.PIPE,
                check=True,
            ).stdout.strip(),
            "architecture": os.uname().machine,
            "logical_cpus_visible": os.cpu_count(),
            "memory_total_bytes": int(
                Path("/proc/meminfo")
                .read_text(encoding="utf-8")
                .split("MemTotal:", 1)[1]
                .split("kB", 1)[0]
                .strip()
            )
            * 1024,
            "node_image": "public.ecr.aws/docker/library/node:24-bookworm",
            "typescript_version": "6.0.3",
            "source_module_count": 500,
            "warm_iterations": iterations,
            "parallel_batches": parallel_batches,
            "phase_one_completed_at_unix_ms": time.time_ns() // 1_000_000,
        },
        "samples": samples,
        "disk_after_phase_one": disk_metadata(),
    }
    write_json(RESULT, result)
    print("BENCHMARK_PHASE1_COMPLETE", flush=True)


def phase_two() -> None:
    result = json.loads(RESULT.read_text(encoding="utf-8"))
    server_id = result["server_id"]
    tag = f"lmvm-warm-benchmark:{server_id}"
    samples = result["samples"]

    run(
        ["docker", "image", "inspect", tag],
        log_name="post-resume-image-inspect",
    )
    verification = run(
        ["docker", "run", "--rm", tag],
        log_name="post-resume-run",
        capture=True,
    ).stdout.strip()
    if verification != "124750":
        raise RuntimeError(f"post-resume application result: {verification}")

    iterations = int(result["metadata"]["warm_iterations"])
    for index in range(iterations):
        samples["post_resume_exact_build_ms"].append(
            elapsed(
                docker_build(
                    CONTEXT, tag, f"post-resume-exact-{index}"
                )
            )
        )
        samples["post_resume_container_start_ms"].append(
            elapsed(
                run(
                    ["docker", "run", "--rm", tag],
                    log_name=f"post-resume-container-{index}",
                )
            )
        )

    result["metadata"]["post_resume_storage_driver"] = subprocess.run(
        ["docker", "info", "--format", "{{.Driver}}"],
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    ).stdout.strip()
    result["metadata"]["phase_two_completed_at_unix_ms"] = (
        time.time_ns() // 1_000_000
    )
    result["disk_after_phase_two"] = disk_metadata()
    write_json(RESULT, result)
    print("BENCHMARK_PHASE2_COMPLETE", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("phase1", "phase2"))
    parser.add_argument("--server-id", default="server")
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--parallel-batches", type=int, default=3)
    args = parser.parse_args()
    if args.phase == "phase1":
        phase_one(args.server_id, args.iterations, args.parallel_batches)
    else:
        phase_two()


if __name__ == "__main__":
    main()
