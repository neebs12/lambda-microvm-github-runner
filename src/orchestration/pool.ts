import { createHash } from "node:crypto";

import type { Microvm, MicrovmClient } from "../clients.js";
import type { StartConfig } from "../config.js";
import { getSafeErrorName } from "../retry.js";
import type { WarmPoolMember, WarmPoolStore } from "../warm-pool.js";
import { launchMicrovm, terminateMicrovm } from "./lifecycle.js";
import {
  ActionExecutionError,
  type ActionReporter,
  type ActionRuntime,
} from "./types.js";

export async function retireClaimedPoolMember(
  store: WarmPoolStore,
  member: WarmPoolMember,
  microvm: Microvm | undefined,
  microvms: MicrovmClient,
  deadline: number,
  runtime: ActionRuntime,
): Promise<void> {
  const destroying = await store.beginRelease(member, true);
  if (microvm !== undefined && microvm.state !== "TERMINATED") {
    await terminateMicrovm(microvms, microvm.microvmId, deadline, runtime);
  }
  await store.markDead(destroying);
}

export async function reconcilePool(
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

export function leaseId(acquisitionId: string): string {
  return createHash("sha256")
    .update(`warm-lease\0${acquisitionId}`)
    .digest("hex");
}

export function requiredMemberMicrovmId(member: WarmPoolMember): string {
  if (member.microvmId === undefined) {
    throw new ActionExecutionError(
      "Warm pool member has incomplete MicroVM metadata",
    );
  }
  return member.microvmId;
}
