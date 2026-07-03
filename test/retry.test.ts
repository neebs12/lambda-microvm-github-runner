import { describe, expect, it, vi } from "vitest";

import { fullJitterDelay, retryWithFullJitter } from "../src/retry.js";

describe("bounded full-jitter retry", () => {
  it("keeps every delay inside its exponential cap", () => {
    expect(fullJitterDelay(0, 1_000, 16_000, () => 0)).toBe(0);
    expect(fullJitterDelay(0, 1_000, 16_000, () => 0.999_999)).toBe(1_000);
    expect(fullJitterDelay(4, 1_000, 16_000, () => 0.999_999)).toBe(16_000);
    expect(fullJitterDelay(8, 1_000, 16_000, () => 0.999_999)).toBe(16_000);
  });

  it("retries throttling with bounded delays", async () => {
    let time = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      time += milliseconds;
    });
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("throttled"), {
          name: "ThrottlingException",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("server"), {
          name: "InternalServerException",
        }),
      )
      .mockResolvedValue("created");

    await expect(
      retryWithFullJitter(task, {
        operation: "RunMicrovm",
        deadline: 20_000,
        baseDelayMs: 1_000,
        maxDelayMs: 16_000,
        random: () => 0.5,
        now: () => time,
        sleep,
      }),
    ).resolves.toBe("created");

    expect(task).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1_000]]);
  });

  it("reuses the same launch client token across ambiguous retries", async () => {
    const clientToken = "lambda-mvm-deterministic";
    const observedTokens: string[] = [];
    let time = 1;

    await retryWithFullJitter(
      async (attempt) => {
        observedTokens.push(clientToken);
        if (attempt < 3) {
          throw Object.assign(new Error("ambiguous response"), {
            name: "TimeoutError",
          });
        }
        return "mvm-1";
      },
      {
        operation: "RunMicrovm",
        deadline: 10_000,
        random: () => 0,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
      },
    );

    expect(observedTokens).toEqual([clientToken, clientToken, clientToken]);
  });

  it("does not retry capacity or fatal failures", async () => {
    const capacity = vi.fn(async () => {
      throw Object.assign(new Error("account details"), {
        name: "ServiceQuotaExceededException",
      });
    });
    const fatalSecret = "payload-must-not-appear";
    const fatal = vi.fn(async () => {
      throw Object.assign(new Error(fatalSecret), {
        name: "ValidationException",
      });
    });

    await expect(
      retryWithFullJitter(capacity, {
        operation: "RunMicrovm",
        deadline: Date.now() + 10_000,
      }),
    ).rejects.toThrow("capacity (ServiceQuotaExceededException)");
    await expect(
      retryWithFullJitter(fatal, {
        operation: "RunMicrovm",
        deadline: Date.now() + 10_000,
      }),
    ).rejects.not.toThrow(fatalSecret);

    expect(capacity).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledOnce();
  });

  it("retries HTTP throttling and transient network error codes", async () => {
    let time = 0;
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("network"), {
          code: "ECONNRESET",
        }),
      )
      .mockRejectedValueOnce({
        name: "UnknownAwsError",
        $metadata: { httpStatusCode: 429 },
      })
      .mockResolvedValue("ok");

    await expect(
      retryWithFullJitter(task, {
        operation: "RunMicrovm",
        deadline: 10_000,
        random: () => 0,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(3);
  });
});
