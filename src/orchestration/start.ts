import type {
  GitHubJitClient,
  JitRunner,
  MicrovmClient,
  MicrovmControlClient,
  RunMicrovmResult,
} from "../clients.js";
import type { StartConfig } from "../config.js";
import { HttpMicrovmControlClient } from "../control.js";
import { createRunnerIdentity, createRunnerLabels } from "../identity.js";
import { encodeRunHookPayload, encodeWarmRunHookPayload } from "../payload.js";
import { retryWithFullJitter } from "../retry.js";
import {
  decodeServerHandle,
  encodeExplicitWarmHandle,
  encodePoolWarmHandle,
  hashServerKey,
  SERVER_HANDLE_PREFIX,
} from "../server-handle.js";
import {
  createDynamoWarmPoolStore,
  effectivePoolKey,
  type WarmPoolMember,
  type WarmPoolStore,
} from "../warm-pool.js";
import { cleanupFailedPoolStart, cleanupFailedStart } from "./cleanup.js";
import {
  getMicrovmWithRetry,
  launchMicrovm,
  reusableMicrovm,
  waitForOnlineRunner,
  waitForRunningMicrovm,
} from "./lifecycle.js";
import { setStartOutputs } from "./outputs.js";
import {
  leaseId,
  reconcilePool,
  requiredMemberMicrovmId,
  retireClaimedPoolMember,
} from "./pool.js";
import {
  CONTROL_PORT,
  CONTROL_TOKEN_EXPIRATION_MINUTES,
  requireDefined,
  retryOptions,
  systemRuntime,
  userFacingFailure,
} from "./runtime.js";
import {
  ActionExecutionError,
  type ActionReporter,
  type ActionRuntime,
  type RepositoryContext,
  type StartResult,
} from "./types.js";

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
      for (
        let candidateAttempt = 0;
        candidateAttempt < 1_000;
        candidateAttempt += 1
      ) {
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
          break;
        }

        stage = "GetMicrovm warm pool reuse";
        const memberMicrovmId = requiredMemberMicrovmId(poolMember);
        const existing = await getMicrovmWithRetry(
          microvms,
          memberMicrovmId,
          deadline,
          runtime,
        );
        try {
          if (
            existing === undefined ||
            !["RUNNING", "SUSPENDED"].includes(existing.state)
          ) {
            throw new ActionExecutionError("Warm pool member is unavailable");
          }
          launched = reusableMicrovm(existing, config, runtime.now());
        } catch (error: unknown) {
          if (!(error instanceof ActionExecutionError)) {
            throw error;
          }
          reporter.warning("Retiring an unusable warm pool member");
          await retireClaimedPoolMember(
            poolStore,
            poolMember,
            existing,
            microvms,
            deadline,
            runtime,
          );
          poolMember = undefined;
          launched = undefined;
          stage = "warm pool acquisition";
          continue;
        }

        warmHit = true;
        if (existing.state === "SUSPENDED") {
          stage = "ResumeMicrovm";
          await retryWithFullJitter(
            async () => microvms.resume(memberMicrovmId),
            retryOptions("ResumeMicrovm", deadline, runtime),
          );
        }
        break;
      }
      if (poolMember === undefined || launched === undefined) {
        throw new ActionExecutionError(
          "Warm pool acquisition exhausted stale members",
        );
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
