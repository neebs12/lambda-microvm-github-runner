import type {
  GitHubJitClient,
  JitRunner,
  MicrovmClient,
  RunMicrovmResult,
} from "../clients.js";
import { getSafeErrorName, retryWithFullJitter } from "../retry.js";
import type { WarmPoolMember, WarmPoolStore } from "../warm-pool.js";
import { terminateMicrovm } from "./lifecycle.js";
import { CLEANUP_TIMEOUT_MS, retryOptions } from "./runtime.js";
import type { ActionReporter, ActionRuntime } from "./types.js";

export async function cleanupFailedPoolStart(
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

export async function cleanupFailedStart(
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
