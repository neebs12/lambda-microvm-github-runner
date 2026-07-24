import type { MicrovmClient } from "../clients.js";
import type { StopConfig } from "../config.js";
import { pollSequentially } from "../polling.js";
import { retryWithFullJitter } from "../retry.js";
import { decodeServerHandle, ServerHandleError } from "../server-handle.js";
import {
  createDynamoWarmPoolStore,
  type WarmPoolMember,
  type WarmPoolStore,
} from "../warm-pool.js";
import {
  getMicrovmWithRetry,
  terminateMicrovm,
  waitForSuspendedMicrovm,
} from "./lifecycle.js";
import {
  pollingRuntime,
  requireDefined,
  retryOptions,
  STOP_TIMEOUT_MS,
  systemRuntime,
  userFacingFailure,
} from "./runtime.js";
import {
  ActionExecutionError,
  type ActionReporter,
  type ActionRuntime,
} from "./types.js";

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
