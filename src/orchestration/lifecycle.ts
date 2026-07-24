import type {
  GitHubJitClient,
  Microvm,
  MicrovmClient,
  RunMicrovmResult,
} from "../clients.js";
import type { StartConfig } from "../config.js";
import { pollSequentially } from "../polling.js";
import { retryWithFullJitter } from "../retry.js";
import { pollingRuntime, retryOptions } from "./runtime.js";
import { ActionExecutionError, type ActionRuntime } from "./types.js";

export async function terminateMicrovm(
  microvms: MicrovmClient,
  microvmId: string,
  deadline: number,
  runtime: ActionRuntime,
): Promise<void> {
  await retryWithFullJitter(
    async () => microvms.terminate(microvmId),
    retryOptions("TerminateMicrovm", deadline, runtime),
  );
  await pollSequentially({
    operation: "GetMicrovm termination",
    deadline,
    observe: async () =>
      getMicrovmWithRetry(microvms, microvmId, deadline, runtime),
    decide: (microvm) =>
      microvm === undefined || microvm.state === "TERMINATED"
        ? { status: "success", value: undefined }
        : { status: "pending" },
    ...pollingRuntime(runtime),
  });
}

export async function waitForRunningMicrovm(
  microvms: MicrovmClient,
  microvmId: string,
  deadline: number,
  runtime: ActionRuntime,
): Promise<Microvm> {
  return pollSequentially({
    operation: "GetMicrovm readiness",
    deadline,
    observe: async () =>
      getMicrovmWithRetry(microvms, microvmId, deadline, runtime),
    decide: (microvm) => {
      if (microvm === undefined || microvm.state === "PENDING") {
        return { status: "pending" };
      }
      if (microvm.state === "RUNNING") {
        return { status: "success", value: microvm };
      }
      return { status: "failure", reason: microvm.state };
    },
    ...pollingRuntime(runtime),
  });
}

export async function waitForSuspendedMicrovm(
  microvms: MicrovmClient,
  microvmId: string,
  deadline: number,
  runtime: ActionRuntime,
): Promise<Microvm> {
  return pollSequentially({
    operation: "GetMicrovm suspension",
    deadline,
    observe: async () =>
      getMicrovmWithRetry(microvms, microvmId, deadline, runtime),
    decide: (microvm) => {
      if (
        microvm !== undefined &&
        ["RUNNING", "SUSPENDING"].includes(microvm.state)
      ) {
        return { status: "pending" };
      }
      if (microvm?.state === "SUSPENDED") {
        return { status: "success", value: microvm };
      }
      return { status: "failure", reason: microvm?.state ?? "missing" };
    },
    ...pollingRuntime(runtime),
  });
}

export function reusableMicrovm(
  microvm: Microvm | undefined,
  config: StartConfig,
  now: number,
): RunMicrovmResult {
  if (
    microvm?.endpoint === undefined ||
    microvm.imageVersion === undefined ||
    microvm.startedAt === undefined ||
    microvm.maximumDurationSeconds === undefined
  ) {
    throw new ActionExecutionError(
      "Warm MicroVM is missing or has incomplete AWS metadata",
    );
  }
  if (
    config.imageVersion !== undefined &&
    microvm.imageVersion !== config.imageVersion
  ) {
    throw new ActionExecutionError(
      "Warm MicroVM image version does not match this request",
    );
  }
  const reuseDeadline =
    microvm.startedAt +
    (microvm.maximumDurationSeconds - config.reuseSafetyMarginSeconds) * 1_000;
  if (now >= reuseDeadline) {
    throw new ActionExecutionError("Warm MicroVM reached its reuse deadline");
  }
  return {
    microvmId: microvm.microvmId,
    endpoint: microvm.endpoint,
    imageVersion: microvm.imageVersion,
    startedAt: microvm.startedAt,
    maximumDurationSeconds: microvm.maximumDurationSeconds,
  };
}

export async function waitForOnlineRunner(
  github: GitHubJitClient,
  runnerId: number,
  expectedName: string,
  deadline: number,
  runtime: ActionRuntime,
): Promise<void> {
  return pollSequentially({
    operation: "GitHub runner readiness",
    deadline,
    observe: async () => github.getRunner(runnerId),
    decide: (runner) => {
      if (runner === undefined) {
        return { status: "pending" };
      }
      if (runner.runnerId !== runnerId || runner.runnerName !== expectedName) {
        return { status: "failure", reason: "runner-identity-mismatch" };
      }
      return runner.status.toLowerCase() === "online"
        ? { status: "success", value: undefined }
        : { status: "pending" };
    },
    ...pollingRuntime(runtime),
  });
}

export async function getMicrovmWithRetry(
  microvms: MicrovmClient,
  microvmId: string,
  deadline: number,
  runtime: ActionRuntime,
): Promise<Microvm | undefined> {
  return retryWithFullJitter(
    async () => microvms.get(microvmId),
    retryOptions("GetMicrovm", deadline, runtime, {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 1_000,
    }),
  );
}

export async function launchMicrovm(
  config: StartConfig,
  imageVersion: string | undefined,
  runHookPayload: string,
  clientToken: string,
  microvms: MicrovmClient,
  deadline: number,
  runtime: ActionRuntime,
): Promise<RunMicrovmResult> {
  const launchRequest = {
    clientToken,
    region: config.region,
    imageId: config.imageId,
    executionRoleArn: config.executionRoleArn,
    maximumDurationSeconds: config.maximumDurationSeconds,
    ingressConnectors: config.ingressConnectors,
    egressConnectors: config.egressConnectors,
    runHookPayload,
    ...(imageVersion === undefined ? {} : { imageVersion }),
    ...(config.cloudwatchLogGroup === undefined
      ? {}
      : { cloudwatchLogGroup: config.cloudwatchLogGroup }),
  };
  return retryWithFullJitter(
    async () => microvms.run(launchRequest),
    retryOptions("RunMicrovm", deadline, runtime),
  );
}
