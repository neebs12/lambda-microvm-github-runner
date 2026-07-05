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
    expect(sleep.mock.calls).toEqual([[2_500], [1_875], [2_813]]);
  });

  it("keeps 200 simulated starters within the 100 TPS polling budget", async () => {
    const observationTimes: number[] = [];

    await Promise.all(
      Array.from({ length: 200 }, async (_value, runnerIndex) => {
        let time = 0;
        let observations = 0;
        let seed = Math.imul(runnerIndex + 1, 2_654_435_761) >>> 0;
        const random = (): number => {
          seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
          return seed / 2 ** 32;
        };

        await pollSequentially({
          operation: "GetMicrovm",
          deadline: 60_000,
          observe: async () => {
            observationTimes.push(time);
            observations += 1;
            return observations;
          },
          decide: (value) =>
            value === 5
              ? { status: "success", value: undefined }
              : { status: "pending" },
          random,
          now: () => time,
          sleep: async (milliseconds) => {
            time += milliseconds;
          },
        });
      }),
    );

    const callsPerSecond = new Map<number, number>();
    for (const time of observationTimes) {
      const second = Math.floor(time / 1_000);
      callsPerSecond.set(second, (callsPerSecond.get(second) ?? 0) + 1);
    }

    expect(observationTimes).toHaveLength(1_000);
    expect(Math.max(...callsPerSecond.values())).toBeLessThanOrEqual(100);
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

  it("classifies an already-expired deadline as a timeout", async () => {
    await expect(
      pollSequentially({
        operation: "GetMicrovm",
        deadline: 1_000,
        observe: async () => "PENDING",
        decide: () => ({ status: "pending" }),
        now: () => 1_000,
      }),
    ).rejects.toThrow("polling failed: deadline");
  });
});
