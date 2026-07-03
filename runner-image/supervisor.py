#!/usr/bin/env python3
"""Lifecycle supervisor for a single-use GitHub Actions runner MicroVM."""

from __future__ import annotations

import base64
import binascii
import json
import os
import pwd
import random
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


def log(message: str) -> None:
    print(f"[runner-supervisor] {message}", file=sys.stderr, flush=True)


@dataclass(frozen=True)
class Settings:
    hook_port: int = 9000
    docker_dns: str = "169.254.169.253"
    docker_storage_driver: str = "overlay2"
    docker_start_attempts: int = 2
    docker_start_timeout: int = 20
    allow_vfs_fallback: bool = False
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
            docker_dns=os.environ.get("DOCKER_DNS", "169.254.169.253"),
            docker_storage_driver=os.environ.get(
                "DOCKER_STORAGE_DRIVER", "overlay2"
            ),
            docker_start_attempts=_integer_environment(
                "DOCKERD_START_ATTEMPTS", 2, 1, 10
            ),
            docker_start_timeout=_integer_environment(
                "DOCKERD_START_TIMEOUT", 20, 1, 300
            ),
            allow_vfs_fallback=_boolean_environment(
                "ALLOW_VFS_FALLBACK", False
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
            if (
                self.settings.allow_vfs_fallback
                and self.settings.docker_storage_driver != "vfs"
            ):
                drivers.append("vfs")

            for attempt in range(1, self.settings.docker_start_attempts + 1):
                for driver in drivers:
                    self._stop_process()
                    Path("/var/run").mkdir(parents=True, exist_ok=True)
                    Path("/var/lib/docker").mkdir(
                        parents=True, exist_ok=True
                    )
                    Path("/var/run/docker.sock").unlink(missing_ok=True)

                    command = [
                        "dockerd",
                        "--host=unix:///var/run/docker.sock",
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

                    deadline = (
                        self.clock() + self.settings.docker_start_timeout
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
                            log("dockerd exited before becoming ready")
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

    def _driver_is_accepted(self) -> bool:
        driver = self.storage_driver()
        return driver == self.settings.docker_storage_driver or (
            self.settings.allow_vfs_fallback and driver == "vfs"
        )

    def _stop_process(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None

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

    def terminate(self, microvm_id: str) -> bool:
        command = [
            "aws",
            "lambda-microvms",
            "terminate-microvm",
            "--microvm-identifier",
            microvm_id,
        ]
        if self.settings.aws_region:
            command.extend(["--region", self.settings.aws_region])

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
    STARTING_DOCKER = "STARTING_DOCKER"
    STARTING_RUNNER = "STARTING_RUNNER"
    RUNNING = "RUNNING"
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

    def run(self, payload: dict[str, Any]) -> bool:
        try:
            microvm_id, encoded_jit_config = parse_run_payload(payload)
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
            self.external_termination = False

        if not self.docker.start():
            self._fail_start(microvm_id, "docker startup failed")
            return False

        with self.lock:
            self.state = RunnerState.STARTING_RUNNER

        try:
            process = self.launcher.launch(encoded_jit_config)
        except OSError:
            self._fail_start(microvm_id, "runner spawn failed")
            return False
        finally:
            encoded_jit_config = ""

        if process.poll() is not None:
            self._fail_start(microvm_id, "runner exited during startup")
            return False

        with self.lock:
            self.runner_process = process
            self.state = RunnerState.RUNNING
            watcher = threading.Thread(
                target=self._watch_runner,
                args=(process, microvm_id),
                name="runner-watcher",
                daemon=True,
            )
            watcher.start()
        log(f"runner started (microvm={microvm_id})")
        return True

    def resume(self) -> bool:
        with self.lock:
            process = self.runner_process
            if (
                self.state != RunnerState.RUNNING
                or process is None
                or process.poll() is not None
            ):
                return False
        return self.docker.is_ready() or self.docker.start()

    def suspend(self) -> bool:
        sys.stderr.flush()
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
        self, process: subprocess.Popen[bytes], microvm_id: str
    ) -> None:
        exit_code = process.wait()
        process.args = ["runner", "***"]
        log(f"runner exited (status={exit_code})")
        self.docker.stop()
        with self.lock:
            self.state = RunnerState.TERMINATING
            should_self_terminate = not self.external_termination
        if should_self_terminate:
            self.terminator.terminate(microvm_id)

    def _fail_start(self, microvm_id: str, reason: str) -> None:
        log(reason)
        self.docker.stop()
        with self.lock:
            self.state = RunnerState.FAILED
        thread = threading.Thread(
            target=self.terminator.terminate,
            args=(microvm_id,),
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
        if (
            not self.settings.allow_vfs_fallback
            and self.docker.storage_driver()
            != self.settings.docker_storage_driver
        ):
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
            payload = self._read_payload()
        except ValueError:
            self._send_result(400, "invalid request")
            return
        log(f"/{hook} hook")
        status, message = self.application.handle(hook, payload)
        self._send_result(status, message)

    def _read_payload(self) -> dict[str, Any]:
        content_length_text = self.headers.get("Content-Length")
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


def parse_run_payload(payload: dict[str, Any]) -> tuple[str, str]:
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
    return microvm_id, decode_jit_payload(run_hook_payload)


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


def _boolean_environment(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    if value == "true":
        return True
    if value == "false":
        return False
    raise SystemExit(f"{name} must be 'true' or 'false'")


def main() -> None:
    settings = Settings.from_environment()
    application = create_application(settings)
    Hooks.application = application

    def shutdown(signum: int, _frame: object) -> None:
        log(f"received signal {signum}; shutting down")
        application.supervisor.shutdown()
        raise SystemExit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    log(f"lifecycle server listening on 0.0.0.0:{settings.hook_port}")
    HookServer(("0.0.0.0", settings.hook_port), Hooks).serve_forever()


if __name__ == "__main__":
    main()
