import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { StartConfig, StopConfig } from "../src/config.js";
import { decodeJitPayload } from "../src/payload.js";
import {
  startRunner,
  stopRunner,
  type ActionReporter,
  type ActionRuntime,
  type RepositoryContext,
} from "../src/orchestration.js";
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
        return { microvmId: "mvm-1", imageVersion: "7" };
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
      run: async () => ({ microvmId: "mvm-1", imageVersion: "7" }),
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
});

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

function createRuntime(): {
  api: ActionRuntime;
  maximumConcurrentSleeps: number;
} {
  let time = 0;
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
