import type {
  GetMicrovmCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { describe, expect, it, vi } from "vitest";

import type { StartConfig } from "../../src/config.js";
import {
  RepositoryGitHubJitClient,
  type GitHubRequester,
} from "../../src/github.js";
import {
  AwsMicrovmClient,
  type MicrovmCommandSender,
} from "../../src/microvms.js";
import {
  startRunner,
  type ActionReporter,
  type ActionRuntime,
} from "../../src/orchestration.js";

describe("Action integration across mocked HTTP and AWS boundaries", () => {
  it("translates a complete start flow without external network calls", async () => {
    let runnerName = "";
    let githubPolls = 0;
    const githubRequest = vi.fn<GitHubRequester>(async (route, parameters) => {
      if (route.startsWith("POST ")) {
        runnerName = String(parameters.name);
        return {
          status: 201,
          data: {
            runner: {
              id: 42,
              name: runnerName,
              status: "offline",
              busy: false,
            },
            encoded_jit_config: "integration-jit-secret",
          },
        };
      }
      if (route.startsWith("GET ")) {
        githubPolls += 1;
        return {
          status: 200,
          data: {
            id: 42,
            name: runnerName,
            status: githubPolls === 1 ? "offline" : "online",
            busy: false,
          },
        };
      }
      throw new Error("Unexpected GitHub route");
    });
    const github = new RepositoryGitHubJitClient(
      "owner",
      "repository",
      githubRequest,
    );

    let awsPolls = 0;
    const awsSend = vi.fn<MicrovmCommandSender>(async (command) => {
      const commandName = command.constructor.name;
      if (commandName === "RunMicrovmCommand") {
        const input = (command as RunMicrovmCommand).input;
        expect(input.clientToken).toMatch(/^lambda-mvm-[a-f0-9]{64}$/);
        expect(input.runHookPayload).not.toContain("integration-jit-secret");
        return { microvmId: "mvm-1", state: "PENDING", imageVersion: "7" };
      }
      if (commandName === "GetMicrovmCommand") {
        expect((command as GetMicrovmCommand).input).toEqual({
          microvmIdentifier: "mvm-1",
        });
        awsPolls += 1;
        return {
          microvmId: "mvm-1",
          state: awsPolls === 1 ? "PENDING" : "RUNNING",
          imageVersion: "7",
        };
      }
      if (commandName === "TerminateMicrovmCommand") {
        expect((command as TerminateMicrovmCommand).input).toEqual({
          microvmIdentifier: "mvm-1",
        });
        return {};
      }
      throw new Error("Unexpected AWS command");
    });
    const microvms = new AwsMicrovmClient(awsSend);
    const outputs: Record<string, string> = {};
    const reporter: ActionReporter = {
      setSecret: vi.fn(),
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      info: vi.fn(),
      debug: vi.fn(),
      warning: vi.fn(),
    };
    let time = 0;
    const runtime: ActionRuntime = {
      now: () => time,
      random: () => 0,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    };

    const result = await startRunner(
      startConfig,
      {
        owner: "owner",
        repository: "repository",
        workflow: {
          repositoryId: "1",
          runId: "2",
          runAttempt: "1",
          job: "start-runner",
        },
      },
      github,
      microvms,
      reporter,
      runtime,
    );

    expect(result.microvmId).toBe("mvm-1");
    expect(outputs["runner-id"]).toBe("42");
    expect(githubRequest).toHaveBeenCalledTimes(3);
    expect(awsSend).toHaveBeenCalledTimes(3);
  });
});

const startConfig: StartConfig = {
  mode: "start",
  region: "us-east-1",
  debug: false,
  githubToken: "github-token",
  imageId: "image",
  imageVersion: "7",
  executionRoleArn: "arn:aws:iam::123456789012:role/runner",
  runnerGroupId: 1,
  runnerLabels: ["docker"],
  maximumDurationSeconds: 3_600,
  startupTimeoutSeconds: 180,
  egressConnectors: ["INTERNET_EGRESS"],
  ingressConnectors: ["NO_INGRESS"],
};
