#!/usr/bin/env python3
"""Execute one fresh or resumed workload inside a Lambda MicroVM."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import time
from pathlib import Path
from typing import Any

ROOT = Path("/tmp/lmvm-paired-statefulness")
NODE_IMAGE = (
    "public.ecr.aws/docker/library/node:24-bookworm@"
    "sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059"
)
NODE_SLIM_IMAGE = (
    "public.ecr.aws/docker/library/node:24-bookworm-slim@"
    "sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
)
RUBY_IMAGE = (
    "public.ecr.aws/docker/library/ruby:4.0.6-bookworm@"
    "sha256:0b28d5e7802f430cb78b20af30e196b40fc08c95839f50a0c1a7e84d667bc49e"
)
DOTNET_IMAGE = (
    "mcr.microsoft.com/dotnet/sdk:10.0.100@"
    "sha256:c7445f141c04f1a6b454181bd098dcfa606c61ba0bd213d0a702489e5bd4cd71"
)
EXPECTED_DOCKER_OUTPUT = "124750"
MODULE_COUNT = 500


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_hash(path: Path, ignored: set[str] | None = None) -> str:
    ignored = ignored or set()
    digest = hashlib.sha256()
    files = sorted(
        candidate
        for candidate in path.rglob("*")
        if candidate.is_file()
        and not ignored.intersection(candidate.relative_to(path).parts)
    )
    for candidate in files:
        relative = candidate.relative_to(path).as_posix().encode()
        content = candidate.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def run(
    command: list[str],
    *,
    log: Path,
    timed: bool = False,
    env: dict[str, str] | None = None,
) -> tuple[str, float | None]:
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter_ns()
    result = subprocess.run(
        command,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    elapsed = round((time.perf_counter_ns() - started) / 1_000_000, 3)
    log.write_text(result.stdout, encoding="utf-8")
    if result.returncode != 0:
        tail = "\n".join(result.stdout.splitlines()[-100:])
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n{tail}"
        )
    return result.stdout, elapsed if timed else None


def disk() -> dict[str, int]:
    usage = shutil.disk_usage("/")
    return {
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
    }


def resources() -> dict[str, Any]:
    mem = Path("/proc/meminfo").read_text(encoding="utf-8")
    memory_kib = int(mem.split("MemTotal:", 1)[1].split("kB", 1)[0].strip())
    output, _ = run(
        ["docker", "info", "--format", "{{.Driver}}"],
        log=ROOT / "docker-info.log",
    )
    return {
        "architecture": os.uname().machine,
        "logical_cpus": os.cpu_count(),
        "memory_total_bytes": memory_kib * 1024,
        "docker_storage_driver": output.strip(),
        "root_filesystem": disk(),
    }


def download_fixture(uri: str, expected_sha: str, target: Path) -> None:
    run(
        ["aws", "s3", "cp", "--only-show-errors", uri, str(target)],
        log=target.with_suffix(".download.log"),
    )
    observed = sha256_file(target)
    if observed != expected_sha:
        raise RuntimeError(
            f"fixture hash mismatch: expected {expected_sha}, observed {observed}"
        )


def extract_fixture(archive: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        roots = {member.name.split("/", 1)[0] for member in members if member.name}
        if len(roots) != 1:
            raise RuntimeError(f"fixture must have one archive root: {roots}")
        root = next(iter(roots))
        for member in members:
            if member.name == root:
                continue
            member.name = member.name.removeprefix(root + "/")
            if not member.name or Path(member.name).is_absolute() or ".." in Path(member.name).parts:
                raise RuntimeError(f"unsafe fixture member: {member.name}")
            if member.issym() or member.islnk():
                link = Path(member.linkname)
                if link.is_absolute() or ".." in link.parts:
                    raise RuntimeError(f"unsafe fixture link: {member.linkname}")
            bundle.extract(member, target)


def create_docker_context(work: Path) -> None:
    context = work / "source"
    (context / "src").mkdir(parents=True)
    package = {
        "name": "paired-statefulness-docker",
        "version": "1.0.0",
        "private": True,
        "scripts": {"build": "tsc -p tsconfig.json"},
        "devDependencies": {"typescript": "6.0.3"},
    }
    lock = {
        "name": package["name"],
        "version": "1.0.0",
        "lockfileVersion": 3,
        "requires": True,
        "packages": {
            "": {
                "name": package["name"],
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
    config = {
        "compilerOptions": {
            "target": "ES2022",
            "module": "CommonJS",
            "strict": True,
            "rootDir": "src",
            "outDir": "dist",
        },
        "include": ["src/**/*.ts"],
    }
    atomic_json(context / "package.json", package)
    atomic_json(context / "package-lock.json", lock)
    atomic_json(context / "tsconfig.json", config)
    imports: list[str] = []
    terms: list[str] = []
    for index in range(MODULE_COUNT):
        name = f"module{index:03d}"
        (context / "src" / f"{name}.ts").write_text(
            f"export const {name}: number = {index};\n", encoding="utf-8"
        )
        imports.append(f'import {{ {name} }} from "./{name}";')
        terms.append(name)
    (context / "src" / "index.ts").write_text(
        "\n".join(imports) + "\nconsole.log(" + "+".join(terms) + ");\n",
        encoding="utf-8",
    )
    dockerfile = f"""FROM {NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
FROM manifests AS dependencies
RUN --mount=type=cache,id=paired-npm,target=/root/.npm npm ci --no-audit --no-fund
FROM dependencies AS source
COPY tsconfig.json ./
COPY src ./src
FROM source AS compile
RUN npm run build
FROM compile AS verification
RUN test \"$(node dist/index.js)\" = \"{EXPECTED_DOCKER_OUTPUT}\"
FROM {NODE_SLIM_IMAGE} AS runtime-base
WORKDIR /app
RUN mkdir -p /app/dist && chown -R node:node /app
FROM runtime-base AS runtime
COPY --chown=node:node --from=verification /app/dist ./dist
USER node
CMD [\"node\", \"/app/dist/index.js\"]
"""
    (context / "Dockerfile").write_text(dockerfile, encoding="utf-8")
    (context / ".dockerignore").write_text("node_modules\ndist\n", encoding="utf-8")


def setup(workload: str, fixture_uri: str | None, fixture_sha: str | None) -> dict[str, Any]:
    work = ROOT / workload
    if work.exists():
        raise RuntimeError(f"fresh state already exists: {work}")
    work.mkdir(parents=True)
    if workload == "docker":
        create_docker_context(work)
        return {"input_sha256": tree_hash(work / "source")}
    if not fixture_uri or not fixture_sha:
        raise RuntimeError(f"{workload} requires a fixture URI and hash")
    archive = work / "fixture.tar.gz"
    download_fixture(fixture_uri, fixture_sha, archive)
    extract_fixture(archive, work / "source")
    source_hash = tree_hash(work / "source")
    if workload == "npm":
        run(["docker", "pull", NODE_IMAGE], log=work / "setup-pull.log")
    elif workload == "rails":
        runtime = work / "runtime"
        runtime.mkdir()
        (runtime / "Dockerfile").write_text(
            f"""FROM {RUBY_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git libgdbm-dev libgmp-dev libicu-dev libidn-dev libpq-dev libssl-dev libyaml-dev libvips-dev shared-mime-info zlib1g-dev && rm -rf /var/lib/apt/lists/*
RUN gem install bundler -v 4.0.16 --no-document
""",
            encoding="utf-8",
        )
        run(
            ["docker", "build", "--tag", "paired-rails-runtime:fixed", str(runtime)],
            log=work / "setup-runtime-build.log",
        )
    elif workload == "dotnet":
        run(["docker", "pull", DOTNET_IMAGE], log=work / "setup-pull.log")
    else:
        raise RuntimeError(f"unknown workload: {workload}")
    return {"input_sha256": source_hash, "fixture_sha256": fixture_sha}


def docker_workload(work: Path, label: str) -> tuple[float, dict[str, Any]]:
    iid = work / f"{label}.iid"
    output, elapsed = run(
        [
            "docker", "build", "--progress=plain", "--iidfile", str(iid),
            "--tag", "paired-statefulness:fixed", str(work / "source"),
        ],
        log=work / f"{label}.log",
        timed=True,
        env={**os.environ, "DOCKER_BUILDKIT": "1"},
    )
    verify, _ = run(
        ["docker", "run", "--rm", "paired-statefulness:fixed"],
        log=work / f"{label}-verify.log",
    )
    if verify.strip() != EXPECTED_DOCKER_OUTPUT:
        raise RuntimeError(f"unexpected Docker output: {verify!r}")
    return float(elapsed), {
        "image_id": iid.read_text(encoding="utf-8").strip(),
        "buildkit_cached_steps": sum(" CACHED" in line for line in output.splitlines()),
        "output": verify.strip(),
    }


def npm_workload(work: Path, label: str) -> tuple[float, dict[str, Any]]:
    source = work / "source"
    shutil.rmtree(source / "node_modules", ignore_errors=True)
    cache = work / "npm-cache"
    cache.mkdir(exist_ok=True)
    _, elapsed = run(
        [
            "docker", "run", "--rm", "--volume", f"{cache}:/root/.npm",
            "--volume", f"{source}:/work", "--workdir", "/work", NODE_IMAGE,
            "npm", "ci", "--prefer-offline", "--no-audit", "--no-fund",
        ],
        log=work / f"{label}.log",
        timed=True,
    )
    output, _ = run(
        [
            "docker", "run", "--rm", "--volume", f"{source}:/work",
            "--workdir", "/work", NODE_IMAGE, "npm", "ls", "--all", "--json",
        ],
        log=work / f"{label}-verify.log",
    )
    tree = json.loads(output)
    package_count = output.count('"version"')
    if package_count < 50 or not all(name in tree.get("dependencies", {}) for name in ("express", "pg", "redis", "zod")):
        raise RuntimeError(f"npm dependency verification failed: {package_count}")
    return float(elapsed), {"installed_package_count": package_count}


def rails_workload(work: Path, label: str) -> tuple[float, dict[str, Any]]:
    source = work / "source"
    bundle = work / "bundle"
    bundle.mkdir(exist_ok=True)
    common = [
        "docker", "run", "--rm", "--volume", f"{source}:/work",
        "--volume", f"{bundle}:/bundle", "--workdir", "/work",
        "--env", "BUNDLE_PATH=/bundle", "--env", "BUNDLE_WITHOUT=development:test",
        "--env", "BUNDLE_FROZEN=true", "--env", "BUNDLE_APP_CONFIG=/bundle/config",
        "paired-rails-runtime:fixed",
    ]
    _, elapsed = run(
        common + ["bundle", "_4.0.16_", "install", "--jobs", "2", "--retry", "3"],
        log=work / f"{label}.log",
        timed=True,
    )
    output, _ = run(
        common
        + [
            "sh", "-lc",
            "bundle _4.0.16_ check && bundle _4.0.16_ exec ruby -e 'require \"rails\"; require \"pg\"; require \"nokogiri\"; puts Rails.version'",
        ],
        log=work / f"{label}-verify.log",
    )
    version = output.strip().splitlines()[-1]
    if not version or not version[0].isdigit():
        raise RuntimeError(f"Rails verification failed: {output[-500:]}")
    return float(elapsed), {"rails_version": version, "bundle_bytes": directory_bytes(bundle)}


def directory_bytes(path: Path) -> int:
    return sum(candidate.stat().st_size for candidate in path.rglob("*") if candidate.is_file())


def dotnet_workload(work: Path, label: str) -> tuple[float, dict[str, Any]]:
    source = work / "source"
    packages = work / "nuget-packages"
    packages.mkdir(exist_ok=True)
    command = [
        "docker", "run", "--rm", "--volume", f"{source}:/work",
        "--volume", f"{packages}:/nuget", "--workdir", "/work",
        "--env", "NUGET_PACKAGES=/nuget", DOTNET_IMAGE,
    ]
    _, elapsed = run(
        command
        + [
            "dotnet", "restore", "eShop.Web.slnf", "--nologo",
            "--verbosity", "minimal",
        ],
        log=work / f"{label}.log",
        timed=True,
    )
    assets = sorted(source.rglob("project.assets.json"))
    if len(assets) < 15:
        raise RuntimeError(f"expected at least 15 project assets files, found {len(assets)}")
    digest = hashlib.sha256()
    for path in assets:
        digest.update(path.relative_to(source).as_posix().encode())
        digest.update(path.read_bytes())
    return float(elapsed), {
        "assets_file_count": len(assets),
        "assets_sha256": digest.hexdigest(),
        "nuget_packages_bytes": directory_bytes(packages),
    }


def upload(path: Path, uri: str) -> None:
    run(
        ["aws", "s3", "cp", "--only-show-errors", str(path), uri],
        log=path.with_suffix(".upload.log"),
    )


def execute(args: argparse.Namespace) -> None:
    work = ROOT / args.workload
    result_path = work / "result.json"
    if args.phase == "fresh":
        identity = setup(args.workload, args.fixture_s3_uri, args.fixture_sha256)
        result: dict[str, Any] = {
            "schema_version": 1,
            "run_id": args.run_id,
            "workload": args.workload,
            "lane_id": args.lane_id,
            "microvm_id": args.microvm_id,
            "identity": identity,
            "resources": resources(),
            "samples": [],
        }
    else:
        if not result_path.is_file():
            raise RuntimeError("resumed run has no fresh result")
        result = json.loads(result_path.read_text(encoding="utf-8"))
        if len(result["samples"]) != 1 or result["microvm_id"] != args.microvm_id:
            raise RuntimeError("resumed run does not match its fresh sample")
        ignored = {
            "npm": {"node_modules"},
            "dotnet": {"obj", "bin"},
        }.get(args.workload, set())
        observed = tree_hash(work / "source", ignored=ignored)
        if observed != result["identity"]["input_sha256"]:
            raise RuntimeError("fixture input changed across suspend/resume")

    before = disk()
    label = args.phase
    if args.workload == "docker":
        duration, proof = docker_workload(work, label)
    elif args.workload == "npm":
        duration, proof = npm_workload(work, label)
    elif args.workload == "rails":
        duration, proof = rails_workload(work, label)
    elif args.workload == "dotnet":
        duration, proof = dotnet_workload(work, label)
    else:
        raise RuntimeError(f"unknown workload: {args.workload}")
    result["samples"].append(
        {
            "phase": args.phase,
            "duration_ms": duration,
            "proof": proof,
            "disk_before": before,
            "disk_after": disk(),
            "completed_at_unix_ms": time.time_ns() // 1_000_000,
            "verified": True,
        }
    )
    atomic_json(result_path, result)
    upload(result_path, args.result_s3_uri)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--phase", choices=("fresh", "resumed"), required=True)
    cli = parser.parse_args()
    config = json.loads(cli.config.read_text(encoding="utf-8"))
    args = argparse.Namespace(
        **config,
        phase=cli.phase,
        result_s3_uri=f"{config['result_s3_prefix']}{cli.phase}.json",
    )
    try:
        execute(args)
    except Exception as error:
        failure = ROOT / args.workload / f"{args.phase}-failure.json"
        atomic_json(
            failure,
            {
                "schema_version": 1,
                "run_id": args.run_id,
                "workload": args.workload,
                "lane_id": args.lane_id,
                "microvm_id": args.microvm_id,
                "phase": args.phase,
                "error": str(error),
                "completed_at_unix_ms": time.time_ns() // 1_000_000,
            },
        )
        subprocess.run(
            [
                "aws", "s3", "cp", "--only-show-errors", str(failure),
                args.result_s3_uri,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        raise


if __name__ == "__main__":
    main()
