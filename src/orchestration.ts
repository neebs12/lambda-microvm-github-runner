import type {
  GitHubJitClient,
  JitRunner,
  Microvm,
  MicrovmClient,
  MicrovmControlClient,
  RunMicrovmResult,
} from "./clients.js";
import type { StartConfig, StopConfig } from "./config.js";
import { HttpMicrovmControlClient } from "./control.js";
import {
  createRunnerIdentity,
  createRunnerLabels,
  type WorkflowIdentity,
} from "./identity.js";
import { encodeRunHookPayload, encodeWarmRunHookPayload } from "./payload.js";
import { PollingError, pollSequentially } from "./polling.js";
import {
  getSafeErrorName,
  OperationRetryError,
  retryWithFullJitter,
} from "./retry.js";
import {
  decodeServerHandle,
  encodeExplicitWarmHandle,
  encodePoolWarmHandle,
  hashServerKey,
  SERVER_HANDLE_PREFIX,
  ServerHandleError,
} from "./server-handle.js";
import {
  createDynamoWarmPoolStore,
  effectivePoolKey,
  type WarmPoolMember,
  type WarmPoolStore,
} from "./warm-pool.js";

const STOP_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const CONTROL_PORT = 8080;
const CONTROL_TOKEN_EXPIRATION_MINUTES = 5;

export type RepositoryContext = {
  owner: string;
  repository: string;
  workflow: WorkflowIdentity;
  isForkPullRequest?: boolean;
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
  server?: string;
  warmHit?: boolean;
  warmExpiresAt?: number;
  reuseDeadline?: number;
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
  control: MicrovmControlClient = new HttpMicrovmControlClient(),
  poolStoreFactory: (
    tableName: string,
    region: string,
  ) => WarmPoolStore = createDynamoWarmPoolStore,
): Promise<StartResult> {
  const warm = config.server !== undefined;
  const deadline = runtime.now() + config.startupTimeoutSeconds * 1_000;
  const identity = createRunnerIdentity(
    context.workflow,
    config.idempotencyKey,
  );
  const labels = createRunnerLabels(identity.label, config.runnerLabels);
  let stage = "GitHub JIT runner creation";
  let jitRunner: JitRunner | undefined;
  let launched: RunMicrovmResult | undefined;
  let warmHit = false;
  let poolStore: WarmPoolStore | undefined;
  let poolMember: WarmPoolMember | undefined;
  let explicitInputHandle: ReturnType<typeof decodeServerHandle> | undefined;

  try {
    if (warm && context.isForkPullRequest === true) {
      throw new ActionExecutionError(
        "Warm servers are not available to fork-originated pull requests",
      );
    }
    if (config.server?.startsWith(SERVER_HANDLE_PREFIX) === true) {
      explicitInputHandle = decodeServerHandle(config.server);
      if (explicitInputHandle.kind !== "explicit") {
        throw new ActionExecutionError(
          "A released pool lease is reacquired by its pool name, not its opaque server value",
        );
      }
      if (explicitInputHandle.region !== config.region) {
        throw new ActionExecutionError(
          "Server belongs to a different AWS Region",
        );
      }
    }
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
    reporter.setSecret(jitRunner.encodedJitConfig);

    stage = "JIT payload encoding";
    const maskSecret = (secret: string): void => {
      reporter.setSecret(secret);
    };
    const runHookPayload = warm
      ? encodeWarmRunHookPayload(config.region, maskSecret)
      : encodeRunHookPayload(
          jitRunner.encodedJitConfig,
          config.region,
          maskSecret,
        );

    if (config.stateTable !== undefined && config.server !== undefined) {
      if (explicitInputHandle !== undefined) {
        throw new ActionExecutionError(
          "An opaque server value cannot be combined with 'state-table'",
        );
      }
      stage = "warm pool image resolution";
      const resolvedImageVersion =
        config.imageVersion ??
        (await microvms.resolveImageVersion(config.imageId));
      const poolKey = effectivePoolKey({
        repositoryId: context.workflow.repositoryId,
        serverKey: config.server,
        region: config.region,
        architecture: "ARM64",
        imageId: config.imageId,
        imageVersion: resolvedImageVersion,
        executionRoleArn: config.executionRoleArn,
        ingressConnectors: config.ingressConnectors,
        egressConnectors: config.egressConnectors,
        maxLifetimeSeconds: config.maximumDurationSeconds,
      });
      poolStore = poolStoreFactory(config.stateTable, config.region);
      stage = "warm pool reconciliation";
      await reconcilePool(
        poolStore,
        poolKey,
        config,
        resolvedImageVersion,
        runHookPayload,
        microvms,
        reporter,
        deadline,
        runtime,
      );
      stage = "warm pool acquisition";
      const acquired = await poolStore.acquire({
        poolKey,
        acquisitionId: identity.clientToken,
        leaseId: leaseId(identity.clientToken),
        leaseOwner: `${context.workflow.runId}:${context.workflow.runAttempt}:${context.workflow.job}`,
        now: runtime.now(),
        leaseExpiresAt: runtime.now() + config.leaseTimeoutSeconds * 1_000,
        ...(config.serverCapacity === undefined
          ? {}
          : { serverCapacity: config.serverCapacity }),
      });
      poolMember = acquired.member;
      if (acquired.needsCreation) {
        stage = "RunMicrovm";
        launched = await launchMicrovm(
          config,
          resolvedImageVersion,
          runHookPayload,
          identity.clientToken,
          microvms,
          deadline,
          runtime,
        );
        const expiresAt =
          launched.startedAt + launched.maximumDurationSeconds * 1_000;
        poolMember = await poolStore.markCreated(poolMember, {
          microvmId: launched.microvmId,
          endpoint: launched.endpoint,
          imageVersion: launched.imageVersion,
          startedAt: launched.startedAt,
          maxLifetimeSeconds: launched.maximumDurationSeconds,
          expiresAt,
          reuseDeadline: expiresAt - config.reuseSafetyMarginSeconds * 1_000,
          ttl: Math.floor(expiresAt / 1_000) + 86_400,
        });
      } else {
        warmHit = true;
        stage = "GetMicrovm warm pool reuse";
        const memberMicrovmId = requiredMemberMicrovmId(poolMember);
        const existing = await getMicrovmWithRetry(
          microvms,
          memberMicrovmId,
          deadline,
          runtime,
        );
        launched = reusableMicrovm(existing, config, runtime.now());
        if (existing?.state === "SUSPENDED") {
          stage = "ResumeMicrovm";
          await retryWithFullJitter(
            async () => microvms.resume(memberMicrovmId),
            retryOptions("ResumeMicrovm", deadline, runtime),
          );
        } else if (existing?.state !== "RUNNING") {
          throw new ActionExecutionError(
            "Warm pool member is not suspended or running",
          );
        }
      }
    } else if (explicitInputHandle?.kind === "explicit") {
      const explicitMicrovmId = explicitInputHandle.microvmId;
      stage = "GetMicrovm warm reuse";
      const existing = await getMicrovmWithRetry(
        microvms,
        explicitMicrovmId,
        deadline,
        runtime,
      );
      launched = reusableMicrovm(existing, config, runtime.now());
      warmHit = true;
      if (existing?.state === "SUSPENDED") {
        stage = "ResumeMicrovm";
        await retryWithFullJitter(
          async () => microvms.resume(explicitMicrovmId),
          retryOptions("ResumeMicrovm", deadline, runtime),
        );
      } else if (existing?.state !== "RUNNING") {
        throw new ActionExecutionError(
          "Warm MicroVM is not suspended or running",
        );
      }
    } else {
      stage = "RunMicrovm";
      launched = await launchMicrovm(
        config,
        config.imageVersion,
        runHookPayload,
        identity.clientToken,
        microvms,
        deadline,
        runtime,
      );
    }

    stage = "MicroVM readiness";
    reporter.info(`Waiting for MicroVM '${launched.microvmId}'`);
    await waitForRunningMicrovm(
      microvms,
      launched.microvmId,
      deadline,
      runtime,
    );

    if (warm) {
      stage = "CreateMicrovmAuthToken";
      const { token } = await microvms.createAuthToken(
        launched.microvmId,
        CONTROL_PORT,
        CONTROL_TOKEN_EXPIRATION_MINUTES,
      );
      reporter.setSecret(token);
      stage = "warm runner control delivery";
      await control.startRunner({
        endpoint: launched.endpoint,
        port: CONTROL_PORT,
        authToken: token,
        requestId: identity.clientToken,
        microvmId: launched.microvmId,
        encodedJitConfig: jitRunner.encodedJitConfig,
      });
    }

    stage = "GitHub runner readiness";
    reporter.info(`Waiting for runner '${jitRunner.runnerName}' to be online`);
    await waitForOnlineRunner(
      github,
      jitRunner.runnerId,
      jitRunner.runnerName,
      deadline,
      runtime,
    );

    const expiresAt =
      launched.startedAt + launched.maximumDurationSeconds * 1_000;
    const reuseDeadline = expiresAt - config.reuseSafetyMarginSeconds * 1_000;
    const server =
      poolMember !== undefined
        ? encodePoolWarmHandle({
            version: 1,
            kind: "pool",
            region: config.region,
            tableName: requireDefined(
              config.stateTable,
              "Warm pool state table is missing",
            ),
            poolKey: poolMember.poolKey,
            memberId: poolMember.memberId,
            microvmId: launched.microvmId,
            leaseId: poolMember.leaseId,
            leaseGeneration: poolMember.leaseGeneration,
            expiresAt,
            reuseDeadline,
          })
        : warm
          ? encodeExplicitWarmHandle({
              version: 1,
              kind: "explicit",
              region: config.region,
              microvmId: launched.microvmId,
              serverKeyHash:
                explicitInputHandle?.kind === "explicit"
                  ? explicitInputHandle.serverKeyHash
                  : hashServerKey(
                      requireDefined(config.server, "Warm server is missing"),
                    ),
              startedAt: launched.startedAt,
              expiresAt,
              reuseDeadline,
            })
          : undefined;
    const result: StartResult = {
      label: identity.label,
      runnerName: jitRunner.runnerName,
      runnerId: jitRunner.runnerId,
      microvmId: launched.microvmId,
      region: config.region,
      imageVersion: launched.imageVersion,
      ...(server === undefined
        ? {}
        : {
            server,
            warmHit,
            warmExpiresAt: expiresAt,
            reuseDeadline,
          }),
    };
    setStartOutputs(reporter, result);
    reporter.info(`Runner '${result.runnerName}' is online`);
    return result;
  } catch (error: unknown) {
    if (poolStore !== undefined && poolMember !== undefined) {
      await cleanupFailedPoolStart(
        poolStore,
        poolMember,
        jitRunner,
        launched,
        github,
        microvms,
        reporter,
        runtime,
      );
    } else {
      await cleanupFailedStart(
        jitRunner,
        launched,
        github,
        microvms,
        reporter,
        runtime,
      );
    }
    throw userFacingFailure(stage, config.region, error);
  }
}

export async function stopRunner(
  config: StopConfig,
  microvms: MicrovmClient,
  reporter: ActionReporter,
  runtime: ActionRuntime = systemRuntime,
  poolStoreFactory: (
    tableName: string,
    region: string,
  ) => WarmPoolStore = createDynamoWarmPoolStore,
): Promise<void> {
  if (config.server !== undefined) {
    await releaseWarmServer(
      config,
      microvms,
      reporter,
      runtime,
      poolStoreFactory,
    );
    return;
  }
  const microvmId = requireDefined(config.microvmId, "MicroVM ID is missing");
  const deadline = runtime.now() + STOP_TIMEOUT_MS;
  reporter.info(`Terminating MicroVM '${microvmId}'`);

  try {
    await retryWithFullJitter(
      async () => microvms.terminate(microvmId),
      retryOptions("TerminateMicrovm", deadline, runtime),
    );
    await pollSequentially({
      operation: "GetMicrovm termination",
      deadline,
      observe: async () =>
        getMicrovmWithRetry(microvms, microvmId, deadline, runtime),
      decide: (microvm) => {
        if (microvm === undefined || microvm.state === "TERMINATED") {
          return { status: "success", value: undefined };
        }
        return { status: "pending" };
      },
      ...pollingRuntime(runtime),
    });
    reporter.info(`MicroVM '${microvmId}' is terminated`);
  } catch (error: unknown) {
    throw userFacingFailure("MicroVM termination", config.region, error);
  }
}

async function releaseWarmServer(
  config: StopConfig,
  microvms: MicrovmClient,
  reporter: ActionReporter,
  runtime: ActionRuntime,
  poolStoreFactory: (tableName: string, region: string) => WarmPoolStore,
): Promise<void> {
  let handle;
  try {
    handle = decodeServerHandle(
      requireDefined(config.server, "Warm server is missing"),
    );
  } catch (error: unknown) {
    if (error instanceof ServerHandleError) {
      throw new ActionExecutionError(error.message);
    }
    throw error;
  }
  if (handle.region !== config.region) {
    throw new ActionExecutionError(
      "Server handle belongs to a different AWS Region",
    );
  }
  const deadline = runtime.now() + STOP_TIMEOUT_MS;
  if (handle.kind === "pool") {
    if (
      config.stateTable !== undefined &&
      config.stateTable !== handle.tableName
    ) {
      throw new ActionExecutionError(
        "Server handle belongs to a different DynamoDB table",
      );
    }
    const store = poolStoreFactory(handle.tableName, handle.region);
    const member: WarmPoolMember = {
      poolKey: handle.poolKey,
      memberId: handle.memberId,
      state: "LEASED",
      leaseId: handle.leaseId,
      leaseGeneration: handle.leaseGeneration,
      acquisitionId: "",
      leaseOwner: "",
      leaseExpiresAt: 0,
      microvmId: handle.microvmId,
      expiresAt: handle.expiresAt,
      reuseDeadline: handle.reuseDeadline,
    };
    const destroy = runtime.now() >= handle.reuseDeadline;
    let owned: WarmPoolMember;
    try {
      owned = await store.beginRelease(member, destroy);
    } catch {
      throw new ActionExecutionError(
        "Warm server lease is stale or already released",
      );
    }
    if (destroy) {
      reporter.info(
        `Warm pool member '${handle.microvmId}' reached its reuse deadline; terminating it`,
      );
      await terminateMicrovm(microvms, handle.microvmId, deadline, runtime);
      await store.markDead(owned);
      return;
    }
    reporter.info(`Suspending warm pool member '${handle.microvmId}'`);
    try {
      await retryWithFullJitter(
        async () => microvms.suspend(handle.microvmId),
        retryOptions("SuspendMicrovm", deadline, runtime),
      );
      await waitForSuspendedMicrovm(
        microvms,
        handle.microvmId,
        deadline,
        runtime,
      );
      await store.completeRelease(owned, runtime.now());
      reporter.info(`Warm pool member '${handle.microvmId}' is suspended`);
      return;
    } catch (error: unknown) {
      throw userFacingFailure("MicroVM suspension", config.region, error);
    }
  }
  if (runtime.now() >= handle.reuseDeadline) {
    reporter.info(
      `MicroVM '${handle.microvmId}' reached its reuse deadline; terminating it`,
    );
    await terminateMicrovm(microvms, handle.microvmId, deadline, runtime);
    return;
  }
  reporter.info(`Suspending warm MicroVM '${handle.microvmId}'`);
  try {
    await retryWithFullJitter(
      async () => microvms.suspend(handle.microvmId),
      retryOptions("SuspendMicrovm", deadline, runtime),
    );
    await waitForSuspendedMicrovm(
      microvms,
      handle.microvmId,
      deadline,
      runtime,
    );
    reporter.info(`Warm MicroVM '${handle.microvmId}' is suspended`);
  } catch (error: unknown) {
    throw userFacingFailure("MicroVM suspension", config.region, error);
  }
}

async function terminateMicrovm(
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

async function waitForSuspendedMicrovm(
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

function reusableMicrovm(
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

async function launchMicrovm(
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

async function reconcilePool(
  store: WarmPoolStore,
  poolKey: string,
  config: StartConfig,
  imageVersion: string,
  runHookPayload: string,
  microvms: MicrovmClient,
  reporter: ActionReporter,
  deadline: number,
  runtime: ActionRuntime,
): Promise<void> {
  const candidates = await store.reconciliationCandidates(
    poolKey,
    runtime.now(),
  );
  for (const candidate of candidates) {
    let current = candidate;
    if (
      current.state === "CREATING" &&
      current.microvmId === undefined &&
      current.acquisitionId.length > 0
    ) {
      try {
        const recovered = await launchMicrovm(
          config,
          imageVersion,
          runHookPayload,
          current.acquisitionId,
          microvms,
          deadline,
          runtime,
        );
        const expiresAt =
          recovered.startedAt + recovered.maximumDurationSeconds * 1_000;
        current = await store.markCreated(current, {
          microvmId: recovered.microvmId,
          endpoint: recovered.endpoint,
          imageVersion: recovered.imageVersion,
          startedAt: recovered.startedAt,
          maxLifetimeSeconds: recovered.maximumDurationSeconds,
          expiresAt,
          reuseDeadline: expiresAt - config.reuseSafetyMarginSeconds * 1_000,
          ttl: Math.floor(expiresAt / 1_000) + 86_400,
        });
      } catch (error: unknown) {
        reporter.warning(
          `Expired warm creation could not be recovered (${getSafeErrorName(error)})`,
        );
        await store.abandonCreation(current);
        continue;
      }
    }
    const destroying = await store.beginReconciliation(current, runtime.now());
    if (destroying === undefined) {
      continue;
    }
    if (destroying.microvmId !== undefined) {
      await terminateMicrovm(microvms, destroying.microvmId, deadline, runtime);
    }
    await store.markReconciledDead(destroying);
  }
}

function leaseId(acquisitionId: string): string {
  return createHash("sha256")
    .update(`warm-lease\0${acquisitionId}`)
    .digest("hex");
}

function requiredMemberMicrovmId(member: WarmPoolMember): string {
  if (member.microvmId === undefined) {
    throw new ActionExecutionError(
      "Warm pool member has incomplete MicroVM metadata",
    );
  }
  return member.microvmId;
}

async function cleanupFailedPoolStart(
  store: WarmPoolStore,
  member: WarmPoolMember,
  jitRunner: JitRunner | undefined,
  launched: RunMicrovmResult | undefined,
  github: GitHubJitClient,
  microvms: MicrovmClient,
  reporter: ActionReporter,
  runtime: ActionRuntime,
): Promise<void> {
  if (launched === undefined) {
    try {
      await store.abandonCreation(member);
    } catch (error: unknown) {
      reporter.warning(
        `Warm reservation cleanup did not complete (${getSafeErrorName(error)})`,
      );
    }
  } else {
    try {
      const deadline = runtime.now() + CLEANUP_TIMEOUT_MS;
      if (member.state === "CREATING") {
        await terminateMicrovm(microvms, launched.microvmId, deadline, runtime);
        await store.abandonCreation(member);
      } else {
        const destroying = await store.beginRelease(member, true);
        await terminateMicrovm(microvms, launched.microvmId, deadline, runtime);
        await store.markDead(destroying);
      }
    } catch (error: unknown) {
      reporter.warning(
        `Warm member cleanup did not complete (${getSafeErrorName(error)})`,
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
  if (result.server !== undefined) {
    reporter.setOutput("server", result.server);
    reporter.setOutput("warm-hit", String(result.warmHit));
    reporter.setOutput(
      "warm-expires-at",
      new Date(
        requireDefined(result.warmExpiresAt, "Warm expiry is missing"),
      ).toISOString(),
    );
    reporter.setOutput(
      "reuse-deadline",
      new Date(
        requireDefined(result.reuseDeadline, "Reuse deadline is missing"),
      ).toISOString(),
    );
  }
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new ActionExecutionError(message);
  }
  return value;
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
import { createHash } from "node:crypto";
