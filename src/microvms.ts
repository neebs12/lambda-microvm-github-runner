import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
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
  | CreateMicrovmAuthTokenCommand
  | GetMicrovmCommand
  | GetMicrovmImageCommand
  | ResumeMicrovmCommand
  | RunMicrovmCommand
  | SuspendMicrovmCommand
  | TerminateMicrovmCommand;

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

  public async resolveImageVersion(imageId: string): Promise<string> {
    const response = asRecord(
      await this.send(new GetMicrovmImageCommand({ imageIdentifier: imageId })),
    );
    const version = stringValue(response.latestActiveImageVersion);
    if (version === undefined) {
      throw new MicrovmResponseError("GetMicrovmImage");
    }
    return version;
  }

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
    const endpoint = stringValue(response.endpoint);
    const startedAt = dateMilliseconds(response.startedAt);
    const maximumDurationSeconds = numberValue(
      response.maximumDurationInSeconds,
    );
    if (
      microvmId === undefined ||
      imageVersion === undefined ||
      endpoint === undefined ||
      startedAt === undefined ||
      maximumDurationSeconds === undefined
    ) {
      throw new MicrovmResponseError("RunMicrovm");
    }
    return {
      microvmId,
      imageVersion,
      endpoint,
      startedAt,
      maximumDurationSeconds,
    };
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
      const endpoint = stringValue(response.endpoint);
      const startedAt = dateMilliseconds(response.startedAt);
      const maximumDurationSeconds = numberValue(
        response.maximumDurationInSeconds,
      );
      if (responseId === undefined || state === undefined) {
        throw new MicrovmResponseError("GetMicrovm");
      }
      return {
        microvmId: responseId,
        state,
        ...(stateReason === undefined ? {} : { stateReason }),
        ...(imageVersion === undefined ? {} : { imageVersion }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(maximumDurationSeconds === undefined
          ? {}
          : { maximumDurationSeconds }),
      };
    } catch (error: unknown) {
      if (getSafeErrorName(error) === "ResourceNotFoundException") {
        return undefined;
      }
      throw error;
    }
  }

  public async suspend(microvmId: string): Promise<void> {
    await this.send(
      new SuspendMicrovmCommand({ microvmIdentifier: microvmId }),
    );
  }

  public async resume(microvmId: string): Promise<void> {
    await this.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  public async createAuthToken(
    microvmId: string,
    port: number,
    expirationMinutes: number,
  ): Promise<{ token: string }> {
    const response = asRecord(
      await this.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: microvmId,
          expirationInMinutes: expirationMinutes,
          allowedPorts: [{ port }],
        }),
      ),
    );
    const tokens = asRecord(response.authToken);
    const token = stringValue(tokens["X-aws-proxy-auth"]);
    if (token === undefined) {
      throw new MicrovmResponseError("CreateMicrovmAuthToken");
    }
    return { token };
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function dateMilliseconds(value: unknown): number | undefined {
  if (!(value instanceof Date)) {
    return undefined;
  }
  const milliseconds = value.getTime();
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}
