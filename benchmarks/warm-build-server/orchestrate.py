#!/usr/bin/env python3
"""Orchestrate repeated exact jobs across persistent Lambda MicroVMs."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import gzip
import json
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
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
    provision_to_running_ms: float = 0
    provision_to_job_complete_ms: float = 0
    fresh_suspend_to_suspended_ms: float = 0
    last_suspended_ns: int | None = None
    resume_started_ns: dict[int, int] = field(default_factory=dict)
    cycles: dict[int, dict[str, float | int]] = field(default_factory=dict)


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
            if state == "TERMINATED" or (
                state == "TERMINATING" and desired != "TERMINATED"
            ):
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


def launch_servers(
    args: argparse.Namespace,
    aws: Aws,
    run_id: str,
    servers: list[Server],
) -> None:
    ingress = (
        f"arn:aws:lambda:{args.region}:aws:network-connector:"
        "aws-network-connector:SHELL_INGRESS"
    )
    egress = (
        f"arn:aws:lambda:{args.region}:aws:network-connector:"
        "aws-network-connector:INTERNET_EGRESS"
    )
    payload = encoded_run_payload(args.region)
    lock = threading.Lock()

    def launch(index: int) -> None:
        started = time.perf_counter_ns()
        response = aws.call(
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
            f"exact-job-{run_id}-{index}",
        )
        server = Server(
            server_id=f"server-{index + 1:02d}",
            microvm_id=str(response["microvmId"]),
            launch_started_ns=started,
        )
        with lock:
            servers.append(server)
        aws.wait_for_state(server.microvm_id, "RUNNING")
        server.provision_to_running_ms = round(
            (time.perf_counter_ns() - server.launch_started_ns) / 1_000_000,
            3,
        )

    errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.server_count
    ) as executor:
        futures = {
            executor.submit(launch, index): index
            for index in range(args.server_count)
        }
        for future in concurrent.futures.as_completed(futures):
            index = futures[future]
            try:
                future.result()
            except Exception as error:
                message = f"launch {index + 1} failed: {error}"
                errors.append(message)
                print(message, flush=True)
    servers.sort(key=lambda server: server.server_id)
    if errors:
        raise RuntimeError("; ".join(errors))


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
    *,
    kind: str,
    cycle: int,
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
                    "BENCHMARK_JOB_KIND": kind,
                    "BENCHMARK_CYCLE": str(cycle),
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
            if result.returncode in {12, 15, 16, 17, 18, 20, 21}:
                break
        if attempt < 6:
            time.sleep(min(5 * attempt, 20))

    if result is None or result.returncode != 0:
        raise RuntimeError(
            f"{server.server_id} {operation} cycle {cycle} failed "
            f"after retries: {last_error}"
        )
    return result.stdout.strip().splitlines()[-1]


def run_jobs(
    aws: Aws,
    servers: list[Server],
    *,
    kind: str,
    cycle: int,
    workers: int,
) -> None:
    guest_script_b64 = base64.b64encode(GUEST_SCRIPT.read_bytes()).decode(
        "ascii"
    )

    def operation(server: Server, name: str) -> str:
        return run_shell_operation(
            aws,
            server,
            name,
            guest_script_b64,
            kind=kind,
            cycle=cycle,
        )

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(workers, len(servers))
    ) as executor:
        futures = {
            executor.submit(operation, server, "job-start"): server
            for server in servers
        }
        for future in concurrent.futures.as_completed(futures):
            server = futures[future]
            future.result()
            print(
                f"{server.server_id} {kind} cycle {cycle} started",
                flush=True,
            )

    pending = {server.server_id: server for server in servers}
    deadline = time.monotonic() + 1800
    while pending:
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"{kind} cycle {cycle} did not finish within 30 minutes"
            )
        time.sleep(5)
        completed: set[str] = set()
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(workers, len(pending))
        ) as executor:
            futures = {
                executor.submit(operation, server, "job-status"): server
                for server in pending.values()
            }
            for future in concurrent.futures.as_completed(futures):
                server = futures[future]
                if future.result() == "pending":
                    continue
                completed.add(server.server_id)
                finished_ns = time.perf_counter_ns()
                if kind == "fresh":
                    server.provision_to_job_complete_ms = round(
                        (finished_ns - server.launch_started_ns) / 1_000_000,
                        3,
                    )
                else:
                    server.cycles[cycle][
                        "resume_to_job_complete_ms"
                    ] = round(
                        (
                            finished_ns
                            - server.resume_started_ns[cycle]
                        )
                        / 1_000_000,
                        3,
                    )
                print(
                    f"{server.server_id} {kind} cycle {cycle} complete",
                    flush=True,
                )
        pending = {
            server_id: server
            for server_id, server in pending.items()
            if server_id not in completed
        }


def suspend_servers(
    aws: Aws, servers: list[Server], *, after_cycle: int, workers: int
) -> None:
    def suspend(server: Server) -> None:
        started = time.perf_counter_ns()
        aws.call(
            "suspend-microvm", "--microvm-identifier", server.microvm_id
        )
        aws.wait_for_state(server.microvm_id, "SUSPENDED")
        completed = time.perf_counter_ns()
        duration = round((completed - started) / 1_000_000, 3)
        if after_cycle == 0:
            server.fresh_suspend_to_suspended_ms = duration
        else:
            server.cycles[after_cycle][
                "suspend_to_suspended_ms"
            ] = duration
        server.last_suspended_ns = completed

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        list(executor.map(suspend, servers))


def resume_servers(
    aws: Aws, servers: list[Server], *, cycle: int, workers: int
) -> None:
    def resume(server: Server) -> None:
        started = time.perf_counter_ns()
        if server.last_suspended_ns is None:
            raise RuntimeError(f"{server.server_id} was not suspended")
        server.resume_started_ns[cycle] = started
        server.cycles[cycle] = {
            "cycle": cycle,
            "suspended_dwell_ms": round(
                (started - server.last_suspended_ns) / 1_000_000, 3
            ),
        }
        aws.call(
            "resume-microvm", "--microvm-identifier", server.microvm_id
        )
        aws.wait_for_state(server.microvm_id, "RUNNING")
        server.cycles[cycle]["resume_to_running_ms"] = round(
            (time.perf_counter_ns() - started) / 1_000_000, 3
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        list(executor.map(resume, servers))


def fetch_guest_results(
    aws: Aws, servers: list[Server], workers: int
) -> dict[str, dict[str, Any]]:
    guest_script_b64 = base64.b64encode(GUEST_SCRIPT.read_bytes()).decode(
        "ascii"
    )

    def fetch(server: Server) -> tuple[str, dict[str, Any]]:
        encoded = run_shell_operation(
            aws,
            server,
            "result",
            guest_script_b64,
            kind="result",
            cycle=99,
        )
        value = json.loads(base64.b64decode(encoded).decode("utf-8"))
        return server.server_id, value

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(workers, len(servers))
    ) as executor:
        return dict(executor.map(fetch, servers))


def terminate_all(aws: Aws, servers: list[Server]) -> None:
    def terminate(server: Server) -> None:
        try:
            if aws.state(server.microvm_id) != "TERMINATED":
                aws.call(
                    "terminate-microvm",
                    "--microvm-identifier",
                    server.microvm_id,
                )
                aws.wait_for_state(
                    server.microvm_id, "TERMINATED", timeout_seconds=180
                )
        except (RuntimeError, TimeoutError) as error:
            print(f"cleanup warning for {server.server_id}: {error}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        list(executor.map(terminate, servers))


def public_control_plane(server: Server) -> dict[str, Any]:
    return {
        "fresh": {
            "provision_to_running_ms": server.provision_to_running_ms,
            "provision_to_job_complete_ms": (
                server.provision_to_job_complete_ms
            ),
            "suspend_to_suspended_ms": (
                server.fresh_suspend_to_suspended_ms
            ),
        },
        "resumed_cycles": [
            server.cycles[cycle] for cycle in sorted(server.cycles)
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-arn", required=True)
    parser.add_argument("--image-version", required=True)
    parser.add_argument("--execution-role-arn", required=True)
    parser.add_argument("--log-group", required=True)
    parser.add_argument("--profile", default="HomesCollectorAdmin")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--server-count", type=int, default=10)
    parser.add_argument("--minimum-server-count", type=int, default=10)
    parser.add_argument("--cycles", type=int, default=5)
    parser.add_argument("--shell-workers", type=int, default=10)
    parser.add_argument(
        "--shell-readiness-delay-seconds", type=int, default=30
    )
    parser.add_argument("--maximum-duration-seconds", type=int, default=7200)
    parser.add_argument("--image-artifact-sha256")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.server_count < 1 or args.minimum_server_count < 1:
        parser.error("server counts must be positive")
    if args.minimum_server_count > args.server_count:
        parser.error("minimum server count cannot exceed server count")
    if args.cycles < 1:
        parser.error("cycles must be positive")

    aws = Aws(args.profile, args.region)
    run_id = uuid.uuid4().hex[:12]
    servers: list[Server] = []
    guest_results: dict[str, dict[str, Any]] = {}
    try:
        launch_servers(args, aws, run_id, servers)
        if len(servers) < args.minimum_server_count:
            raise RuntimeError(
                f"only {len(servers)} servers launched; "
                f"minimum is {args.minimum_server_count}"
            )
        print(f"{len(servers)} fresh servers running", flush=True)
        time.sleep(args.shell_readiness_delay_seconds)

        run_jobs(
            aws,
            servers,
            kind="fresh",
            cycle=0,
            workers=args.shell_workers,
        )
        suspend_servers(aws, servers, after_cycle=0, workers=5)
        print("fresh jobs complete; all servers suspended", flush=True)

        for cycle in range(1, args.cycles + 1):
            resume_servers(aws, servers, cycle=cycle, workers=5)
            print(f"all servers resumed for cycle {cycle}", flush=True)
            run_jobs(
                aws,
                servers,
                kind="resumed",
                cycle=cycle,
                workers=args.shell_workers,
            )
            if cycle == args.cycles:
                guest_results = fetch_guest_results(
                    aws, servers, args.shell_workers
                )
            suspend_servers(
                aws, servers, after_cycle=cycle, workers=5
            )
            print(
                f"resumed cycle {cycle} complete; all servers suspended",
                flush=True,
            )

        results: list[dict[str, Any]] = []
        for server in servers:
            value = guest_results[server.server_id]
            value["control_plane"] = public_control_plane(server)
            results.append(value)

        raw: dict[str, Any] = {
            "schema_version": 2,
            "created_at_unix_ms": time.time_ns() // 1_000_000,
            "run_id": run_id,
            "configuration": {
                "image_name": args.image_arn.rsplit(":", 1)[-1],
                "image_version": args.image_version,
                "region": args.region,
                "requested_server_count": args.server_count,
                "actual_server_count": len(servers),
                "requested_minimum_memory_mib": 2048,
                "resumed_cycles_per_server": args.cycles,
                "fresh_sample_count": len(servers),
                "resumed_sample_count": len(servers) * args.cycles,
            },
            "servers": sorted(results, key=lambda item: item["server_id"]),
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
