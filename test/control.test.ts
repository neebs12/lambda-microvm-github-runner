import { describe, expect, it, vi } from "vitest";

import {
  HttpMicrovmControlClient,
  MicrovmControlError,
  type FetchLike,
} from "../src/control.js";

describe("HttpMicrovmControlClient", () => {
  it("sends JIT data only to the port-scoped authenticated endpoint", async () => {
    const fetchRequest = vi.fn<FetchLike>(
      async () => new Response("accepted", { status: 202 }),
    );
    const client = new HttpMicrovmControlClient(fetchRequest);

    await client.startRunner({
      endpoint: "mvm.example",
      port: 8080,
      authToken: "auth-secret",
      requestId: "request-1",
      microvmId: "mvm-1",
      encodedJitConfig: "jit-secret",
    });

    const [url, init] = fetchRequest.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).toString()).toBe("https://mvm.example/v1/runner/start");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-aws-proxy-auth": "auth-secret",
      "x-aws-proxy-port": "8080",
    });
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init?.body as string)).toEqual({
      version: 1,
      requestId: "request-1",
      microvmId: "mvm-1",
      jit: "jit-secret",
    });
  });

  it("returns sanitized endpoint failures", async () => {
    const secret = "must-not-appear";
    const client = new HttpMicrovmControlClient(
      async () => new Response(secret, { status: 403 }),
    );
    let message = "";
    try {
      await client.startRunner({
        endpoint: "mvm.example",
        port: 8080,
        authToken: secret,
        requestId: "request-1",
        microvmId: "mvm-1",
        encodedJitConfig: secret,
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(MicrovmControlError);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "MicroVM control request failed: endpoint returned HTTP 403",
    );
    expect(message).not.toContain(secret);
  });
});
