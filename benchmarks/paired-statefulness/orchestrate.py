#!/usr/bin/env python3
"""Run independent fresh/resumed workload pairs on Lambda MicroVMs."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
GUEST_SCRIPT = SCRIPT_DIR / "guest.py"
SHELL_SCRIPT = SCRIPT_DIR / "shell_phase.exp"
NPM_FIXTURE = SCRIPT_DIR / "fixtures" / "npm"
WORKLOADS = ("docker", "npm", "rails", "dotnet")
MASTODON_COMMIT = "9d51f51cc07aca1dc8e5ddfeadd1b6ed33815f43"
ESHOP_COMMIT = "9b4f9434f46fdc5c1a6e9e936af2868340cdbc48"


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


class Aws:
    def __init__(self, profile: str, region: str) -> None:
        self.profile = profile
        self.region = region

    def command(self, service: str, *arguments: str) -> list[str]:
        return [
            "aws", service, *arguments, "--profile", self.profile,
            "--region", self.region, "--output", "json",
        ]

    def call(self, service: str, *arguments: str) -> Any:
        command = self.command(service, *arguments)
        result = subprocess.run(
            command, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"AWS {service} call failed: {result.stderr.strip()}"
            )
        return json.loads(result.stdout or "{}")

    def state(self, microvm_id: str) -> str:
        return str(
            self.call(
                "lambda-microvms", "get-microvm",
                "--microvm-identifier", microvm_id,
            )["state"]
        )

    def wait(self, microvm_id: str, desired: str, timeout: int = 600) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = self.state(microvm_id)
            if state == desired:
                return
            if state == "TERMINATED" and desired != "TERMINATED":
                raise RuntimeError(
                    f"{microvm_id} terminated while waiting for {desired}"
                )
            time.sleep(2)
        raise TimeoutError(f"timed out waiting for {microvm_id}: {desired}")

    def s3_upload(self, source: Path, bucket: str, key: str) -> None:
        command = [
            "aws", "s3", "cp", "--only-show-errors", str(source),
            f"s3://{bucket}/{key}", "--profile", self.profile,
            "--region", self.region,
        ]
        subprocess.run(command, check=True)

    def s3_json(self, bucket: str, key: str) -> dict[str, Any]:
        command = [
            "aws", "s3", "cp", "--only-show-errors",
            f"s3://{bucket}/{key}", "-", "--profile", self.profile,
            "--region", self.region,
        ]
        result = subprocess.run(
            command, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"S3 read failed for {key}: {result.stderr}")
        return json.loads(result.stdout)

    def s3_exists(self, bucket: str, key: str) -> bool:
        command = [
            "aws", "s3api", "head-object", "--bucket", bucket,
            "--key", key, "--profile", self.profile,
            "--region", self.region,
        ]
        result = subprocess.run(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0


class Ledger:
    def __init__(
        self, aws: Aws, bucket: str, prefix: str, local: Path
    ) -> None:
        self.aws = aws
        self.bucket = bucket
        self.prefix = prefix.rstrip("/")
        self.local = local
        self.lock = threading.Lock()
        self.sequences: dict[str, int] = {}

    def put(self, relative: str, value: object) -> None:
        path = self.local / relative
        atomic_json(path, value)
        self.aws.s3_upload(path, self.bucket, f"{self.prefix}/{relative}")

    def event(self, lane: str, state: str, details: dict[str, Any]) -> None:
        with self.lock:
            sequence = self.sequences.get(lane, 0) + 1
            self.sequences[lane] = sequence
        value = {
            "schema_version": 1,
            "lane": lane,
            "sequence": sequence,
            "state": state,
            "at_unix_ms": time.time_ns() // 1_000_000,
            "details": details,
        }
        safe_lane = lane.replace("/", "-")
        self.put(
            f"events/{safe_lane}-{sequence:03d}-{uuid.uuid4().hex[:8]}.json",
            value,
        )
        self.put(f"lanes/{lane}/host.json", value)


@dataclass(frozen=True)
class Fixture:
    name: str
    local_path: Path
    sha256: str
    s3_uri: str


@dataclass(frozen=True)
class Config:
    run_id: str
    image_arn: str
    image_version: str
    execution_role_arn: str
    log_group: str
    bucket: str
    prefix: str
    sample_count: int
    wave_size: int
    maximum_duration_seconds: int
    shell_readiness_delay_seconds: int
    max_attempts: int


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "lmvm-benchmark"})
    with urllib.request.urlopen(request, timeout=120) as response:
        with destination.open("wb") as stream:
            shutil.copyfileobj(response, stream)


def npm_archive(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "w:gz") as archive:
        for source in sorted(NPM_FIXTURE.iterdir()):
            if source.name not in {"package.json", "package-lock.json"}:
                continue
            archive.add(source, arcname=f"npm-fixture/{source.name}")


def prepare_fixtures(
    aws: Aws, bucket: str, prefix: str, local: Path
) -> dict[str, Fixture]:
    paths = {
        "npm": local / "npm.tar.gz",
        "rails": local / f"mastodon-{MASTODON_COMMIT}.tar.gz",
        "dotnet": local / f"eshop-{ESHOP_COMMIT}.tar.gz",
    }
    npm_archive(paths["npm"])
    if not paths["rails"].is_file():
        download(
            f"https://github.com/mastodon/mastodon/archive/{MASTODON_COMMIT}.tar.gz",
            paths["rails"],
        )
    if not paths["dotnet"].is_file():
        download(
            f"https://github.com/dotnet/eShop/archive/{ESHOP_COMMIT}.tar.gz",
            paths["dotnet"],
        )
    fixtures: dict[str, Fixture] = {}
    for name, path in paths.items():
        digest = sha256_file(path)
        key = f"{prefix}/fixtures/{digest}/{path.name}"
        aws.s3_upload(path, bucket, key)
        fixtures[name] = Fixture(name, path, digest, f"s3://{bucket}/{key}")
    return fixtures


def run_payload(region: str) -> str:
    raw = json.dumps(
        {"version": 2, "mode": "warm", "region": region},
        separators=(",", ":"),
    ).encode()
    return base64.b64encode(gzip.compress(raw)).decode()


def shell_credentials(aws: Aws, microvm_id: str) -> tuple[str, str]:
    token = aws.call(
        "lambda-microvms", "create-microvm-shell-auth-token",
        "--microvm-identifier", microvm_id,
        "--expiration-in-minutes", "60",
    )["authToken"]["X-aws-proxy-auth"]
    endpoint = aws.call(
        "lambda-microvms", "get-microvm",
        "--microvm-identifier", microvm_id,
    )["endpoint"]
    return str(endpoint), str(token)


def shell(
    aws: Aws,
    *,
    operation: str,
    config: Config,
    workload: str,
    lane_id: str,
    phase: str,
    microvm_id: str,
    result_uri: str,
    fixture: Fixture | None,
) -> str:
    last = ""
    for attempt in range(1, 7):
        try:
            endpoint, token = shell_credentials(aws, microvm_id)
            environment = os.environ.copy()
            environment.update(
                {
                    "MICROVM_SHELL_ENDPOINT": endpoint,
                    "MICROVM_SHELL_TOKEN": token,
                    "BENCHMARK_OPERATION": operation,
                    "BENCHMARK_RUN_ID": config.run_id,
                    "BENCHMARK_WORKLOAD": workload,
                    "BENCHMARK_LANE_ID": lane_id,
                    "BENCHMARK_PHASE": phase,
                    "BENCHMARK_MICROVM_ID": microvm_id,
                    "BENCHMARK_RESULT_S3_URI": result_uri,
                    "BENCHMARK_FIXTURE_S3_URI": fixture.s3_uri if fixture else "",
                    "BENCHMARK_FIXTURE_SHA256": fixture.sha256 if fixture else "",
                    "BENCHMARK_GUEST_SCRIPT_B64": base64.b64encode(
                        GUEST_SCRIPT.read_bytes()
                    ).decode(),
                    "BENCHMARK_GUEST_CONFIG_B64": base64.b64encode(
                        json.dumps(
                            {
                                "run_id": config.run_id,
                                "workload": workload,
                                "lane_id": lane_id,
                                "microvm_id": microvm_id,
                                "fixture_s3_uri": (
                                    fixture.s3_uri if fixture else None
                                ),
                                "fixture_sha256": (
                                    fixture.sha256 if fixture else None
                                ),
                                "result_s3_prefix": result_uri.removesuffix(
                                    f"{phase}.json"
                                ),
                            },
                            separators=(",", ":"),
                        ).encode()
                    ).decode(),
                }
            )
            result = subprocess.run(
                ["expect", str(SHELL_SCRIPT)],
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=180,
                check=False,
            )
            environment["MICROVM_SHELL_TOKEN"] = ""
            if result.returncode == 0:
                return result.stdout.strip().splitlines()[-1]
            last = (
                f"exit={result.returncode} stdout={result.stdout.strip()} "
                f"stderr={result.stderr.strip()}"
            )
            if result.returncode in {12, 20, 21}:
                break
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            last = str(error)
        time.sleep(min(attempt * 4, 20))
    raise RuntimeError(f"{lane_id} {phase} {operation} shell failed: {last}")


def wait_job(
    aws: Aws,
    config: Config,
    workload: str,
    lane_id: str,
    phase: str,
    microvm_id: str,
    result_uri: str,
    fixture: Fixture | None,
) -> None:
    result_key = result_uri.split(f"s3://{config.bucket}/", 1)[-1]
    timeout = 3600 if workload == "rails" else 2400
    deadline = time.monotonic() + timeout
    next_state_check = time.monotonic()
    while time.monotonic() < deadline:
        time.sleep(5)
        if aws.s3_exists(config.bucket, result_key):
            return
        if time.monotonic() >= next_state_check:
            state = aws.state(microvm_id)
            if state != "RUNNING":
                raise RuntimeError(
                    f"{lane_id} left RUNNING during {phase}: {state}"
                )
            next_state_check = time.monotonic() + 30
    raise TimeoutError(f"{lane_id} {phase} exceeded {timeout} seconds")


def validate_guest_result(
    value: dict[str, Any], workload: str, lane_id: str,
    microvm_id: str, phase: str,
) -> None:
    if value.get("error"):
        raise RuntimeError(
            f"guest failed in {lane_id} {phase}: {value['error']}"
        )
    if (
        value.get("workload") != workload
        or value.get("lane_id") != lane_id
        or value.get("microvm_id") != microvm_id
    ):
        raise RuntimeError(f"identity mismatch in {lane_id} {phase}")
    expected = 1 if phase == "fresh" else 2
    samples = value.get("samples", [])
    if len(samples) != expected or samples[-1].get("phase") != phase:
        raise RuntimeError(f"sample sequence mismatch in {lane_id} {phase}")
    if not all(sample.get("verified") for sample in samples):
        raise RuntimeError(f"unverified sample in {lane_id}")
    if not all(float(sample.get("duration_ms", 0)) > 0 for sample in samples):
        raise RuntimeError(f"invalid duration in {lane_id}")


def launch(
    aws: Aws, config: Config, workload: str, lane_id: str, attempt: int
) -> str:
    ingress = (
        f"arn:aws:lambda:{aws.region}:aws:network-connector:"
        "aws-network-connector:SHELL_INGRESS"
    )
    egress = (
        f"arn:aws:lambda:{aws.region}:aws:network-connector:"
        "aws-network-connector:INTERNET_EGRESS"
    )
    response = aws.call(
        "lambda-microvms", "run-microvm",
        "--image-identifier", config.image_arn,
        "--image-version", config.image_version,
        "--execution-role-arn", config.execution_role_arn,
        "--ingress-network-connectors", json.dumps([ingress]),
        "--egress-network-connectors", json.dumps([egress]),
        "--logging", json.dumps({"cloudWatch": {"logGroup": config.log_group}}),
        "--run-hook-payload", run_payload(aws.region),
        "--maximum-duration-in-seconds", str(config.maximum_duration_seconds),
        "--client-token", f"paired-{config.run_id}-{workload}-{lane_id[-3:]}-{attempt}",
    )
    return str(response["microvmId"])


def terminate(aws: Aws, microvm_id: str) -> None:
    errors: list[str] = []
    for attempt in range(1, 11):
        try:
            if aws.state(microvm_id) == "TERMINATED":
                return
            aws.call(
                "lambda-microvms", "terminate-microvm",
                "--microvm-identifier", microvm_id,
            )
            aws.wait(microvm_id, "TERMINATED", timeout=300)
            return
        except (RuntimeError, TimeoutError) as error:
            errors.append(f"attempt {attempt}: {error}")
            time.sleep(min(attempt * 2, 15))
    raise RuntimeError(
        f"could not verify termination for {microvm_id}: {'; '.join(errors)}"
    )


def execute_lane(
    aws: Aws,
    ledger: Ledger,
    config: Config,
    workload: str,
    lane_number: int,
    fixture: Fixture | None,
) -> dict[str, Any]:
    lane_name = f"lane-{lane_number:03d}"
    lane_path = f"{workload}/{lane_name}"
    errors: list[str] = []
    for attempt in range(1, config.max_attempts + 1):
        microvm_id = ""
        try:
            ledger.event(lane_path, "LAUNCHING", {"attempt": attempt})
            launch_started = time.perf_counter_ns()
            microvm_id = launch(aws, config, workload, lane_name, attempt)
            ledger.event(
                lane_path, "LAUNCHED",
                {"attempt": attempt, "microvm_id": microvm_id},
            )
            aws.wait(microvm_id, "RUNNING")
            provision_to_running_ms = round(
                (time.perf_counter_ns() - launch_started) / 1_000_000, 3
            )
            ledger.event(
                lane_path, "RUNNING",
                {"attempt": attempt, "microvm_id": microvm_id,
                 "provision_to_running_ms": provision_to_running_ms},
            )
            time.sleep(config.shell_readiness_delay_seconds)

            results: dict[str, dict[str, Any]] = {}
            lifecycle: dict[str, float] = {
                "provision_to_running_ms": provision_to_running_ms
            }
            for phase in ("fresh", "resumed"):
                key = (
                    f"{config.prefix}/lanes/{lane_path}/attempts/"
                    f"{attempt}/{phase}.json"
                )
                uri = f"s3://{config.bucket}/{key}"
                shell(
                    aws, operation="start", config=config,
                    workload=workload, lane_id=lane_name, phase=phase,
                    microvm_id=microvm_id, result_uri=uri, fixture=fixture,
                )
                wait_job(
                    aws, config, workload, lane_name, phase,
                    microvm_id, uri, fixture,
                )
                value = aws.s3_json(config.bucket, key)
                validate_guest_result(
                    value, workload, lane_name, microvm_id, phase
                )
                results[phase] = value
                ledger.event(
                    lane_path, f"{phase.upper()}_VERIFIED",
                    {"attempt": attempt, "microvm_id": microvm_id,
                     "result_key": key},
                )
                if phase == "fresh":
                    started = time.perf_counter_ns()
                    aws.call(
                        "lambda-microvms", "suspend-microvm",
                        "--microvm-identifier", microvm_id,
                    )
                    aws.wait(microvm_id, "SUSPENDED")
                    lifecycle["suspend_to_suspended_ms"] = round(
                        (time.perf_counter_ns() - started) / 1_000_000, 3
                    )
                    ledger.event(
                        lane_path, "SUSPENDED",
                        {"attempt": attempt, "microvm_id": microvm_id},
                    )
                    started = time.perf_counter_ns()
                    aws.call(
                        "lambda-microvms", "resume-microvm",
                        "--microvm-identifier", microvm_id,
                    )
                    aws.wait(microvm_id, "RUNNING")
                    lifecycle["resume_to_running_ms"] = round(
                        (time.perf_counter_ns() - started) / 1_000_000, 3
                    )
                    ledger.event(
                        lane_path, "RESUMED",
                        {"attempt": attempt, "microvm_id": microvm_id},
                    )
                    time.sleep(config.shell_readiness_delay_seconds)

            fresh = results["fresh"]
            resumed = results["resumed"]
            if fresh["identity"] != resumed["identity"]:
                raise RuntimeError(f"input identity changed in {lane_path}")
            if resumed["samples"][0] != fresh["samples"][0]:
                raise RuntimeError(f"fresh sample was rewritten in {lane_path}")
            terminate(aws, microvm_id)
            ledger.event(
                lane_path, "TERMINATED",
                {"attempt": attempt, "microvm_id": microvm_id},
            )
            return {
                "workload": workload,
                "lane_id": lane_name,
                "attempt": attempt,
                "microvm_id": microvm_id,
                "lifecycle": lifecycle,
                "guest": resumed,
                "failed_attempts": errors,
                "terminated": True,
            }
        except Exception as error:
            message = f"attempt {attempt}: {error}"
            errors.append(message)
            ledger.event(
                lane_path, "ATTEMPT_FAILED",
                {"attempt": attempt, "microvm_id": microvm_id,
                 "error": str(error)},
            )
            if microvm_id:
                try:
                    terminate(aws, microvm_id)
                except RuntimeError as cleanup_error:
                    errors.append(f"cleanup: {cleanup_error}")
            print(f"{lane_path} {message}", flush=True)
    raise RuntimeError(f"{lane_path} exhausted attempts: {'; '.join(errors)}")


def git_commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=SCRIPT_DIR,
        text=True, stdout=subprocess.PIPE, check=True,
    )
    return result.stdout.strip()


def run_benchmark(args: argparse.Namespace) -> None:
    if args.sample_count < 1 or args.sample_count > 30:
        raise ValueError("sample count must be between 1 and 30")
    if args.wave_size < 1 or args.wave_size > 10:
        raise ValueError("wave size must be between 1 and 10")
    if args.maximum_duration_seconds > 28_800:
        raise ValueError("maximum duration cannot exceed eight hours")
    if args.maximum_duration_seconds < 3600:
        raise ValueError("maximum duration must be at least one hour")
    run_id = args.run_id or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not re.fullmatch(r"[A-Za-z0-9._-]{6,64}", run_id):
        raise ValueError("run ID contains unsupported characters")
    prefix = f"{args.prefix.strip('/')}/runs/{run_id}"
    output = args.output / run_id
    aws = Aws(args.profile, args.region)
    ledger = Ledger(aws, args.bucket, prefix, output / "ledger")
    fixtures = prepare_fixtures(
        aws, args.bucket, prefix, output / "fixtures"
    )
    selected = tuple(args.workloads)
    config = Config(
        run_id=run_id,
        image_arn=args.image_arn,
        image_version=args.image_version,
        execution_role_arn=args.execution_role_arn,
        log_group=args.log_group,
        bucket=args.bucket,
        prefix=prefix,
        sample_count=args.sample_count,
        wave_size=args.wave_size,
        maximum_duration_seconds=args.maximum_duration_seconds,
        shell_readiness_delay_seconds=args.shell_readiness_delay_seconds,
        max_attempts=args.max_attempts,
    )
    manifest = {
        "schema_version": 1,
        "run_id": run_id,
        "created_at_unix_ms": time.time_ns() // 1_000_000,
        "harness_git_commit": git_commit(),
        "region": args.region,
        "image_arn": args.image_arn,
        "image_version": args.image_version,
        "sample_count_per_workload": args.sample_count,
        "wave_size": args.wave_size,
        "maximum_duration_seconds": args.maximum_duration_seconds,
        "workloads": list(selected),
        "lanes": [
            f"{workload}/lane-{lane:03d}"
            for workload in selected
            for lane in range(1, args.sample_count + 1)
        ],
        "fixtures": {
            name: {"sha256": fixture.sha256, "s3_uri": fixture.s3_uri}
            for name, fixture in fixtures.items()
        },
    }
    ledger.put("manifest.json", manifest)
    all_results: list[dict[str, Any]] = []
    failures: list[str] = []
    for workload in selected:
        print(f"starting workload {workload}", flush=True)
        for wave_start in range(1, args.sample_count + 1, args.wave_size):
            lane_numbers = list(
                range(
                    wave_start,
                    min(wave_start + args.wave_size, args.sample_count + 1),
                )
            )
            print(f"{workload} wave lanes {lane_numbers}", flush=True)
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=len(lane_numbers)
            ) as executor:
                future_map = {
                    executor.submit(
                        execute_lane, aws, ledger, config, workload, lane,
                        fixtures.get(workload),
                    ): lane
                    for lane in lane_numbers
                }
                for future in concurrent.futures.as_completed(future_map):
                    lane = future_map[future]
                    try:
                        result = future.result()
                        all_results.append(result)
                        print(
                            f"{workload}/lane-{lane:03d} complete",
                            flush=True,
                        )
                    except Exception as error:
                        failures.append(
                            f"{workload}/lane-{lane:03d}: {error}"
                        )
            if failures:
                break
        if failures:
            break
    raw = {
        "schema_version": 1,
        "manifest": manifest,
        "results": sorted(
            all_results, key=lambda item: (item["workload"], item["lane_id"])
        ),
        "failures": failures,
        "completed_at_unix_ms": time.time_ns() // 1_000_000,
    }
    raw_path = output / "raw.json"
    atomic_json(raw_path, raw)
    aws.s3_upload(raw_path, args.bucket, f"{prefix}/output/raw.json")
    print(f"raw result: {raw_path}", flush=True)
    if failures:
        raise RuntimeError("benchmark failed: " + "; ".join(failures))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-arn", required=True)
    parser.add_argument("--image-version", required=True)
    parser.add_argument("--execution-role-arn", required=True)
    parser.add_argument("--log-group", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", default="paired-statefulness")
    parser.add_argument("--profile", default="HomesCollectorAdmin")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--run-id")
    parser.add_argument("--sample-count", type=int, default=30)
    parser.add_argument("--wave-size", type=int, default=10)
    parser.add_argument("--workloads", nargs="+", choices=WORKLOADS, default=WORKLOADS)
    parser.add_argument("--maximum-duration-seconds", type=int, default=7200)
    parser.add_argument("--shell-readiness-delay-seconds", type=int, default=30)
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--output", type=Path, default=Path("build/paired-statefulness"))
    run_benchmark(parser.parse_args())


if __name__ == "__main__":
    main()
