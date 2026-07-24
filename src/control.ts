import type {
  MicrovmControlClient,
  StartControlledRunnerRequest,
} from "./clients.js";

const CONTROL_TIMEOUT_MS = 30_000;

export class MicrovmControlError extends Error {
  public constructor(reason: string) {
    super(`MicroVM control request failed: ${reason}`);
    this.name = "MicrovmControlError";
  }
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HttpMicrovmControlClient implements MicrovmControlClient {
  public constructor(private readonly fetchRequest: FetchLike = fetch) {}

  public async startRunner(
    request: StartControlledRunnerRequest,
  ): Promise<void> {
    const endpoint = normalizeEndpoint(request.endpoint);
    let response: Response;
    try {
      response = await this.fetchRequest(
        new URL("/v1/runner/start", endpoint),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-aws-proxy-auth": request.authToken,
            "x-aws-proxy-port": String(request.port),
          },
          body: JSON.stringify({
            version: 1,
            requestId: request.requestId,
            microvmId: request.microvmId,
            jit: request.encodedJitConfig,
          }),
          signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        },
      );
    } catch {
      throw new MicrovmControlError("endpoint was unavailable");
    }
    if (response.status !== 202) {
      throw new MicrovmControlError(
        `endpoint returned HTTP ${String(response.status)}`,
      );
    }
  }
}

function normalizeEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new MicrovmControlError("AWS returned an invalid endpoint");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new MicrovmControlError("AWS returned an invalid endpoint");
  }
  return endpoint;
}
