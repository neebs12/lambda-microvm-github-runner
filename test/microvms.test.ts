import {
  GetMicrovmCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { describe, expect, it, vi } from "vitest";

import {
  AwsMicrovmClient,
  MicrovmResponseError,
  type MicrovmCommandSender,
} from "../src/microvms.js";

describe("AwsMicrovmClient", () => {
  it("maps the launch contract to RunMicrovm", async () => {
    const send = vi.fn<MicrovmCommandSender>(async (command) => {
      expect(command).toBeInstanceOf(RunMicrovmCommand);
      expect(command.input).toEqual({
        imageIdentifier: "image",
        imageVersion: "7",
        executionRoleArn: "arn:aws:iam::123456789012:role/runner",
        maximumDurationInSeconds: 3_600,
        ingressNetworkConnectors: ["NO_INGRESS"],
        egressNetworkConnectors: ["INTERNET_EGRESS"],
        runHookPayload: "masked-payload",
        clientToken: "stable-token",
        logging: {
          cloudWatch: {
            logGroup: "/runner/logs",
          },
        },
      });
      return {
        microvmId: "mvm-1",
        imageVersion: "7",
        endpoint: "must-not-be-returned",
      };
    });
    const client = new AwsMicrovmClient(send);

    await expect(
      client.run({
        clientToken: "stable-token",
        region: "us-east-1",
        imageId: "image",
        imageVersion: "7",
        executionRoleArn: "arn:aws:iam::123456789012:role/runner",
        maximumDurationSeconds: 3_600,
        ingressConnectors: ["NO_INGRESS"],
        egressConnectors: ["INTERNET_EGRESS"],
        runHookPayload: "masked-payload",
        cloudwatchLogGroup: "/runner/logs",
      }),
    ).resolves.toEqual({
      microvmId: "mvm-1",
      imageVersion: "7",
    });
  });

  it("maps get and terminate commands", async () => {
    const send = vi
      .fn<MicrovmCommandSender>()
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(GetMicrovmCommand);
        expect(command.input).toEqual({ microvmIdentifier: "mvm-1" });
        return {
          microvmId: "mvm-1",
          state: "RUNNING",
          stateReason: "ready",
          imageVersion: "7",
        };
      })
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(TerminateMicrovmCommand);
        expect(command.input).toEqual({ microvmIdentifier: "mvm-1" });
        return {};
      });
    const client = new AwsMicrovmClient(send);

    await expect(client.get("mvm-1")).resolves.toEqual({
      microvmId: "mvm-1",
      state: "RUNNING",
      stateReason: "ready",
      imageVersion: "7",
    });
    await expect(client.terminate("mvm-1")).resolves.toBeUndefined();
  });

  it("treats AWS not-found responses as idempotent absence", async () => {
    const notFound = Object.assign(new Error("details"), {
      name: "ResourceNotFoundException",
    });
    const send = vi
      .fn<MicrovmCommandSender>()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound);
    const client = new AwsMicrovmClient(send);

    await expect(client.get("missing")).resolves.toBeUndefined();
    await expect(client.terminate("missing")).resolves.toBeUndefined();
  });

  it("rejects malformed launch responses safely", async () => {
    const send = vi.fn<MicrovmCommandSender>(async () => ({
      endpoint: "secret-endpoint",
    }));
    const client = new AwsMicrovmClient(send);

    await expect(
      client.run({
        clientToken: "stable-token",
        region: "us-east-1",
        imageId: "image",
        executionRoleArn: "arn:aws:iam::123456789012:role/runner",
        maximumDurationSeconds: 3_600,
        ingressConnectors: [],
        egressConnectors: [],
        runHookPayload: "secret-payload",
      }),
    ).rejects.toEqual(expect.any(MicrovmResponseError));
  });
});
