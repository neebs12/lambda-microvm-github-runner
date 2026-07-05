import type {
  GitHubJitClient,
  JitRunner,
  Microvm,
  MicrovmClient,
  RunMicrovmResult,
} from "./clients.js";
import type { StartConfig, StopConfig } from "./config.js";
import {
  createRunnerIdentity,
  createRunnerLabels,
  type WorkflowIdentity,
} from "./identity.js";
import { encodeRunHookPayload } from "./payload.js";
import { PollingError, pollSequentially } from "./polling.js";
import {
  getSafeErrorName,
  OperationRetryError,
  retryWithFullJitter,
} from "./retry.js";

const STOP_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 30_000;

export type RepositoryContext = {
  owner: string;
  repository: string;
  workflow: WorkflowIdentity;
};

export type ActionReporter = {
  setSecret(secret: string): void;
  setOutput(name: string, value: string): void;
  info(message: string): void;
  debug(message: string): void;
  warning(message: string): void;
};

export type ActionRuntime = {
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export type StartResult = {
  label: string;
  runnerName: string;
  runnerId: number;
  microvmId: string;
  region: string;
  imageVersion: string;
};

export class ActionExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActionExecutionError";
  }
}

export async function startRunner(
  config: StartConfig,
  context: RepositoryContext,
  github: GitHubJitClient,
  microvms: MicrovmClient,
  reporter: ActionReporter,
  runtime: ActionRuntime = systemRuntime,
): Promise<StartResult> {
  const deadline = runtime.now() + config.startupTimeoutSeconds * 1_000;
  const identity = createRunnerIdentity(
    context.workflow,
    config.idempotencyKey,
  );
  const labels = createRunnerLabels(identity.label, config.runnerLabels);
  let stage = "GitHub JIT runner creation";
  let jitRunner: JitRunner | undefined;
  let launched: RunMicrovmResult | undefined;

  try {
    reporter.info(`Creating JIT runner '${identity.runnerName}'`);
    jitRunner = await github.createJitRunner({
      owner: context.owner,
      repository: context.repository,
      runnerName: identity.runnerName,
      runnerGroupId: config.runnerGroupId,
      labels,
    });
    if (jitRunner.runnerName !== identity.runnerName) {
      throw new ActionExecutionError(
        "GitHub JIT runner creation returned an unexpected runner name",
      );
    }

    stage = "JIT payload encoding";
    const runHookPayload = encodeRunHookPayload(
      jitRunner.encodedJitConfig,
      config.region,
      (secret) => {
        reporter.setSecret(secret);
      },
    );

    stage = "RunMicrovm";
    const launchRequest = {
      clientToken: identity.clientToken,
      region: config.region,
      imageId: config.imageId,
      executionRoleArn: config.executionRoleArn,
      maximumDurationSeconds: config.maximumDurationSeconds,
      ingressConnectors: config.ingressConnectors,
      egressConnectors: config.egressConnectors,
      runHookPayload,
      ...(config.imageVersion === undefined
        ? {}
        : { imageVersion: config.imageVersion }),
      ...(config.cloudwatchLogGroup === undefined
        ? {}
        : { cloudwatchLogGroup: config.cloudwatchLogGroup }),
    };
    launched = await retryWithFullJitter(
      async () => microvms.run(launchRequest),
      retryOptions("RunMicrovm", deadline, runtime),
    );

    stage = "MicroVM readiness";
    reporter.info(`Waiting for MicroVM '${launched.microvmId}'`);
    await waitForRunningMicrovm(
      microvms,
      launched.microvmId,
      deadline,
      runtime,
    );

    stage = "GitHub runner readiness";
    reporter.info(`Waiting for runner '${jitRunner.runnerName}' to be online`);
    await waitForOnlineRunner(
      github,
      jitRunner.runnerId,
      jitRunner.runnerName,
      deadline,
      runtime,
    );

    const result: StartResult = {
      label: identity.label,
      runnerName: jitRunner.runnerName,
      runnerId: jitRunner.runnerId,
      microvmId: launched.microvmId,
      region: config.region,
      imageVersion: launched.imageVersion,
    };
    setStartOutputs(reporter, result);
    reporter.info(`Runner '${result.runnerName}' is online`);
    return result;
  } catch (error: unknown) {
    await cleanupFailedStart(
      jitRunner,
      launched,
      github,
      microvms,
      reporter,
      runtime,
    );
    throw userFacingFailure(stage, config.region, error);
  }
}

export async function stopRunner(
  config: StopConfig,
  microvms: MicrovmClient,
  reporter: ActionReporter,
  runtime: ActionRuntime = systemRuntime,
): Promise<void> {
  const deadline = runtime.now() + STOP_TIMEOUT_MS;
  reporter.info(`Terminating MicroVM '${config.microvmId}'`);

  try {
    await retryWithFullJitter(
      async () => microvms.terminate(config.microvmId),
      retryOptions("TerminateMicrovm", deadline, runtime),
    );
    await pollSequentially({
      operation: "GetMicrovm termination",
      deadline,
      observe: async () =>
        getMicrovmWithRetry(microvms, config.microvmId, deadline, runtime),
      decide: (microvm) => {
        if (microvm === undefined || microvm.state === "TERMINATED") {
          return { status: "success", value: undefined };
        }
        return { status: "pending" };
      },
      ...pollingRuntime(runtime),
    });
    reporter.info(`MicroVM '${config.microvmId}' is terminated`);
  } catch (error: unknown) {
    throw userFacingFailure("MicroVM termination", config.region, error);
  }
}

async function waitForRunningMicrovm(
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

async function waitForOnlineRunner(
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

async function getMicrovmWithRetry(
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

async function cleanupFailedStart(
  jitRunner: JitRunner | undefined,
  launched: RunMicrovmResult | undefined,
  github: GitHubJitClient,
  microvms: MicrovmClient,
  reporter: ActionReporter,
  runtime: ActionRuntime,
): Promise<void> {
  if (launched !== undefined) {
    const deadline = runtime.now() + CLEANUP_TIMEOUT_MS;
    try {
      await retryWithFullJitter(
        async () => microvms.terminate(launched.microvmId),
        retryOptions("TerminateMicrovm cleanup", deadline, runtime),
      );
    } catch (error: unknown) {
      reporter.warning(
        `MicroVM cleanup did not complete (${getSafeErrorName(error)})`,
      );
    }
  }

  if (jitRunner !== undefined) {
    try {
      await github.deleteRunner(jitRunner.runnerId);
    } catch (error: unknown) {
      reporter.warning(
        `JIT runner cleanup did not complete (${getSafeErrorName(error)})`,
      );
    }
  }
}

function setStartOutputs(reporter: ActionReporter, result: StartResult): void {
  reporter.setOutput("label", result.label);
  reporter.setOutput("runner-name", result.runnerName);
  reporter.setOutput("runner-id", String(result.runnerId));
  reporter.setOutput("microvm-id", result.microvmId);
  reporter.setOutput("region", result.region);
  reporter.setOutput("image-version", result.imageVersion);
}

function retryOptions(
  operation: string,
  deadline: number,
  runtime: ActionRuntime,
  overrides: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {},
) {
  return {
    operation,
    deadline,
    maxAttempts: overrides.maxAttempts ?? 6,
    baseDelayMs: overrides.baseDelayMs ?? 1_000,
    maxDelayMs: overrides.maxDelayMs ?? 16_000,
    random: runtime.random,
    now: runtime.now,
    sleep: runtime.sleep,
  };
}

function pollingRuntime(runtime: ActionRuntime) {
  return {
    random: runtime.random,
    now: runtime.now,
    sleep: runtime.sleep,
  };
}

function userFacingFailure(
  stage: string,
  region: string,
  error: unknown,
): ActionExecutionError {
  if (error instanceof ActionExecutionError) {
    return error;
  }
  if (error instanceof OperationRetryError && error.reason === "capacity") {
    return new ActionExecutionError(
      `${stage} exhausted Lambda MicroVM capacity in ${region}; review AWS Service Quotas for this account and Region`,
    );
  }
  if (
    (error instanceof PollingError && error.reason === "deadline") ||
    (error instanceof OperationRetryError && error.reason === "deadline")
  ) {
    return new ActionExecutionError(`${stage} timed out in ${region}`);
  }
  return new ActionExecutionError(
    `${stage} failed (${getSafeErrorName(error)})`,
  );
}

const systemRuntime: ActionRuntime = {
  now: Date.now,
  random: Math.random,
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};
