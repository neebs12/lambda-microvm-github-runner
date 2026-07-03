import { describe, expect, it } from "vitest";

import { MockGitHubJitClient, MockMicrovmClient } from "./mocks/clients.js";

describe("client test doubles", () => {
  it("records GitHub requests without a live boundary", async () => {
    const client = new MockGitHubJitClient({
      create: async (request) => ({
        runnerId: 42,
        runnerName: request.runnerName,
        encodedJitConfig: "masked-jit",
      }),
    });

    await expect(
      client.createJitRunner({
        owner: "example",
        repository: "repo",
        runnerName: "runner-1",
        runnerGroupId: 1,
        labels: ["self-hosted", "ARM64"],
      }),
    ).resolves.toMatchObject({ runnerId: 42 });
    expect(client.createRequests).toHaveLength(1);
  });

  it("records AWS requests and preserves deterministic tokens", async () => {
    const client = new MockMicrovmClient({
      run: async () => ({
        microvmId: "mvm-1",
        imageVersion: "7",
      }),
    });
    const request = {
      clientToken: "stable-token",
      region: "us-east-1",
      imageId: "image",
      executionRoleArn: "arn:aws:iam::123456789012:role/runner",
      maximumDurationSeconds: 3_600,
      ingressConnectors: ["NO_INGRESS"],
      egressConnectors: ["INTERNET_EGRESS"],
      runHookPayload: "masked-payload",
    };

    await client.run(request);
    await client.run(request);

    expect(client.runRequests.map(({ clientToken }) => clientToken)).toEqual([
      "stable-token",
      "stable-token",
    ]);
  });
});
