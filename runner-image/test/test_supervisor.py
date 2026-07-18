from __future__ import annotations

import base64
import gzip
import http.client
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import supervisor  # noqa: E402


def encoded_payload(value: str) -> str:
    return base64.b64encode(gzip.compress(value.encode("utf-8"))).decode(
        "ascii"
    )


class FakeRunnerProcess:
    def __init__(self) -> None:
        self.pid = 123_456
        self.args: list[str] = ["runner", "secret"]
        self._exit_code: int | None = None
        self._exited = threading.Event()

    def poll(self) -> int | None:
        return self._exit_code

    def wait(self, timeout: float | None = None) -> int:
        if not self._exited.wait(timeout):
            raise subprocess.TimeoutExpired("runner", timeout)
        assert self._exit_code is not None
        return self._exit_code

    def finish(self, exit_code: int) -> None:
        self._exit_code = exit_code
        self._exited.set()


class FakeDockerProcess:
    def __init__(self, exited: bool) -> None:
        self.returncode = 1 if exited else None
        self.args: list[str] = []

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 143

    def kill(self) -> None:
        self.returncode = 137

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        return self.returncode or 0


class FakeDocker:
    def __init__(
        self,
        *,
        starts: bool = True,
        ready: bool = True,
        driver: str = "overlay2",
    ) -> None:
        self.starts = starts
        self.ready = ready
        self.driver = driver
        self.start_calls = 0
        self.stop_calls = 0

    def start(self) -> bool:
        self.start_calls += 1
        self.ready = self.starts
        return self.starts

    def stop(self) -> None:
        self.stop_calls += 1
        self.ready = False

    def is_ready(self) -> bool:
        return self.ready

    def storage_driver(self) -> str:
        return self.driver


class FakeLauncher:
    def __init__(
        self,
        process: FakeRunnerProcess | None = None,
        *,
        fail: bool = False,
    ) -> None:
        self.process = process or FakeRunnerProcess()
        self.fail = fail
        self.values: list[str] = []

    def launch(self, value: str) -> FakeRunnerProcess:
        self.values.append(value)
        if self.fail:
            raise OSError("spawn details")
        return self.process


class FakeTerminator:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.called = threading.Event()

    def terminate(
        self, microvm_id: str, _region: str | None = None
    ) -> bool:
        self.calls.append(microvm_id)
        self.called.set()
        return True


class PayloadTests(unittest.TestCase):
    def test_payload_round_trip(self) -> None:
        secret = "encoded-jit-secret"
        self.assertEqual(
            supervisor.decode_jit_payload(encoded_payload(secret)), secret
        )
        self.assertEqual(
            supervisor.parse_run_payload(
                {
                    "microvmId": "mvm-123",
                    "runHookPayload": encoded_payload(secret),
                }
            ),
            ("mvm-123", secret, None, False),
        )

    def test_versioned_payload_includes_termination_region(self) -> None:
        envelope = json.dumps(
            {"version": 1, "jit": "jit-secret", "region": "us-east-1"}
        )
        self.assertEqual(
            supervisor.decode_run_hook_payload(encoded_payload(envelope)),
            ("jit-secret", "us-east-1", False),
        )

    def test_warm_payload_starts_idle_without_jit(self) -> None:
        envelope = json.dumps(
            {"version": 2, "mode": "warm", "region": "us-east-1"}
        )
        self.assertEqual(
            supervisor.parse_run_payload(
                {
                    "microvmId": "mvm-warm",
                    "runHookPayload": encoded_payload(envelope),
                }
            ),
            ("mvm-warm", None, "us-east-1", True),
        )

    def test_payload_rejects_invalid_and_oversized_values(self) -> None:
        invalid_values = [
            "",
            "not base64!",
            "A" * (supervisor.MAX_RUN_HOOK_PAYLOAD_BYTES + 1),
            base64.b64encode(b"not gzip").decode("ascii"),
            encoded_payload(
                "A" * (supervisor.MAX_JIT_CONFIG_BYTES + 1)
            ),
        ]
        for value in invalid_values:
            with self.subTest(length=len(value)):
                with self.assertRaises(ValueError):
                    supervisor.decode_jit_payload(value)

    def test_payload_errors_do_not_contain_input(self) -> None:
        secret = "invalid secret payload!"
        with self.assertRaises(ValueError) as context:
            supervisor.decode_jit_payload(secret)
        self.assertNotIn(secret, str(context.exception))


class DockerManagerTests(unittest.TestCase):
    def test_vfs_fallback_is_always_available(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            active_driver: str | None = None
            drivers: list[str] = []

            def popen(
                command: list[str], **_kwargs: object
            ) -> FakeDockerProcess:
                nonlocal active_driver
                if command[0] == "containerd":
                    return FakeDockerProcess(exited=False)
                active_driver = next(
                    value.split("=", 1)[1]
                    for value in command
                    if value.startswith("--storage-driver=")
                )
                drivers.append(active_driver)
                return FakeDockerProcess(
                    exited=active_driver == "overlay2"
                )

            def run_command(
                command: list[str], **_kwargs: object
            ) -> subprocess.CompletedProcess[bytes]:
                if command[0] == "ctr":
                    return subprocess.CompletedProcess(command, 0)
                if "--format" in command:
                    return subprocess.CompletedProcess(
                        command,
                        0,
                        stdout=(active_driver or "").encode(),
                    )
                return subprocess.CompletedProcess(
                    command,
                    0 if active_driver == "vfs" else 1,
                )

            manager = supervisor.DockerManager(
                supervisor.Settings(
                    docker_start_attempts=1,
                    docker_log=Path(directory) / "dockerd.log",
                ),
                run_command=run_command,
                popen=popen,  # type: ignore[arg-type]
                sleeper=lambda _seconds: None,
            )
            with (
                patch.object(Path, "mkdir"),
                patch.object(Path, "unlink"),
            ):
                self.assertTrue(manager.start())
            self.assertEqual(drivers, ["overlay2", "vfs"])

    def test_log_tail_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "dockerd.log"
            log_path.write_text(
                "\n".join(f"line-{number}" for number in range(100)),
                encoding="utf-8",
            )
            manager = supervisor.DockerManager(
                supervisor.Settings(docker_log=log_path)
            )
            messages: list[str] = []
            with patch.object(supervisor, "log", side_effect=messages.append):
                manager._log_tail()  # noqa: SLF001
            self.assertEqual(len(messages), 40)
            self.assertIn("line-99", messages[-1])


class RunnerSupervisorTests(unittest.TestCase):
    def test_warm_runner_returns_idle_and_survives_suspend_resume(self) -> None:
        first_process = FakeRunnerProcess()
        docker = FakeDocker(ready=False)
        launcher = FakeLauncher(first_process)
        terminator = FakeTerminator()
        runner = supervisor.RunnerSupervisor(
            docker, launcher, terminator
        )
        warm_envelope = json.dumps(
            {"version": 2, "mode": "warm", "region": "us-east-1"}
        )

        self.assertTrue(
            runner.run(
                {
                    "microvmId": "mvm-warm",
                    "runHookPayload": encoded_payload(warm_envelope),
                }
            )
        )
        self.assertEqual(runner.state, supervisor.RunnerState.IDLE)
        request = {
            "version": 1,
            "requestId": "request-1",
            "microvmId": "mvm-warm",
            "jit": "jit-first",
        }
        self.assertTrue(runner.start_runner(request))
        self.assertTrue(runner.start_runner(request))
        self.assertEqual(launcher.values, ["jit-first"])
        self.assertFalse(runner.suspend())

        first_process.finish(0)
        for _attempt in range(100):
            if runner.state == supervisor.RunnerState.IDLE:
                break
            time.sleep(0.01)
        self.assertEqual(runner.state, supervisor.RunnerState.IDLE)
        self.assertEqual(terminator.calls, [])
        self.assertTrue(runner.suspend())
        self.assertEqual(runner.state, supervisor.RunnerState.SUSPENDED)
        self.assertTrue(runner.resume())
        self.assertEqual(runner.state, supervisor.RunnerState.IDLE)

        second_process = FakeRunnerProcess()
        launcher.process = second_process
        self.assertTrue(
            runner.start_runner(
                {
                    "version": 1,
                    "requestId": "request-2",
                    "microvmId": "mvm-warm",
                    "jit": "jit-second",
                }
            )
        )
        second_process.finish(0)
        for _attempt in range(100):
            if runner.state == supervisor.RunnerState.IDLE:
                break
            time.sleep(0.01)
        self.assertEqual(launcher.values, ["jit-first", "jit-second"])
        self.assertEqual(terminator.calls, [])

    def test_warm_control_rejects_reused_request_with_new_jit(self) -> None:
        process = FakeRunnerProcess()
        runner = supervisor.RunnerSupervisor(
            FakeDocker(), FakeLauncher(process), FakeTerminator()
        )
        envelope = json.dumps(
            {"version": 2, "mode": "warm", "region": "us-east-1"}
        )
        self.assertTrue(
            runner.run(
                {
                    "microvmId": "mvm-warm",
                    "runHookPayload": encoded_payload(envelope),
                }
            )
        )
        first = {
            "version": 1,
            "requestId": "request-1",
            "microvmId": "mvm-warm",
            "jit": "jit-first",
        }
        self.assertTrue(runner.start_runner(first))
        self.assertFalse(runner.start_runner({**first, "jit": "jit-other"}))
        process.finish(0)

    def test_duplicate_run_starts_exactly_one_runner(self) -> None:
        process = FakeRunnerProcess()
        docker = FakeDocker()
        launcher = FakeLauncher(process)
        terminator = FakeTerminator()
        runner = supervisor.RunnerSupervisor(
            docker, launcher, terminator
        )
        payload = {
            "microvmId": "mvm-1",
            "runHookPayload": encoded_payload("jit-secret"),
        }

        self.assertTrue(runner.run(payload))
        self.assertTrue(runner.run(payload))
        self.assertEqual(launcher.values, ["jit-secret"])
        self.assertEqual(docker.start_calls, 1)

        process.finish(0)
        self.assertTrue(terminator.called.wait(1))
        self.assertEqual(terminator.calls, ["mvm-1"])
        self.assertEqual(process.args, ["runner", "***"])

    def test_runner_success_and_failure_both_self_terminate(self) -> None:
        for exit_code in [0, 1]:
            with self.subTest(exit_code=exit_code):
                process = FakeRunnerProcess()
                terminator = FakeTerminator()
                runner = supervisor.RunnerSupervisor(
                    FakeDocker(), FakeLauncher(process), terminator
                )
                self.assertTrue(
                    runner.run(
                        {
                            "microvmId": f"mvm-{exit_code}",
                            "runHookPayload": encoded_payload("jit"),
                        }
                    )
                )
                process.finish(exit_code)
                self.assertTrue(terminator.called.wait(1))
                self.assertEqual(
                    terminator.calls, [f"mvm-{exit_code}"]
                )

    def test_start_failure_requests_termination(self) -> None:
        docker = FakeDocker()
        terminator = FakeTerminator()
        runner = supervisor.RunnerSupervisor(
            docker, FakeLauncher(fail=True), terminator
        )

        self.assertFalse(
            runner.run(
                {
                    "microvmId": "mvm-failed",
                    "runHookPayload": encoded_payload("jit"),
                }
            )
        )
        self.assertTrue(terminator.called.wait(1))
        self.assertEqual(terminator.calls, ["mvm-failed"])
        self.assertGreaterEqual(docker.stop_calls, 1)

    def test_terminate_hook_stops_runner_without_duplicate_api_call(
        self,
    ) -> None:
        process = FakeRunnerProcess()
        terminator = FakeTerminator()
        runner = supervisor.RunnerSupervisor(
            FakeDocker(), FakeLauncher(process), terminator
        )
        self.assertTrue(
            runner.run(
                {
                    "microvmId": "mvm-1",
                    "runHookPayload": encoded_payload("jit"),
                }
            )
        )

        def stop_process(fake_process: FakeRunnerProcess) -> None:
            fake_process.finish(143)

        with patch.object(
            supervisor, "_stop_process_group", side_effect=stop_process
        ):
            runner.terminate()
        time.sleep(0.05)
        self.assertEqual(terminator.calls, [])

    def test_resume_requires_a_live_runner_and_healthy_docker(self) -> None:
        process = FakeRunnerProcess()
        docker = FakeDocker(ready=False)
        runner = supervisor.RunnerSupervisor(
            docker, FakeLauncher(process), FakeTerminator()
        )
        self.assertTrue(
            runner.run(
                {
                    "microvmId": "mvm-1",
                    "runHookPayload": encoded_payload("jit"),
                }
            )
        )
        docker.ready = False
        self.assertTrue(runner.resume())
        process.finish(0)


class ValidationTests(unittest.TestCase):
    def test_validation_is_asynchronous(self) -> None:
        release = threading.Event()

        def validate() -> bool:
            release.wait(1)
            return True

        manager = supervisor.ValidationManager(validate)
        self.assertEqual(
            manager.status(), supervisor.ValidationState.RUNNING
        )
        self.assertEqual(
            manager.status(), supervisor.ValidationState.RUNNING
        )
        release.set()
        for _attempt in range(100):
            if manager.status() == supervisor.ValidationState.SUCCEEDED:
                break
            time.sleep(0.01)
        self.assertEqual(
            manager.status(), supervisor.ValidationState.SUCCEEDED
        )

    def test_image_validation_accepts_vfs_fallback(self) -> None:
        application = supervisor.HookApplication(
            supervisor.Settings(),
            FakeDocker(driver="vfs"),  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
            run_command=lambda command, **_kwargs: subprocess.CompletedProcess(
                command, 0
            ),
        )
        self.assertTrue(application.validate_image())


class HookApplicationTests(unittest.TestCase):
    def test_lifecycle_paths_delegate_without_logging_payloads(self) -> None:
        calls: list[str] = []

        class FakeRunnerSupervisor:
            def run(self, _payload: dict[str, object]) -> bool:
                calls.append("run")
                return True

            def resume(self) -> bool:
                calls.append("resume")
                return True

            def suspend(self) -> bool:
                calls.append("suspend")
                return True

            def terminate(self) -> None:
                calls.append("terminate")

        application = supervisor.HookApplication(
            supervisor.Settings(),
            FakeDocker(ready=False),  # type: ignore[arg-type]
            FakeRunnerSupervisor(),  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
        )
        self.assertEqual(
            application.handle("run", {"secret": "must-not-log"}),
            (200, "runner started"),
        )
        self.assertEqual(
            application.handle("resume", {}), (200, "runner healthy")
        )
        self.assertEqual(
            application.handle("suspend", {}), (200, "suspended")
        )
        self.assertEqual(
            application.handle("terminate", {}), (200, "terminated")
        )
        self.assertEqual(
            application.handle("unknown", {}), (404, "unknown hook")
        )
        self.assertEqual(
            calls, ["run", "resume", "suspend", "terminate"]
        )


class SelfTerminatorTests(unittest.TestCase):
    def test_termination_retries_are_bounded(self) -> None:
        calls: list[list[str]] = []
        delays: list[float] = []

        def run_command(
            command: list[str], **_kwargs: object
        ) -> subprocess.CompletedProcess[bytes]:
            calls.append(command)
            return subprocess.CompletedProcess(
                command, 0 if len(calls) == 3 else 1
            )

        terminator = supervisor.SelfTerminator(
            supervisor.Settings(aws_region="us-east-1"),
            run_command=run_command,
            sleeper=delays.append,
            random_source=lambda: 0.5,
        )

        self.assertTrue(terminator.terminate("mvm-1"))
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [0.5, 1.0])
        self.assertEqual(
            calls[0],
            [
                "aws",
                "lambda-microvms",
                "terminate-microvm",
                "--microvm-identifier",
                "mvm-1",
                "--region",
                "us-east-1",
            ],
        )


class HookHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        calls = self.calls

        class FakeApplication:
            def handle(
                self, hook: str, payload: dict[str, object]
            ) -> tuple[int, str]:
                calls.append((hook, payload))
                return 200, "handled"

        supervisor.Hooks.application = FakeApplication()  # type: ignore[assignment]
        self.server = supervisor.HookServer(
            ("127.0.0.1", 0), supervisor.Hooks
        )
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)

    def test_valid_hook_and_health_requests(self) -> None:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.port, timeout=2
        )
        body = json.dumps({"microvmId": "mvm-1"})
        connection.request(
            "POST",
            f"{supervisor.HOOK_PREFIX}/run",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        response.read()

        connection.request("GET", "/healthz")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        connection.close()
        self.assertEqual(
            self.calls, [("run", {"microvmId": "mvm-1"})]
        )

    def test_invalid_json_is_rejected_without_reflection(self) -> None:
        secret = "invalid-json-secret"
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.port, timeout=2
        )
        connection.request(
            "POST",
            f"{supervisor.HOOK_PREFIX}/run",
            body=f"{{{secret}",
        )
        response = connection.getresponse()
        body = response.read().decode("utf-8")
        connection.close()

        self.assertEqual(response.status, 400)
        self.assertNotIn(secret, body)
        self.assertEqual(self.calls, [])

    def test_bodyless_lifecycle_hook_without_content_length_is_accepted(
        self,
    ) -> None:
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as client:
            client.sendall(
                (
                    f"POST {supervisor.HOOK_PREFIX}/suspend HTTP/1.0\r\n"
                    "Host: 127.0.0.1\r\n"
                    "\r\n"
                ).encode("ascii")
            )
            response = client.recv(4096)

        self.assertIn(b" 200 ", response)
        self.assertEqual(self.calls, [("suspend", {})])


class ReadyHookTests(unittest.TestCase):
    def test_ready_requires_tools_runner_and_stopped_docker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner_root = Path(directory)
            (runner_root / "run.sh").write_text(
                "#!/bin/sh\n", encoding="utf-8"
            )
            docker = FakeDocker(ready=False)
            run_command = lambda *_args, **_kwargs: subprocess.CompletedProcess(
                [], 0
            )
            application = supervisor.HookApplication(
                supervisor.Settings(runner_root=runner_root),
                docker,  # type: ignore[arg-type]
                object(),  # type: ignore[arg-type]
                object(),  # type: ignore[arg-type]
                run_command=run_command,
            )

            with patch.object(
                supervisor.shutil, "which", return_value="/bin/tool"
            ):
                self.assertEqual(
                    application.handle("ready", {}), (200, "ready")
                )
            docker.ready = True
            with patch.object(
                supervisor.shutil, "which", return_value="/bin/tool"
            ):
                self.assertEqual(
                    application.handle("ready", {}),
                    (503, "not ready"),
                )


if __name__ == "__main__":
    unittest.main()
