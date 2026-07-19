#!/usr/bin/env python3
"""Launch concurrent MicroVMs and orchestrate the warm-build benchmark."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import gzip
import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
GUEST_SCRIPT = SCRIPT_DIR / "guest_benchmark.py"
SHELL_SCRIPT = SCRIPT_DIR / "shell_phase.exp"


@dataclass
class Server:
    server_id: str
    microvm_id: str
    launch_started_ns: int
    cold_provision_to_running_ms: float = 0
    suspend_to_suspended_ms: float = 0
    resume_to_running_ms: float = 0


class Aws:
    def __init__(self, profile: str, region: str) -> None:
        self.profile = profile
        self.region = region

    def call(self, *arguments: str) -> Any:
        command = [
            "aws",
            "lambda-microvms",
            *arguments,
            "--profile",
            self.profile,
            "--region",
            self.region,
            "--output",
            "json",
        ]
        result = subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"AWS command failed: {' '.join(command[:4])}: "
                f"{result.stderr.strip()}"
            )
        return json.loads(result.stdout or "{}")

    def state(self, microvm_id: str) -> str:
        result = self.call(
            "get-microvm", "--microvm-identifier", microvm_id
        )
        return str(result["state"])

    def wait_for_state(
        self, microvm_id: str, desired: str, timeout_seconds: int = 300
    ) -> None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            state = self.state(microvm_id)
            if state == desired:
                return
            if state in {"TERMINATED", "TERMINATING"}:
                raise RuntimeError(
                    f"{microvm_id} entered {state} while waiting for {desired}"
                )
            time.sleep(1)
        raise TimeoutError(f"timed out waiting for {microvm_id}: {desired}")


def encoded_run_payload(region: str) -> str:
    value = json.dumps(
        {"version": 2, "mode": "warm", "region": region},
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.b64encode(gzip.compress(value)).decode("ascii")


def launch_servers(args: argparse.Namespace, aws: Aws) -> list[Server]:
    servers: list[Server] = []
    run_id = uuid.uuid4().hex[:12]
    ingress = (
        f"arn:aws:lambda:{args.region}:aws:network-connector:"
        "aws-network-connector:SHELL_INGRESS"
    )
    egress = (
        f"arn:aws:lambda:{args.region}:aws:network-connector:"
        "aws-network-connector:INTERNET_EGRESS"
    )
    payload = encoded_run_payload(args.region)
    for index in range(args.server_count):
        started = time.perf_counter_ns()
        try:
            result = aws.call(
                "run-microvm",
                "--image-identifier",
                args.image_arn,
                "--image-version",
                args.image_version,
                "--execution-role-arn",
                args.execution_role_arn,
                "--ingress-network-connectors",
                json.dumps([ingress]),
                "--egress-network-connectors",
                json.dumps([egress]),
                "--logging",
                json.dumps(
                    {"cloudWatch": {"logGroup": args.log_group}},
                    separators=(",", ":"),
                ),
                "--run-hook-payload",
                payload,
                "--maximum-duration-in-seconds",
                str(args.maximum_duration_seconds),
                "--client-token",
                f"benchmark-{run_id}-{index}",
            )
        except RuntimeError as error:
            print(f"launch {index + 1} rejected: {error}", flush=True)
            break
        servers.append(
            Server(
                server_id=f"server-{index + 1:02d}",
                microvm_id=str(result["microvmId"]),
                launch_started_ns=started,
            )
        )
        time.sleep(0.25)

    def wait(server: Server) -> None:
        aws.wait_for_state(server.microvm_id, "RUNNING")
        server.cold_provision_to_running_ms = round(
            (time.perf_counter_ns() - server.launch_started_ns) / 1_000_000,
            3,
        )

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=len(servers)
    ) as executor:
        list(executor.map(wait, servers))
    return servers


def shell_credentials(aws: Aws, server: Server) -> tuple[str, str]:
    token = aws.call(
        "create-microvm-shell-auth-token",
        "--microvm-identifier",
        server.microvm_id,
        "--expiration-in-minutes",
        "60",
    )["authToken"]["X-aws-proxy-auth"]
    endpoint = aws.call(
        "get-microvm", "--microvm-identifier", server.microvm_id
    )["endpoint"]
    return str(endpoint), str(token)


def run_shell_operation(
    aws: Aws,
    server: Server,
    operation: str,
    guest_script_b64: str,
    iterations: int,
    parallel_batches: int,
) -> str:
    result: subprocess.CompletedProcess[str] | None = None
    last_error = ""
    for attempt in range(1, 7):
        try:
            endpoint, token = shell_credentials(aws, server)
            environment = os.environ.copy()
            environment.update(
                {
                    "MICROVM_SHELL_ENDPOINT": endpoint,
                    "MICROVM_SHELL_TOKEN": token,
                    "BENCHMARK_OPERATION": operation,
                    "BENCHMARK_SERVER_ID": server.server_id,
                    "BENCHMARK_GUEST_SCRIPT_B64": guest_script_b64,
                    "BENCHMARK_ITERATIONS": str(iterations),
                    "BENCHMARK_PARALLEL_BATCHES": str(parallel_batches),
                }
            )
            result = subprocess.run(
                ["expect", str(SHELL_SCRIPT)],
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=1900,
                check=False,
            )
            environment["MICROVM_SHELL_TOKEN"] = ""
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            last_error = str(error)
            result = None
        else:
            if result.returncode == 0:
                break
            last_error = (
                f"exit={result.returncode} stdout={result.stdout.strip()} "
                f"stderr={result.stderr.strip()}"
            )
            if result.returncode in {12, 15, 20, 21}:
                break
        if attempt < 6:
            time.sleep(min(5 * attempt, 20))

    if result is None or result.returncode != 0:
        raise RuntimeError(
            f"{server.server_id} {operation} failed after retries: {last_error}"
        )
    return result.stdout.strip().splitlines()[-1]


def run_phase(
    aws: Aws,
    servers: list[Server],
    phase: str,
    workers: int,
    iterations: int,
    parallel_batches: int,
) -> list[dict[str, Any]]:
    guest_script_b64 = base64.b64encode(GUEST_SCRIPT.read_bytes()).decode(
        "ascii"
    )
    def run_operation(server: Server, operation: str) -> str:
        return run_shell_operation(
            aws,
            server,
            operation,
            guest_script_b64,
            iterations,
            parallel_batches,
        )

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(workers, len(servers))
    ) as executor:
        futures = {
            executor.submit(run_operation, server, f"{phase}-start"): server
            for server in servers
        }
        for future in concurrent.futures.as_completed(futures):
            server = futures[future]
            future.result()
            print(f"{server.server_id} {phase} started", flush=True)

    completed: dict[str, str] = {}
    pending = {server.server_id: server for server in servers}
    deadline = time.monotonic() + 1800
    while pending:
        if time.monotonic() >= deadline:
            raise TimeoutError(f"{phase} did not finish within 30 minutes")
        time.sleep(15)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(workers, len(pending))
        ) as executor:
            futures = {
                executor.submit(
                    run_operation, server, f"{phase}-status"
                ): server
                for server in pending.values()
            }
            for future in concurrent.futures.as_completed(futures):
                server = futures[future]
                value = future.result()
                if value == "pending":
                    continue
                completed[server.server_id] = value
                print(f"{server.server_id} {phase} complete", flush=True)
        pending = {
            server_id: server
            for server_id, server in pending.items()
            if server_id not in completed
        }

    results: list[dict[str, Any]] = []
    if phase == "phase1":
        return results
    for server in servers:
        encoded = completed[server.server_id]
        value = json.loads(base64.b64decode(encoded).decode("utf-8"))
        value["control_plane"] = {
            "cold_provision_to_running_ms": (
                server.cold_provision_to_running_ms
            ),
            "suspend_to_suspended_ms": server.suspend_to_suspended_ms,
            "resume_to_running_ms": server.resume_to_running_ms,
        }
        results.append(value)
    return sorted(results, key=lambda result: result["server_id"])


def transition(
    aws: Aws,
    servers: list[Server],
    operation: str,
    desired_state: str,
    workers: int,
) -> None:
    def execute(server: Server) -> None:
        started = time.perf_counter_ns()
        aws.call(
            f"{operation}-microvm",
            "--microvm-identifier",
            server.microvm_id,
        )
        aws.wait_for_state(server.microvm_id, desired_state)
        duration = round(
            (time.perf_counter_ns() - started) / 1_000_000, 3
        )
        if operation == "suspend":
            server.suspend_to_suspended_ms = duration
        else:
            server.resume_to_running_ms = duration

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        list(executor.map(execute, servers))


def terminate_all(aws: Aws, servers: list[Server]) -> None:
    def terminate(server: Server) -> None:
        try:
            aws.call(
                "terminate-microvm",
                "--microvm-identifier",
                server.microvm_id,
            )
        except RuntimeError as error:
            print(f"cleanup warning for {server.server_id}: {error}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        list(executor.map(terminate, servers))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-arn", required=True)
    parser.add_argument("--image-version", required=True)
    parser.add_argument("--execution-role-arn", required=True)
    parser.add_argument("--log-group", required=True)
    parser.add_argument("--profile", default="HomesCollectorAdmin")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--server-count", type=int, default=9)
    parser.add_argument("--minimum-server-count", type=int, default=3)
    parser.add_argument("--shell-workers", type=int, default=3)
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--parallel-batches", type=int, default=2)
    parser.add_argument(
        "--shell-readiness-delay-seconds", type=int, default=30
    )
    parser.add_argument("--maximum-duration-seconds", type=int, default=7200)
    parser.add_argument("--image-artifact-sha256")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    aws = Aws(args.profile, args.region)
    servers: list[Server] = []
    try:
        servers = launch_servers(args, aws)
        if len(servers) < args.minimum_server_count:
            raise RuntimeError(
                f"only {len(servers)} servers launched; "
                f"minimum is {args.minimum_server_count}"
            )
        print(f"{len(servers)} servers running", flush=True)
        time.sleep(args.shell_readiness_delay_seconds)
        run_phase(
            aws,
            servers,
            "phase1",
            args.shell_workers,
            args.iterations,
            args.parallel_batches,
        )
        transition(aws, servers, "suspend", "SUSPENDED", workers=2)
        print("all servers suspended", flush=True)
        transition(aws, servers, "resume", "RUNNING", workers=5)
        print("all servers resumed", flush=True)
        results = run_phase(
            aws,
            servers,
            "phase2",
            args.shell_workers,
            args.iterations,
            args.parallel_batches,
        )
        raw = {
            "schema_version": 1,
            "created_at_unix_ms": time.time_ns() // 1_000_000,
            "configuration": {
                "image_name": args.image_arn.rsplit(":", 1)[-1],
                "image_version": args.image_version,
                "region": args.region,
                "requested_server_count": args.server_count,
                "actual_server_count": len(servers),
                "requested_minimum_memory_mib": 2048,
                "warm_iterations_per_server": args.iterations,
                "parallel_build_batches_per_server": args.parallel_batches,
            },
            "servers": results,
        }
        if args.image_artifact_sha256:
            raw["configuration"]["image_artifact_sha256"] = (
                args.image_artifact_sha256
            )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(raw, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"raw results: {args.output}", flush=True)
    finally:
        terminate_all(aws, servers)


if __name__ == "__main__":
    main()
