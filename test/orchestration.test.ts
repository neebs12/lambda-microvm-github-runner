import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  MicrovmControlClient,
  StartControlledRunnerRequest,
} from "../src/clients.js";
import type { StartConfig, StopConfig } from "../src/config.js";
import { decodeJitPayload } from "../src/payload.js";
import {
  startRunner,
  stopRunner,
  type ActionReporter,
  type ActionRuntime,
  type RepositoryContext,
} from "../src/orchestration.js";
import {
  decodeServerHandle,
  decodeExplicitWarmHandle,
  encodeExplicitWarmHandle,
  encodePoolWarmHandle,
  hashServerKey,
} from "../src/server-handle.js";
import type {
  AcquireWarmPoolRequest,
  CreatedWarmMember,
  WarmPoolMember,
  WarmPoolStore,
} from "../src/warm-pool.js";
import { MockGitHubJitClient, MockMicrovmClient } from "./mocks/clients.js";

const startConfig: StartConfig = {
  mode: "start",
  region: "us-east-1",
  debug: false,
  githubToken: "github-token",
  imageId: "image",
  imageVersion: "7",
  executionRoleArn: "arn:aws:iam::123456789012:role/runner",
  runnerGroupId: 1,
  runnerLabels: ["lambda-microvm", "docker"],
  maximumDurationSeconds: 3_600,
  leaseTimeoutSeconds: 1_800,
  reuseSafetyMarginSeconds: 1_800,
  startupTimeoutSeconds: 180,
  egressConnectors: ["INTERNET_EGRESS"],
  ingressConnectors: ["NO_INGRESS"],
};

const context: RepositoryContext = {
  owner: "owner",
  repository: "repository",
  workflow: {
    repositoryId: "123",
    runId: "456",
    runAttempt: "1",
    job: "start-runner",
  },
};

describe("Action orchestration", () => {
  it("rejects warm reuse for fork-originated pull requests before mutation", async () => {
    const github = new MockGitHubJitClient();
    const microvms = new MockMicrovmClient();
    await expect(
      startRunner(
        { ...startConfig, server: "docker-builds" },
        { ...context, isForkPullRequest: true },
        github,
        microvms,
        createReporter().api,
      ),
    ).rejects.toThrow("not available to fork-originated pull requests");
    expect(github.createRequests).toEqual([]);
    expect(microvms.runRequests).toEqual([]);
  });

  it("starts one JIT runner, waits for both boundaries, and emits outputs", async () => {
    const jitSecret = "encoded-jit-secret";
    let runnerPolls = 0;
    let runnerName = "";
    const github = new MockGitHubJitClient({
      create: async (request) => {
        runnerName = request.runnerName;
        return {
          runnerId: 42,
          runnerName,
          encodedJitConfig: jitSecret,
        };
      },
      get: async () => {
        runnerPolls += 1;
        return {
          runnerId: 42,
          runnerName,
          status: runnerPolls === 1 ? "offline" : "online",
          busy: false,
        };
      },
    });
    let launchAttempts = 0;
    let microvmPolls = 0;
    const microvms = new MockMicrovmClient({
      run: async () => {
        launchAttempts += 1;
        if (launchAttempts === 1) {
          throw Object.assign(new Error("ambiguous"), {
            name: "TimeoutError",
          });
        }
        return {
          microvmId: "mvm-1",
          imageVersion: "7",
          endpoint: "mvm.example",
          startedAt: 1_000,
          maximumDurationSeconds: 7_200,
        };
      },
      get: async () => {
        microvmPolls += 1;
        return {
          microvmId: "mvm-1",
          state: microvmPolls === 1 ? "PENDING" : "RUNNING",
        };
      },
    });
    const reporter = createReporter();
    const runtime = createRuntime();

    const result = await startRunner(
      startConfig,
      context,
      github,
      microvms,
      reporter.api,
      runtime.api,
    );

    expect(result).toMatchObject({
      runnerId: 42,
      microvmId: "mvm-1",
      imageVersion: "7",
      region: "us-east-1",
    });
    expect(github.createRequests[0]?.labels).toEqual([
      result.label,
      "self-hosted",
      "linux",
      "ARM64",
      "lambda-microvm",
      "docker",
    ]);
    expect(microvms.runRequests).toHaveLength(2);
    expect(
      new Set(microvms.runRequests.map(({ clientToken }) => clientToken)).size,
    ).toBe(1);
    expect(
      decodeJitPayload(microvms.runRequests[0]?.runHookPayload ?? ""),
    ).toBe(jitSecret);
    expect(reporter.secrets).toContain(jitSecret);
    expect(reporter.outputs).toEqual({
      label: result.label,
      "runner-name": result.runnerName,
      "runner-id": "42",
      "microvm-id": "mvm-1",
      region: "us-east-1",
      "image-version": "7",
    });
    expect(github.deleteRequests).toEqual([]);
    expect(microvms.terminateRequests).toEqual([]);
    expect(runtime.maximumConcurrentSleeps).toBe(1);
  });

  it("cleans up the VM and JIT runner when runner readiness times out", async () => {
    let runnerName = "";
    const github = new MockGitHubJitClient({
      create: async (request) => {
        runnerName = request.runnerName;
        return {
          runnerId: 42,
          runnerName,
          encodedJitConfig: "jit-secret",
        };
      },
      get: async () => ({
        runnerId: 42,
        runnerName,
        status: "offline",
        busy: false,
      }),
      delete: async () => undefined,
    });
    const microvms = new MockMicrovmClient({
      run: async () => ({
        microvmId: "mvm-1",
        imageVersion: "7",
        endpoint: "mvm.example",
        startedAt: 1_000,
        maximumDurationSeconds: 7_200,
      }),
      get: async () => ({ microvmId: "mvm-1", state: "RUNNING" }),
      terminate: async () => undefined,
    });
    const runtime = createRuntime();

    await expect(
      startRunner(
        { ...startConfig, startupTimeoutSeconds: 1 },
        context,
        github,
        microvms,
        createReporter().api,
        runtime.api,
      ),
    ).rejects.toThrow("GitHub runner readiness timed out in us-east-1");

    expect(microvms.terminateRequests).toEqual(["mvm-1"]);
    expect(github.deleteRequests).toEqual([42]);
  });

  it("deletes the JIT runner without launching when its payload is oversized", async () => {
    const github = new MockGitHubJitClient({
      create: async (request) => ({
        runnerId: 42,
        runnerName: request.runnerName,
        encodedJitConfig: randomBytes(8_192).toString("base64"),
      }),
      delete: async () => undefined,
    });
    const microvms = new MockMicrovmClient();

    await expect(
      startRunner(
        startConfig,
        context,
        github,
        microvms,
        createReporter().api,
        createRuntime().api,
      ),
    ).rejects.toThrow("JIT payload encoding failed");

    expect(microvms.runRequests).toEqual([]);
    expect(github.deleteRequests).toEqual([42]);
  });

  it("reports capacity exhaustion without leaking external error text", async () => {
    const secret = "external-error-must-not-leak";
    const github = new MockGitHubJitClient({
      create: async (request) => ({
        runnerId: 42,
        runnerName: request.runnerName,
        encodedJitConfig: "jit-secret",
      }),
      delete: async () => undefined,
    });
    const microvms = new MockMicrovmClient({
      run: async () => {
        throw Object.assign(new Error(secret), {
          name: "ServiceQuotaExceededException",
        });
      },
    });

    let message = "";
    try {
      await startRunner(
        startConfig,
        context,
        github,
        microvms,
        createReporter().api,
        createRuntime().api,
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("capacity in us-east-1");
    expect(message).not.toContain(secret);
    expect(github.deleteRequests).toEqual([42]);
  });

  it("terminates idempotently and waits for absence", async () => {
    let polls = 0;
    const microvms = new MockMicrovmClient({
      terminate: async () => undefined,
      get: async () => {
        polls += 1;
        return polls === 1
          ? { microvmId: "mvm-1", state: "TERMINATING" }
          : undefined;
      },
    });
    const config: StopConfig = {
      mode: "stop",
      region: "us-east-1",
      debug: false,
      microvmId: "mvm-1",
    };

    await expect(
      stopRunner(config, microvms, createReporter().api, createRuntime().api),
    ).resolves.toBeUndefined();

    expect(microvms.terminateRequests).toEqual(["mvm-1"]);
    expect(microvms.getRequests).toEqual(["mvm-1", "mvm-1"]);
  });

  it("launches a warm supervisor and delivers a fresh JIT over control ingress", async () => {
    const github = onlineGitHub();
    const microvms = new MockMicrovmClient({
      run: async () => ({
        microvmId: "mvm-warm",
        imageVersion: "7",
        endpoint: "mvm.example",
        startedAt: 1_000,
        maximumDurationSeconds: 3_600,
      }),
      get: async () => ({ microvmId: "mvm-warm", state: "RUNNING" }),
      createAuthToken: async () => ({ token: "auth-secret" }),
    });
    const control = new MockControlClient();
    const reporter = createReporter();

    const result = await startRunner(
      {
        ...startConfig,
        server: "docker-builds",
        ingressConnectors: ["ALL_INGRESS"],
      },
      context,
      github,
      microvms,
      reporter.api,
      createRuntime().api,
      control,
    );

    expect(
      JSON.parse(
        decodeJitPayload(microvms.runRequests[0]?.runHookPayload ?? ""),
      ),
    ).toEqual({
      version: 2,
      mode: "warm",
      region: "us-east-1",
    });
    expect(microvms.authTokenRequests).toEqual([
      { microvmId: "mvm-warm", port: 8080, expirationMinutes: 5 },
    ]);
    expect(control.requests[0]).toMatchObject({
      endpoint: "mvm.example",
      port: 8080,
      authToken: "auth-secret",
      microvmId: "mvm-warm",
      encodedJitConfig: "jit-secret",
    });
    expect(result.warmHit).toBe(false);
    expect(decodeExplicitWarmHandle(result.server ?? "")).toMatchObject({
      microvmId: "mvm-warm",
      serverKeyHash: hashServerKey("docker-builds"),
    });
    expect(reporter.secrets).toContain("auth-secret");
    expect(reporter.secrets).toContain(result.server);
    expect(reporter.outputs["warm-hit"]).toBe("false");
  });

  it("resumes an explicit warm MicroVM and uses a different JIT request", async () => {
    let polls = 0;
    const github = onlineGitHub();
    const microvms = new MockMicrovmClient({
      get: async () => {
        polls += 1;
        return {
          microvmId: "mvm-warm",
          state: polls === 1 ? "SUSPENDED" : "RUNNING",
          imageVersion: "7",
          endpoint: "mvm.example",
          startedAt: 1_000,
          maximumDurationSeconds: 3_600,
        };
      },
      resume: async () => undefined,
      createAuthToken: async () => ({ token: "auth-secret" }),
    });
    const control = new MockControlClient();

    const result = await startRunner(
      {
        ...startConfig,
        server: encodeExplicitWarmHandle({
          version: 1,
          kind: "explicit",
          region: "us-east-1",
          microvmId: "mvm-warm",
          serverKeyHash: hashServerKey("docker-builds"),
          startedAt: 1_000,
          reuseDeadline: 1_801_000,
          expiresAt: 3_601_000,
        }),
      },
      context,
      github,
      microvms,
      createReporter().api,
      createRuntime(2_000).api,
      control,
    );

    expect(result.warmHit).toBe(true);
    expect(microvms.runRequests).toEqual([]);
    expect(microvms.resumeRequests).toEqual(["mvm-warm"]);
    expect(control.requests).toHaveLength(1);
  });

  it("suspends a warm handle before its deadline and terminates at the deadline", async () => {
    const handle = encodeExplicitWarmHandle({
      version: 1,
      kind: "explicit",
      region: "us-east-1",
      microvmId: "mvm-warm",
      serverKeyHash: hashServerKey("docker-builds"),
      startedAt: 1_000,
      reuseDeadline: 5_000,
      expiresAt: 6_000,
    });
    let polls = 0;
    const suspendClient = new MockMicrovmClient({
      suspend: async () => undefined,
      get: async () => ({
        microvmId: "mvm-warm",
        state: ++polls === 1 ? "SUSPENDING" : "SUSPENDED",
      }),
    });
    await stopRunner(
      { mode: "stop", region: "us-east-1", debug: false, server: handle },
      suspendClient,
      createReporter().api,
      createRuntime(4_000).api,
    );
    expect(suspendClient.suspendRequests).toEqual(["mvm-warm"]);

    const terminateClient = new MockMicrovmClient({
      terminate: async () => undefined,
      get: async () => undefined,
    });
    await stopRunner(
      { mode: "stop", region: "us-east-1", debug: false, server: handle },
      terminateClient,
      createReporter().api,
      createRuntime(5_000).api,
    );
    expect(terminateClient.terminateRequests).toEqual(["mvm-warm"]);
    expect(terminateClient.suspendRequests).toEqual([]);
  });

  it("creates and records a DynamoDB pool member before returning a fenced handle", async () => {
    const unversionedStartConfig = structuredClone(startConfig);
    delete unversionedStartConfig.imageVersion;
    const github = onlineGitHub();
    const microvms = new MockMicrovmClient({
      resolveImageVersion: async () => "7",
      run: async () => ({
        microvmId: "mvm-pool",
        imageVersion: "7",
        endpoint: "mvm.example",
        startedAt: 1_000,
        maximumDurationSeconds: 3_600,
      }),
      get: async () => ({ microvmId: "mvm-pool", state: "RUNNING" }),
      createAuthToken: async () => ({ token: "auth-secret" }),
    });
    const store = new MockWarmPoolStore();

    const result = await startRunner(
      {
        ...unversionedStartConfig,
        server: "docker-builds",
        stateTable: "warm-state",
        serverCapacity: 3,
        ingressConnectors: ["ALL_INGRESS"],
      },
      context,
      github,
      microvms,
      createReporter().api,
      createRuntime().api,
      new MockControlClient(),
      () => store,
    );

    expect(microvms.resolveImageVersionRequests).toEqual(["image"]);
    expect(store.acquireRequests[0]).toMatchObject({ serverCapacity: 3 });
    expect(store.created).toHaveLength(1);
    expect(store.created[0]?.created.maxLifetimeSeconds).toBe(3_600);
    expect(decodeServerHandle(result.server ?? "")).toMatchObject({
      kind: "pool",
      tableName: "warm-state",
      microvmId: "mvm-pool",
      leaseGeneration: 1,
    });
  });

  it("rejects a stale pool stop before making a lifecycle call", async () => {
    const handle = encodePoolWarmHandle({
      version: 1,
      kind: "pool",
      region: "us-east-1",
      tableName: "warm-state",
      poolKey: "REPOSITORY#123#SERVER#abc",
      memberId: "a".repeat(64),
      microvmId: "mvm-pool",
      leaseId: "b".repeat(64),
      leaseGeneration: 2,
      reuseDeadline: 5_000,
      expiresAt: 6_000,
    });
    const store = new MockWarmPoolStore();
    store.rejectRelease = true;
    const microvms = new MockMicrovmClient();

    await expect(
      stopRunner(
        {
          mode: "stop",
          region: "us-east-1",
          debug: false,
          server: handle,
        },
        microvms,
        createReporter().api,
        createRuntime(4_000).api,
        () => store,
      ),
    ).rejects.toThrow("stale or already released");
    expect(microvms.suspendRequests).toEqual([]);
    expect(microvms.terminateRequests).toEqual([]);
  });
});

class MockWarmPoolStore implements WarmPoolStore {
  public readonly acquireRequests: AcquireWarmPoolRequest[] = [];
  public readonly created: {
    member: WarmPoolMember;
    created: CreatedWarmMember;
  }[] = [];
  public rejectRelease = false;
  private member: WarmPoolMember | undefined;

  public async acquire(request: AcquireWarmPoolRequest) {
    this.acquireRequests.push(structuredClone(request));
    this.member = {
      poolKey: request.poolKey,
      memberId: "a".repeat(64),
      state: "CREATING",
      leaseId: request.leaseId,
      leaseGeneration: 1,
      acquisitionId: request.acquisitionId,
      leaseOwner: request.leaseOwner,
      leaseExpiresAt: request.leaseExpiresAt,
    };
    return { member: this.member, needsCreation: true };
  }

  public async markCreated(member: WarmPoolMember, created: CreatedWarmMember) {
    this.created.push({
      member: structuredClone(member),
      created: structuredClone(created),
    });
    this.member = { ...member, ...created, state: "LEASED" };
    return this.member;
  }

  public async beginRelease(member: WarmPoolMember, destroy: boolean) {
    if (this.rejectRelease) {
      throw new Error("conditional failure");
    }
    return {
      ...member,
      state: destroy ? ("DESTROYING" as const) : ("SUSPENDING" as const),
    };
  }

  public completeRelease(): Promise<void> {
    return Promise.resolve();
  }
  public markDead(): Promise<void> {
    return Promise.resolve();
  }
  public abandonCreation(): Promise<void> {
    return Promise.resolve();
  }
  public async reconciliationCandidates(): Promise<WarmPoolMember[]> {
    return [];
  }
  public async beginReconciliation(): Promise<WarmPoolMember | undefined> {
    return undefined;
  }
  public markReconciledDead(): Promise<void> {
    return Promise.resolve();
  }
}

class MockControlClient implements MicrovmControlClient {
  public readonly requests: StartControlledRunnerRequest[] = [];

  public async startRunner(
    request: StartControlledRunnerRequest,
  ): Promise<void> {
    this.requests.push(structuredClone(request));
  }
}

function onlineGitHub(): MockGitHubJitClient {
  let runnerName = "";
  return new MockGitHubJitClient({
    create: async (request) => {
      runnerName = request.runnerName;
      return { runnerId: 42, runnerName, encodedJitConfig: "jit-secret" };
    },
    get: async () => ({
      runnerId: 42,
      runnerName,
      status: "online",
      busy: false,
    }),
  });
}

function createReporter(): {
  api: ActionReporter;
  outputs: Record<string, string>;
  secrets: string[];
} {
  const outputs: Record<string, string> = {};
  const secrets: string[] = [];
  return {
    outputs,
    secrets,
    api: {
      setSecret: (secret) => {
        secrets.push(secret);
      },
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      info: vi.fn(),
      debug: vi.fn(),
      warning: vi.fn(),
    },
  };
}

function createRuntime(initialTime = 0): {
  api: ActionRuntime;
  maximumConcurrentSleeps: number;
} {
  let time = initialTime;
  let concurrentSleeps = 0;
  const state = {
    maximumConcurrentSleeps: 0,
  };
  return {
    get maximumConcurrentSleeps() {
      return state.maximumConcurrentSleeps;
    },
    api: {
      now: () => time,
      random: () => 0,
      sleep: async (milliseconds) => {
        concurrentSleeps += 1;
        state.maximumConcurrentSleeps = Math.max(
          state.maximumConcurrentSleeps,
          concurrentSleeps,
        );
        time += milliseconds;
        await Promise.resolve();
        concurrentSleeps -= 1;
      },
    },
  };
}
