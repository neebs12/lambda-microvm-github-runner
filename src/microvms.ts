import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";

import type {
  Microvm,
  MicrovmClient,
  RunMicrovmRequest,
  RunMicrovmResult,
} from "./clients.js";
import { getSafeErrorName } from "./retry.js";

type MicrovmCommand =
  GetMicrovmCommand | RunMicrovmCommand | TerminateMicrovmCommand;

export type MicrovmCommandSender = (
  command: MicrovmCommand,
) => Promise<unknown>;

export class MicrovmResponseError extends Error {
  public constructor(operation: string) {
    super(`AWS ${operation} returned an invalid response`);
    this.name = "MicrovmResponseError";
  }
}

export class AwsMicrovmClient implements MicrovmClient {
  public constructor(private readonly send: MicrovmCommandSender) {}

  public async run(request: RunMicrovmRequest): Promise<RunMicrovmResult> {
    const response = asRecord(
      await this.send(
        new RunMicrovmCommand({
          imageIdentifier: request.imageId,
          executionRoleArn: request.executionRoleArn,
          maximumDurationInSeconds: request.maximumDurationSeconds,
          ingressNetworkConnectors: request.ingressConnectors,
          egressNetworkConnectors: request.egressConnectors,
          runHookPayload: request.runHookPayload,
          clientToken: request.clientToken,
          ...(request.imageVersion === undefined
            ? {}
            : { imageVersion: request.imageVersion }),
          ...(request.cloudwatchLogGroup === undefined
            ? {}
            : {
                logging: {
                  cloudWatch: {
                    logGroup: request.cloudwatchLogGroup,
                  },
                },
              }),
        }),
      ),
    );
    const microvmId = stringValue(response.microvmId);
    const imageVersion = stringValue(response.imageVersion);
    if (microvmId === undefined || imageVersion === undefined) {
      throw new MicrovmResponseError("RunMicrovm");
    }
    return { microvmId, imageVersion };
  }

  public async get(microvmId: string): Promise<Microvm | undefined> {
    try {
      const response = asRecord(
        await this.send(
          new GetMicrovmCommand({ microvmIdentifier: microvmId }),
        ),
      );
      const responseId = stringValue(response.microvmId);
      const state = stringValue(response.state);
      const stateReason = stringValue(response.stateReason);
      const imageVersion = stringValue(response.imageVersion);
      if (responseId === undefined || state === undefined) {
        throw new MicrovmResponseError("GetMicrovm");
      }
      return {
        microvmId: responseId,
        state,
        ...(stateReason === undefined ? {} : { stateReason }),
        ...(imageVersion === undefined ? {} : { imageVersion }),
      };
    } catch (error: unknown) {
      if (getSafeErrorName(error) === "ResourceNotFoundException") {
        return undefined;
      }
      throw error;
    }
  }

  public async terminate(microvmId: string): Promise<void> {
    try {
      await this.send(
        new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
      );
    } catch (error: unknown) {
      if (getSafeErrorName(error) !== "ResourceNotFoundException") {
        throw error;
      }
    }
  }
}

export function createAwsMicrovmClient(region: string): MicrovmClient {
  const client = new LambdaMicrovmsClient({
    region,
    maxAttempts: 1,
  });
  const send = client.send.bind(client) as unknown as MicrovmCommandSender;
  return new AwsMicrovmClient(send);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
