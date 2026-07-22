#!/usr/bin/env python3
"""Run the fresh-versus-resumed exact-job benchmark inside a MicroVM."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path("/tmp/lmvm-exact-job-benchmark")
CONTEXT = ROOT / "context"
NPM_CACHE = ROOT / "npm-cache"
RESULT = ROOT / "result.json"
LOGS = ROOT / "logs"
EXPECTED_OUTPUT = "124750"
MODULE_COUNT = 500
NODE_IMAGE = (
    "public.ecr.aws/docker/library/node:24-bookworm@"
    "sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059"
)
NODE_SLIM_IMAGE = (
    "public.ecr.aws/docker/library/node:24-bookworm-slim@"
    "sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
)

PACKAGE_JSON = {
    "name": "lambda-microvm-exact-job-benchmark",
    "version": "1.0.0",
    "private": True,
    "scripts": {"build": "tsc -p tsconfig.json"},
    "devDependencies": {"typescript": "6.0.3"},
}

PACKAGE_LOCK = {
    "name": "lambda-microvm-exact-job-benchmark",
    "version": "1.0.0",
    "lockfileVersion": 3,
    "requires": True,
    "packages": {
        "": {
            "name": "lambda-microvm-exact-job-benchmark",
            "version": "1.0.0",
            "devDependencies": {"typescript": "6.0.3"},
        },
        "node_modules/typescript": {
            "version": "6.0.3",
            "resolved": (
                "https://registry.npmjs.org/typescript/-/"
                "typescript-6.0.3.tgz"
            ),
            "integrity": (
                "sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/"
                "CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw=="
            ),
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

DOCKERFILE = f"""\
FROM {NODE_IMAGE} AS manifest
WORKDIR /app
COPY package.json package-lock.json ./

FROM manifest AS dependencies
RUN --mount=type=cache,id=lmvm-exact-job-npm,target=/root/.npm \\
    npm ci --no-audit --no-fund

FROM dependencies AS source
COPY tsconfig.json ./
COPY src ./src

FROM source AS compile
RUN npm run build

FROM compile AS verification
RUN test "$(node dist/index.js)" = "{EXPECTED_OUTPUT}"

FROM {NODE_SLIM_IMAGE} AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /app/dist && chown -R node:node /app

FROM runtime-base AS runtime
COPY --chown=node:node --from=verification /app/dist ./dist
LABEL org.opencontainers.image.title="Lambda MicroVM exact-job benchmark"
LABEL org.opencontainers.image.description="Deterministic layered cache workload"
USER node
CMD ["node", "/app/dist/index.js"]
"""


def write_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def run(
    command: list[str],
    *,
    log_name: str,
    capture: bool = False,
    environment: dict[str, str] | None = None,
) -> tuple[subprocess.CompletedProcess[str], float]:
    LOGS.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter_ns()
    result = subprocess.run(
        command,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    (LOGS / f"{log_name}.log").write_text(
        result.stdout, encoding="utf-8"
    )
    if result.returncode != 0:
        tail = "\n".join(result.stdout.splitlines()[-60:])
        raise RuntimeError(
            f"command failed ({result.returncode}): "
            f"{' '.join(command)}\n{tail}"
        )
    if not capture:
        result.stdout = ""
    return result, round(elapsed_ms, 3)


def create_context() -> None:
    if ROOT.exists():
        raise RuntimeError(f"fresh benchmark state already exists: {ROOT}")
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
    for index in range(MODULE_COUNT):
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


def input_tree_hash() -> str:
    digest = hashlib.sha256()
    ignored = {"node_modules", "dist", ".cache"}
    paths = sorted(
        path
        for path in CONTEXT.rglob("*")
        if path.is_file() and not ignored.intersection(path.parts)
    )
    for path in paths:
        relative = path.relative_to(CONTEXT).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def root_disk() -> dict[str, int]:
    usage = shutil.disk_usage("/")
    return {
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
    }


def observed_resources() -> dict[str, Any]:
    meminfo = Path("/proc/meminfo")
    if meminfo.is_file():
        memory_bytes = int(
            meminfo.read_text(encoding="utf-8")
            .split("MemTotal:", 1)[1]
            .split("kB", 1)[0]
            .strip()
        ) * 1024
    else:
        memory_bytes = int(
            subprocess.run(
                ["sysctl", "-n", "hw.memsize"],
                text=True,
                stdout=subprocess.PIPE,
                check=True,
            ).stdout.strip()
        )
    return {
        "architecture": os.uname().machine,
        "logical_cpus": os.cpu_count(),
        "memory_total_bytes": memory_bytes,
        "root_filesystem": root_disk(),
    }


def docker_build(server_id: str, label: str) -> dict[str, Any]:
    tag = f"lmvm-exact-job:{server_id}"
    iidfile = ROOT / "docker-image.id"
    iidfile.unlink(missing_ok=True)
    environment = os.environ.copy()
    environment["DOCKER_BUILDKIT"] = "1"
    result, elapsed_ms = run(
        [
            "docker",
            "build",
            "--progress=plain",
            "--iidfile",
            str(iidfile),
            "--tag",
            tag,
            str(CONTEXT),
        ],
        log_name=f"{label}-docker-build",
        capture=True,
        environment=environment,
    )
    if not iidfile.is_file():
        raise RuntimeError("docker build did not produce an image ID")
    cached_steps = sum(
        1 for line in result.stdout.splitlines() if " CACHED" in line
    )
    verification, verification_ms = run(
        ["docker", "run", "--rm", tag],
        log_name=f"{label}-docker-verify",
        capture=True,
    )
    output = verification.stdout.strip()
    if output != EXPECTED_OUTPUT:
        raise RuntimeError(f"unexpected Docker output: {output!r}")
    return {
        "build_ms": elapsed_ms,
        "verification_ms": verification_ms,
        "image_id": iidfile.read_text(encoding="utf-8").strip(),
        "buildkit_cached_steps": cached_steps,
        "output": output,
    }


def npm_install(label: str) -> dict[str, Any]:
    shutil.rmtree(CONTEXT / "node_modules", ignore_errors=True)
    NPM_CACHE.mkdir(parents=True, exist_ok=True)
    _, elapsed_ms = run(
        [
            "docker",
            "run",
            "--rm",
            "--volume",
            f"{NPM_CACHE}:/root/.npm",
            "--volume",
            f"{CONTEXT}:/work",
            "--workdir",
            "/work",
            NODE_IMAGE,
            "sh",
            "-lc",
            "npm ci --prefer-offline --no-audit --no-fund && npm ls --all",
        ],
        log_name=f"{label}-npm-ci",
    )
    package_path = CONTEXT / "node_modules" / "typescript" / "package.json"
    if not package_path.is_file():
        raise RuntimeError("npm verification did not find TypeScript")
    package = json.loads(package_path.read_text(encoding="utf-8"))
    if package.get("version") != "6.0.3":
        raise RuntimeError(f"unexpected TypeScript package: {package}")
    return {"install_ms": elapsed_ms, "typescript_version": "6.0.3"}


def typescript_build(label: str) -> dict[str, Any]:
    _, elapsed_ms = run(
        [
            "docker",
            "run",
            "--rm",
            "--volume",
            f"{CONTEXT}:/work",
            "--workdir",
            "/work",
            NODE_IMAGE,
            "sh",
            "-lc",
            (
                "npm run build && "
                f'test "$(node dist/index.js)" = "{EXPECTED_OUTPUT}"'
            ),
        ],
        log_name=f"{label}-typescript-build",
    )
    artifact = CONTEXT / "dist" / "index.js"
    build_info = CONTEXT / ".cache" / "tsconfig.tsbuildinfo"
    if not artifact.is_file() or not build_info.is_file():
        raise RuntimeError("TypeScript build did not preserve its artifacts")
    return {
        "build_ms": elapsed_ms,
        "artifact_sha256": file_hash(artifact),
        "build_info_sha256": file_hash(build_info),
        "output": EXPECTED_OUTPUT,
    }


def load_result() -> dict[str, Any]:
    if not RESULT.is_file():
        raise RuntimeError("benchmark result does not exist")
    return json.loads(RESULT.read_text(encoding="utf-8"))


def execute_job(server_id: str, kind: str, cycle: int) -> None:
    if kind == "fresh":
        if cycle != 0:
            raise RuntimeError("fresh job must use cycle zero")
        create_context()
        source_hash = input_tree_hash()
        result: dict[str, Any] = {
            "schema_version": 2,
            "server_id": server_id,
            "input_tree_sha256": source_hash,
            "expected_output": EXPECTED_OUTPUT,
            "metadata": {
                "source_module_count": MODULE_COUNT,
                "node_image": NODE_IMAGE,
                "node_slim_image": NODE_SLIM_IMAGE,
                "typescript_version": "6.0.3",
                "resources": observed_resources(),
                "disk_before_fresh_job": root_disk(),
            },
            "jobs": [],
        }
    else:
        if kind != "resumed" or cycle < 1:
            raise RuntimeError(f"invalid job kind/cycle: {kind}/{cycle}")
        result = load_result()
        expected_cycle = len(result["jobs"])
        if cycle != expected_cycle:
            raise RuntimeError(
                f"expected resumed cycle {expected_cycle}, received {cycle}"
            )
        source_hash = input_tree_hash()
        if source_hash != result["input_tree_sha256"]:
            raise RuntimeError("benchmark input tree changed between jobs")

    label = f"cycle-{cycle:02d}-{kind}"
    job_started_at_unix_ms = time.time_ns() // 1_000_000
    job_started = time.perf_counter_ns()
    docker = docker_build(server_id, label)
    npm = npm_install(label)
    typescript = typescript_build(label)
    total_ms = round(
        (time.perf_counter_ns() - job_started) / 1_000_000, 3
    )
    source_hash_after = input_tree_hash()
    if source_hash_after != source_hash:
        raise RuntimeError("fixed benchmark input changed during the job")

    result["jobs"].append(
        {
            "kind": kind,
            "cycle": cycle,
            "input_tree_sha256": source_hash,
            "started_at_unix_ms": job_started_at_unix_ms,
            "completed_at_unix_ms": time.time_ns() // 1_000_000,
            "timings": {
                "docker_build_ms": docker["build_ms"],
                "docker_verification_ms": docker["verification_ms"],
                "npm_install_ms": npm["install_ms"],
                "typescript_build_ms": typescript["build_ms"],
                "job_total_ms": total_ms,
            },
            "docker": docker,
            "npm": npm,
            "typescript": typescript,
            "root_filesystem_after_job": root_disk(),
            "verified": True,
        }
    )
    write_json(RESULT, result)
    print(f"BENCHMARK_JOB_COMPLETE kind={kind} cycle={cycle}", flush=True)


def diagnostic() -> None:
    result = load_result()
    docker_driver, _ = run(
        ["docker", "info", "--format", "{{.Driver}}"],
        log_name="final-docker-driver",
        capture=True,
    )
    docker_root = Path("/var/lib/docker")
    docker_bytes: int | None = None
    if docker_root.is_dir():
        size = subprocess.run(
            ["du", "-sk", str(docker_root)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if size.returncode != 0:
            raise RuntimeError(
                f"failed to size Docker data root: {size.stderr}"
            )
        docker_bytes = int(size.stdout.split()[0]) * 1024
    result["metadata"]["final_diagnostic"] = {
        "docker_storage_driver": docker_driver.stdout.strip(),
        "docker_data_root_bytes": docker_bytes,
        "root_filesystem": root_disk(),
        "completed_at_unix_ms": time.time_ns() // 1_000_000,
    }
    write_json(RESULT, result)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    job = subparsers.add_parser("job")
    job.add_argument("--server-id", required=True)
    job.add_argument("--kind", choices=("fresh", "resumed"), required=True)
    job.add_argument("--cycle", type=int, required=True)
    subparsers.add_parser("diagnostic")
    args = parser.parse_args()
    if args.command == "job":
        execute_job(args.server_id, args.kind, args.cycle)
    else:
        diagnostic()


if __name__ == "__main__":
    main()
