import { describe, expect, it, vi } from "vitest";

import { pollSequentially } from "../src/polling.js";

describe("quota-aware polling", () => {
  it("randomizes intervals and never overlaps observations", async () => {
    let time = 1_000;
    let active = 0;
    let maximumActive = 0;
    let observations = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      time += milliseconds;
    });

    const result = await pollSequentially({
      operation: "GetMicrovm",
      deadline: 30_000,
      observe: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        observations += 1;
        active -= 1;
        return observations;
      },
      decide: (value) => {
        return value === 3
          ? { status: "success", value: "RUNNING" }
          : { status: "pending" };
      },
      random: () => 0.5,
      now: () => time,
      sleep,
    });

    expect(result).toBe("RUNNING");
    expect(maximumActive).toBe(1);
    expect(sleep.mock.calls).toEqual([[1_000], [1_500], [2_250]]);
  });

  it("stops immediately on a terminal state and sanitizes its reason", async () => {
    const secret = "state reason contains sensitive request";

    await expect(
      pollSequentially({
        operation: "GetMicrovm",
        deadline: Date.now() + 10_000,
        observe: async () => "TERMINATED",
        decide: () => ({ status: "failure", reason: secret }),
        initialDelayMaxMs: 0,
      }),
    ).rejects.not.toThrow(secret);
  });

  it("honors the overall deadline", async () => {
    let time = 0;

    await expect(
      pollSequentially({
        operation: "GetMicrovm",
        deadline: 2_500,
        observe: async () => "PENDING",
        decide: () => ({ status: "pending" }),
        initialDelayMaxMs: 0,
        random: () => 0.999,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).rejects.toThrow("deadline");
  });
});
