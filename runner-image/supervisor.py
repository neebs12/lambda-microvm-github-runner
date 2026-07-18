#!/usr/bin/env python3
"""Lifecycle supervisor for a single-use GitHub Actions runner MicroVM."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import pwd
import random
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import zlib
from dataclasses import dataclass
from enum import Enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from typing import Any, Callable

HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1"
MAX_HOOK_BODY_BYTES = 8_192
MAX_RUN_HOOK_PAYLOAD_BYTES = 4_096
MAX_JIT_CONFIG_BYTES = 1024 * 1024
MAX_CONTROL_BODY_BYTES = MAX_JIT_CONFIG_BYTES + 8_192
CONTAINERD_SOCKET = "/run/containerd/containerd.sock"


def log(message: str) -> None:
    print(f"[runner-supervisor] {message}", file=sys.stderr, flush=True)


@dataclass(frozen=True)
class Settings:
    hook_port: int = 9000
    control_port: int = 8080
    docker_dns: str = "169.254.169.253"
    docker_storage_driver: str = "overlay2"
    docker_start_attempts: int = 1
    docker_start_timeout: int = 50
    docker_log: Path = Path("/tmp/dockerd.log")
    runner_root: Path = Path("/opt/actions-runner")
    runner_user: str = "runner"
    validation_image: str = (
        "public.ecr.aws/docker/library/busybox:1.37.0"
    )
    aws_region: str | None = None

    @classmethod
    def from_environment(cls) -> Settings:
        return cls(
            hook_port=_integer_environment("HOOK_PORT", 9000, 1, 65_535),
            control_port=_integer_environment(
                "CONTROL_PORT", 8080, 1, 65_535
            ),
            docker_dns=os.environ.get("DOCKER_DNS", "169.254.169.253"),
            docker_storage_driver=os.environ.get(
                "DOCKER_STORAGE_DRIVER", "overlay2"
            ),
            docker_start_attempts=_integer_environment(
                "DOCKERD_START_ATTEMPTS", 1, 1, 10
            ),
            docker_start_timeout=_integer_environment(
                "DOCKERD_START_TIMEOUT", 50, 1, 300
            ),
            docker_log=Path(
                os.environ.get("DOCKER_LOG", "/tmp/dockerd.log")
            ),
            runner_root=Path(
                os.environ.get("RUNNER_ROOT", "/opt/actions-runner")
            ),
            runner_user=os.environ.get("RUNNER_USER", "runner"),
            validation_image=os.environ.get(
                "VALIDATION_IMAGE",
                "public.ecr.aws/docker/library/busybox:1.37.0",
            ),
            aws_region=(
                os.environ.get("AWS_REGION")
                or os.environ.get("AWS_DEFAULT_REGION")
            ),
        )


class DockerManager:
    def __init__(
        self,
        settings: Settings,
        *,
        run_command: Callable[..., subprocess.CompletedProcess[bytes]] = (
            subprocess.run
        ),
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.settings = settings
        self.run_command = run_command
        self.popen = popen
        self.clock = clock
        self.sleeper = sleeper
        self.process: subprocess.Popen[bytes] | None = None
        self.containerd_process: subprocess.Popen[bytes] | None = None
        self.lock = threading.RLock()

    def is_ready(self) -> bool:
        try:
            return (
                self.run_command(
                    ["docker", "info"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                ).returncode
                == 0
            )
        except (OSError, subprocess.TimeoutExpired):
            return False

    def storage_driver(self) -> str | None:
        try:
            result = self.run_command(
                ["docker", "info", "--format", "{{.Driver}}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode != 0:
            return None
        return result.stdout.decode("utf-8", errors="replace").strip()

    def start(self) -> bool:
        with self.lock:
            if self.is_ready():
                return self._driver_is_accepted()

            drivers = [self.settings.docker_storage_driver]
            if self.settings.docker_storage_driver != "vfs":
                drivers.append("vfs")

            for attempt in range(1, self.settings.docker_start_attempts + 1):
                for driver in drivers:
                    self._stop_process()
                    Path("/var/run").mkdir(parents=True, exist_ok=True)
                    Path("/run/containerd").mkdir(
                        parents=True, exist_ok=True
                    )
                    Path("/var/lib/docker").mkdir(
                        parents=True, exist_ok=True
                    )
                    Path("/var/run/docker.sock").unlink(missing_ok=True)
                    Path(CONTAINERD_SOCKET).unlink(missing_ok=True)

                    deadline = (
                        self.clock() + self.settings.docker_start_timeout
                    )
                    if not self._start_containerd(deadline):
                        self._log_tail()
                        continue

                    command = [
                        "dockerd",
                        "--host=unix:///var/run/docker.sock",
                        f"--containerd={CONTAINERD_SOCKET}",
                        f"--storage-driver={driver}",
                        "--exec-opt",
                        "native.cgroupdriver=cgroupfs",
                        "--dns",
                        self.settings.docker_dns,
                    ]
                    log(
                        "starting dockerd "
                        f"(driver={driver}, attempt={attempt})"
                    )
                    self.settings.docker_log.parent.mkdir(
                        parents=True, exist_ok=True
                    )
                    with self.settings.docker_log.open("ab") as output:
                        self.process = self.popen(
                            command,
                            stdout=output,
                            stderr=subprocess.STDOUT,
                        )

                    while self.clock() < deadline:
                        if self.is_ready():
                            if self._driver_is_accepted():
                                log(f"dockerd ready (driver={driver})")
                                return True
                            self._log_tail()
                            break
                        if (
                            self.process is not None
                            and self.process.poll() is not None
                        ):
                            log(
                                "dockerd exited before becoming ready "
                                f"(status={self.process.poll()})"
                            )
                            self._log_tail()
                            break
                        self.sleeper(1)
                    else:
                        log("dockerd readiness timed out")
                        self._log_tail()

                if attempt < self.settings.docker_start_attempts:
                    self.sleeper(3)

            self._stop_process()
            return False

    def stop(self) -> None:
        with self.lock:
            self._stop_process()

    def _start_containerd(self, deadline: float) -> bool:
        command = [
            "containerd",
            "--address",
            CONTAINERD_SOCKET,
            "--log-level",
            "warn",
        ]
        log("starting containerd")
        with self.settings.docker_log.open("ab") as output:
            self.containerd_process = self.popen(
                command,
                stdout=output,
                stderr=subprocess.STDOUT,
            )

        while self.clock() < deadline:
            try:
                result = self.run_command(
                    ["ctr", "--address", CONTAINERD_SOCKET, "version"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
                if result.returncode == 0:
                    log("containerd ready")
                    return True
            except (OSError, subprocess.TimeoutExpired):
                pass
            if (
                self.containerd_process is not None
                and self.containerd_process.poll() is not None
            ):
                log(
                    "containerd exited before becoming ready "
                    f"(status={self.containerd_process.poll()})"
                )
                return False
            self.sleeper(1)
        log("containerd readiness timed out")
        return False

    def _driver_is_accepted(self) -> bool:
        driver = self.storage_driver()
        return driver in (self.settings.docker_storage_driver, "vfs")

    def _stop_process(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None
        if (
            self.containerd_process is not None
            and self.containerd_process.poll() is None
        ):
            self.containerd_process.terminate()
            try:
                self.containerd_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.containerd_process.kill()
                self.containerd_process.wait(timeout=5)
        self.containerd_process = None

    def _log_tail(self, lines: int = 40) -> None:
        try:
            tail = self.settings.docker_log.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines()[-lines:]
        except OSError:
            log("dockerd log tail is unavailable")
            return
        for line in tail:
            log(f"dockerd | {line[:1_000]}")


class RunnerLauncher:
    def __init__(
        self,
        settings: Settings,
        *,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    ) -> None:
        self.settings = settings
        self.popen = popen

    def launch(self, encoded_jit_config: str) -> subprocess.Popen[bytes]:
        account = pwd.getpwnam(self.settings.runner_user)
        command = [
            str(self.settings.runner_root / "run.sh"),
            "--jitconfig",
            encoded_jit_config,
        ]
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": f"/home/{self.settings.runner_user}",
                "RUNNER_TEMP": "/tmp/runner",
                "RUNNER_TOOL_CACHE": "/opt/hostedtoolcache",
            }
        )
        process = self.popen(
            command,
            cwd=self.settings.runner_root,
            env=environment,
            start_new_session=True,
            user=account.pw_uid,
            group=account.pw_gid,
            extra_groups=os.getgrouplist(
                self.settings.runner_user, account.pw_gid
            ),
        )
        process.args = [
            str(self.settings.runner_root / "run.sh"),
            "--jitconfig",
            "***",
        ]
        return process


class SelfTerminator:
    def __init__(
        self,
        settings: Settings,
        *,
        run_command: Callable[..., subprocess.CompletedProcess[bytes]] = (
            subprocess.run
        ),
        sleeper: Callable[[float], None] = time.sleep,
        random_source: Callable[[], float] = random.random,
    ) -> None:
        self.settings = settings
        self.run_command = run_command
        self.sleeper = sleeper
        self.random_source = random_source

    def terminate(self, microvm_id: str, region: str | None = None) -> bool:
        command = [
            "aws",
            "lambda-microvms",
            "terminate-microvm",
            "--microvm-identifier",
            microvm_id,
        ]
        selected_region = region or self.settings.aws_region
        if selected_region:
            command.extend(["--region", selected_region])

        for attempt in range(5):
            try:
                result = self.run_command(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=15,
                    check=False,
                )
                if result.returncode == 0:
                    log("self-termination accepted")
                    return True
            except (OSError, subprocess.TimeoutExpired):
                pass
            if attempt < 4:
                cap = min(8.0, float(2**attempt))
                self.sleeper(self.random_source() * cap)

        log("self-termination did not complete; external cleanup remains active")
        return False


class RunnerState(str, Enum):
    SNAPSHOTTED = "SNAPSHOTTED"
    IDLE = "IDLE"
    STARTING_DOCKER = "STARTING_DOCKER"
    STARTING_RUNNER = "STARTING_RUNNER"
    RUNNING = "RUNNING"
    SUSPENDING = "SUSPENDING"
    SUSPENDED = "SUSPENDED"
    RESUMING = "RESUMING"
    TERMINATING = "TERMINATING"
    FAILED = "FAILED"


class RunnerSupervisor:
    def __init__(
        self,
        docker: DockerManager,
        launcher: RunnerLauncher,
        terminator: SelfTerminator,
    ) -> None:
        self.docker = docker
        self.launcher = launcher
        self.terminator = terminator
        self.lock = threading.RLock()
        self.state = RunnerState.SNAPSHOTTED
        self.microvm_id: str | None = None
        self.runner_process: subprocess.Popen[bytes] | None = None
        self.external_termination = False
        self.warm_mode = False
        self.aws_region: str | None = None
        self.last_request_id: str | None = None
        self.last_request_fingerprint: str | None = None
        self.last_request_succeeded = False

    def run(self, payload: dict[str, Any]) -> bool:
        try:
            microvm_id, encoded_jit_config, aws_region, warm_mode = parse_run_payload(
                payload
            )
        except ValueError:
            log("run hook payload is invalid")
            return False

        with self.lock:
            if self.state in {
                RunnerState.STARTING_DOCKER,
                RunnerState.STARTING_RUNNER,
                RunnerState.RUNNING,
            }:
                return self.microvm_id == microvm_id
            if self.state == RunnerState.TERMINATING:
                return False
            self.state = RunnerState.STARTING_DOCKER
            self.microvm_id = microvm_id
            self.aws_region = aws_region
            self.warm_mode = warm_mode
            self.external_termination = False

        if not self.docker.start():
            self._fail_start(
                microvm_id, aws_region, "docker startup failed"
            )
            return False

        if warm_mode:
            with self.lock:
                self.state = RunnerState.IDLE
            log(f"warm supervisor ready (microvm={microvm_id})")
            return True

        assert encoded_jit_config is not None
        return self._start_runner(encoded_jit_config, None)

    def start_runner(self, payload: dict[str, Any]) -> bool:
        try:
            request_id, microvm_id, encoded_jit_config = (
                parse_control_payload(payload)
            )
        except ValueError:
            log("control request is invalid")
            return False

        fingerprint = hashlib.sha256(
            (microvm_id + "\0" + encoded_jit_config).encode("utf-8")
        ).hexdigest()
        with self.lock:
            if not self.warm_mode or self.microvm_id != microvm_id:
                return False
            if self.last_request_id == request_id:
                return (
                    self.last_request_fingerprint == fingerprint
                    and self.last_request_succeeded
                )
            if self.state != RunnerState.IDLE:
                return False
            self.last_request_id = request_id
            self.last_request_fingerprint = fingerprint
            self.last_request_succeeded = False
            self.state = RunnerState.STARTING_RUNNER

        succeeded = self._start_runner(encoded_jit_config, request_id)
        with self.lock:
            self.last_request_succeeded = succeeded
        return succeeded

    def _start_runner(
        self, encoded_jit_config: str, request_id: str | None
    ) -> bool:
        with self.lock:
            microvm_id = self.microvm_id
            aws_region = self.aws_region
        if microvm_id is None:
            return False

        try:
            process = self.launcher.launch(encoded_jit_config)
        except OSError:
            self._fail_start(
                microvm_id, aws_region, "runner spawn failed"
            )
            return False
        finally:
            encoded_jit_config = ""

        if process.poll() is not None:
            self._fail_start(
                microvm_id, aws_region, "runner exited during startup"
            )
            return False

        with self.lock:
            self.runner_process = process
            self.state = RunnerState.RUNNING
            watcher = threading.Thread(
                target=self._watch_runner,
                args=(process, microvm_id, aws_region, request_id),
                name="runner-watcher",
                daemon=True,
            )
            watcher.start()
        log(f"runner started (microvm={microvm_id})")
        return True

    def resume(self) -> bool:
        with self.lock:
            if not self.warm_mode:
                process = self.runner_process
                if (
                    self.state != RunnerState.RUNNING
                    or process is None
                    or process.poll() is not None
                ):
                    return False
                return self.docker.is_ready() or self.docker.start()
            if self.state not in {
                RunnerState.SUSPENDING,
                RunnerState.SUSPENDED,
            }:
                return False
            self.state = RunnerState.RESUMING
        ready = self.docker.is_ready() or self.docker.start()
        with self.lock:
            self.state = RunnerState.IDLE if ready else RunnerState.FAILED
        return ready

    def suspend(self) -> bool:
        with self.lock:
            if not self.warm_mode or self.state != RunnerState.IDLE:
                return False
            self.state = RunnerState.SUSPENDING
        self.docker.stop()
        os.sync()
        sys.stderr.flush()
        with self.lock:
            self.state = RunnerState.SUSPENDED
        return True

    def terminate(self) -> None:
        with self.lock:
            self.external_termination = True
            self.state = RunnerState.TERMINATING
            process = self.runner_process
        if process is not None:
            _stop_process_group(process)
        self.docker.stop()
        sys.stderr.flush()

    def shutdown(self) -> None:
        self.terminate()

    def _watch_runner(
        self,
        process: subprocess.Popen[bytes],
        microvm_id: str,
        aws_region: str | None,
        request_id: str | None,
    ) -> None:
        exit_code = process.wait()
        process.args = ["runner", "***"]
        log(f"runner exited (status={exit_code})")
        with self.lock:
            self.runner_process = None
            if self.warm_mode and not self.external_termination:
                self.state = RunnerState.IDLE
                should_self_terminate = False
            else:
                self.state = RunnerState.TERMINATING
                should_self_terminate = not self.external_termination
        if not self.warm_mode:
            self.docker.stop()
        if should_self_terminate:
            self.terminator.terminate(microvm_id, aws_region)
        elif request_id is not None:
            log(f"warm runner complete (request={request_id[:12]})")

    def _fail_start(
        self, microvm_id: str, aws_region: str | None, reason: str
    ) -> None:
        log(reason)
        self.docker.stop()
        with self.lock:
            self.state = RunnerState.FAILED
        thread = threading.Thread(
            target=self.terminator.terminate,
            args=(microvm_id, aws_region),
            name="failed-start-terminator",
            daemon=True,
        )
        thread.start()


class ValidationState(str, Enum):
    NOT_STARTED = "NOT_STARTED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


class ValidationManager:
    def __init__(self, validate: Callable[[], bool]) -> None:
        self.validate = validate
        self.state = ValidationState.NOT_STARTED
        self.lock = threading.Lock()

    def status(self) -> ValidationState:
        with self.lock:
            if self.state == ValidationState.NOT_STARTED:
                self.state = ValidationState.RUNNING
                threading.Thread(
                    target=self._execute,
                    name="image-validation",
                    daemon=True,
                ).start()
            return self.state

    def _execute(self) -> None:
        try:
            succeeded = self.validate()
        except Exception:  # noqa: BLE001 - never expose validation internals
            succeeded = False
        with self.lock:
            self.state = (
                ValidationState.SUCCEEDED
                if succeeded
                else ValidationState.FAILED
            )


class HookApplication:
    def __init__(
        self,
        settings: Settings,
        docker: DockerManager,
        supervisor: RunnerSupervisor,
        validation: ValidationManager,
        *,
        run_command: Callable[..., subprocess.CompletedProcess[bytes]] = (
            subprocess.run
        ),
    ) -> None:
        self.settings = settings
        self.docker = docker
        self.supervisor = supervisor
        self.validation = validation
        self.run_command = run_command

    def handle(
        self, hook: str, payload: dict[str, Any]
    ) -> tuple[int, str]:
        if hook == "ready":
            ready = self._ready()
            return (200, "ready") if ready else (503, "not ready")
        if hook == "validate":
            state = self.validation.status()
            if state == ValidationState.SUCCEEDED:
                return 200, "validation succeeded"
            if state == ValidationState.FAILED:
                return 503, "validation failed"
            return 503, "validation running"
        if hook == "run":
            ready = self.supervisor.run(payload)
            return (
                (200, "runner started")
                if ready
                else (503, "runner failed to start")
            )
        if hook == "resume":
            ready = self.supervisor.resume()
            return (
                (200, "runner healthy")
                if ready
                else (503, "runner unhealthy")
            )
        if hook == "suspend":
            return (
                (200, "suspended")
                if self.supervisor.suspend()
                else (503, "suspend failed")
            )
        if hook == "terminate":
            self.supervisor.terminate()
            return 200, "terminated"
        return 404, "unknown hook"

    def validate_image(self) -> bool:
        if not self.docker.start():
            return False
        commands = [
            ["getent", "hosts", "registry-1.docker.io"],
            ["docker", "run", "--rm", self.settings.validation_image, "true"],
        ]
        for command in commands:
            try:
                result = self.run_command(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=120,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                return False
            if result.returncode != 0:
                return False
        return True

    def _ready(self) -> bool:
        required = [
            "docker",
            "dockerd",
            "git",
            "gzip",
            "aws",
        ]
        if any(shutil.which(command) is None for command in required):
            return False
        if not (self.settings.runner_root / "run.sh").is_file():
            return False
        if self.docker.is_ready():
            log("ready hook rejected an image with dockerd already running")
            return False
        checks = [
            ["docker", "buildx", "version"],
            ["docker", "compose", "version"],
        ]
        for command in checks:
            try:
                result = self.run_command(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                return False
            if result.returncode != 0:
                return False
        return True


class HookServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self) -> None:
        # HTTPServer performs a reverse-DNS lookup while binding. Lifecycle
        # startup must not depend on external DNS latency.
        TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


class Hooks(BaseHTTPRequestHandler):
    application: HookApplication

    def log_message(self, *_args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/healthz":
            self._send_result(200, "ok")
        else:
            self._send_result(404, "unknown path")

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if not path.startswith(f"{HOOK_PREFIX}/"):
            self._send_result(404, "unknown path")
            return
        hook = path.removeprefix(HOOK_PREFIX).strip("/")
        try:
            payload = self._read_payload(allow_missing=hook != "run")
        except ValueError:
            self._send_result(400, "invalid request")
            return
        log(f"/{hook} hook")
        status, message = self.application.handle(hook, payload)
        self._send_result(status, message)

    def _read_payload(self, *, allow_missing: bool = False) -> dict[str, Any]:
        content_length_text = self.headers.get("Content-Length")
        if content_length_text is None and allow_missing:
            return {}
        if content_length_text is None or not content_length_text.isdigit():
            raise ValueError("invalid content length")
        content_length = int(content_length_text)
        if content_length > MAX_HOOK_BODY_BYTES:
            raise ValueError("body too large")
        raw_body = self.rfile.read(content_length)
        if len(raw_body) != content_length:
            raise ValueError("incomplete body")
        if not raw_body:
            return {}
        try:
            payload = json.loads(raw_body)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("invalid json") from error
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return payload

    def _send_result(self, status: int, message: str) -> None:
        body = f"{message}\n".encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ControlApplication:
    def __init__(self, supervisor: RunnerSupervisor) -> None:
        self.supervisor = supervisor

    def start_runner(self, payload: dict[str, Any]) -> tuple[int, str]:
        return (
            (202, "runner accepted")
            if self.supervisor.start_runner(payload)
            else (409, "runner rejected")
        )


class Control(BaseHTTPRequestHandler):
    application: ControlApplication

    def log_message(self, *_args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/healthz":
            self._send_result(200, "ok")
        else:
            self._send_result(404, "unknown path")

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/v1/runner/start":
            self._send_result(404, "unknown path")
            return
        try:
            payload = self._read_payload()
        except ValueError:
            self._send_result(400, "invalid request")
            return
        status, message = self.application.start_runner(payload)
        self._send_result(status, message)

    def _read_payload(self) -> dict[str, Any]:
        content_length_text = self.headers.get("Content-Length")
        if content_length_text is None or not content_length_text.isdigit():
            raise ValueError("invalid content length")
        content_length = int(content_length_text)
        if content_length < 1 or content_length > MAX_CONTROL_BODY_BYTES:
            raise ValueError("invalid body size")
        raw_body = self.rfile.read(content_length)
        if len(raw_body) != content_length:
            raise ValueError("incomplete body")
        try:
            payload = json.loads(raw_body)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("invalid json") from error
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return payload

    def _send_result(self, status: int, message: str) -> None:
        body = f"{message}\n".encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def parse_run_payload(
    payload: dict[str, Any],
) -> tuple[str, str | None, str | None, bool]:
    microvm_id = payload.get("microvmId")
    run_hook_payload = payload.get("runHookPayload")
    if (
        not isinstance(microvm_id, str)
        or not microvm_id
        or len(microvm_id) > 256
        or any(character.isspace() for character in microvm_id)
        or not isinstance(run_hook_payload, str)
    ):
        raise ValueError("invalid run payload")
    encoded_jit_config, aws_region, warm_mode = decode_run_hook_payload(
        run_hook_payload
    )
    return microvm_id, encoded_jit_config, aws_region, warm_mode


def decode_run_hook_payload(
    payload: str,
) -> tuple[str | None, str | None, bool]:
    value = decode_jit_payload(payload)
    try:
        envelope = json.loads(value)
    except json.JSONDecodeError:
        return value, None, False
    if not isinstance(envelope, dict):
        return value, None, False
    if envelope.get("version") == 2 and envelope.get("mode") == "warm":
        aws_region = envelope.get("region")
        if (
            not isinstance(aws_region, str)
            or re.fullmatch(
                r"[a-z]{2}(?:-[a-z0-9]+)+-\d", aws_region
            )
            is None
        ):
            raise ValueError("invalid warm run hook envelope")
        return None, aws_region, True
    if envelope.get("version") != 1:
        return value, None, False
    encoded_jit_config = envelope.get("jit")
    aws_region = envelope.get("region")
    if (
        not isinstance(encoded_jit_config, str)
        or not encoded_jit_config
        or not isinstance(aws_region, str)
        or re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-\d", aws_region) is None
    ):
        raise ValueError("invalid run hook envelope")
    return encoded_jit_config, aws_region, False


def parse_control_payload(
    payload: dict[str, Any],
) -> tuple[str, str, str]:
    if payload.get("version") != 1:
        raise ValueError("unsupported control version")
    request_id = payload.get("requestId")
    microvm_id = payload.get("microvmId")
    encoded_jit_config = payload.get("jit")
    for value in (request_id, microvm_id):
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 256
            or any(character.isspace() for character in value)
        ):
            raise ValueError("invalid control identity")
    if (
        not isinstance(encoded_jit_config, str)
        or not encoded_jit_config
        or len(encoded_jit_config.encode("utf-8")) > MAX_JIT_CONFIG_BYTES
    ):
        raise ValueError("invalid JIT configuration")
    return request_id, microvm_id, encoded_jit_config


def decode_jit_payload(payload: str) -> str:
    if not payload or len(payload.encode("utf-8")) > MAX_RUN_HOOK_PAYLOAD_BYTES:
        raise ValueError("invalid payload size")
    try:
        compressed = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("invalid payload encoding") from error

    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        decoded = decompressor.decompress(
            compressed, MAX_JIT_CONFIG_BYTES + 1
        )
    except zlib.error as error:
        raise ValueError("invalid compressed payload") from error
    if (
        len(decoded) > MAX_JIT_CONFIG_BYTES
        or not decompressor.eof
        or decompressor.unused_data
        or decompressor.unconsumed_tail
    ):
        raise ValueError("invalid decompressed payload")
    try:
        value = decoded.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("invalid payload text") from error
    if not value:
        raise ValueError("empty JIT configuration")
    return value


def create_application(settings: Settings) -> HookApplication:
    docker = DockerManager(settings)
    launcher = RunnerLauncher(settings)
    terminator = SelfTerminator(settings)
    supervisor = RunnerSupervisor(docker, launcher, terminator)
    application: HookApplication
    application = HookApplication(
        settings,
        docker,
        supervisor,
        ValidationManager(lambda: application.validate_image()),
    )
    return application


def _stop_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass


def _integer_environment(
    name: str, default: int, minimum: int, maximum: int
) -> int:
    value = os.environ.get(name, str(default))
    try:
        parsed = int(value)
    except ValueError as error:
        raise SystemExit(f"{name} must be an integer") from error
    if parsed < minimum or parsed > maximum:
        raise SystemExit(f"{name} is outside the accepted range")
    return parsed


def main() -> None:
    settings = Settings.from_environment()
    application = create_application(settings)
    Hooks.application = application
    Control.application = ControlApplication(application.supervisor)

    def shutdown(signum: int, _frame: object) -> None:
        log(f"received signal {signum}; shutting down")
        application.supervisor.shutdown()
        raise SystemExit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    control_server = HookServer(
        ("0.0.0.0", settings.control_port), Control
    )
    threading.Thread(
        target=control_server.serve_forever,
        name="control-server",
        daemon=True,
    ).start()
    log(f"control server listening on 0.0.0.0:{settings.control_port}")
    log(f"lifecycle server listening on 0.0.0.0:{settings.hook_port}")
    try:
        HookServer(("0.0.0.0", settings.hook_port), Hooks).serve_forever()
    finally:
        control_server.shutdown()
        control_server.server_close()


if __name__ == "__main__":
    main()
