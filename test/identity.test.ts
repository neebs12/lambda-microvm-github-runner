import { describe, expect, it } from "vitest";

import {
  createRunnerLabels,
  createRunnerIdentity,
  workflowIdentityFromEnvironment,
  type WorkflowIdentity,
} from "../src/identity.js";

const workflow: WorkflowIdentity = {
  repositoryId: "12345",
  runId: "987654321",
  runAttempt: "2",
  job: "start-runner",
};

describe("runner identity", () => {
  it("is deterministic and collision-resistant", () => {
    const first = createRunnerIdentity(workflow);
    const second = createRunnerIdentity({ ...workflow });

    expect(first).toEqual(second);
    expect(first.label).toMatch(/^lambda-mvm-12345-987654321-2-[a-f0-9]{12}$/);
    expect(first.runnerName).toBe(first.label);
    expect(first.clientToken).toMatch(/^lambda-mvm-[a-f0-9]{64}$/);
  });

  it("changes when any identity component or suffix changes", () => {
    const baseline = createRunnerIdentity(workflow);
    const variants = [
      createRunnerIdentity({ ...workflow, repositoryId: "12346" }),
      createRunnerIdentity({ ...workflow, runId: "987654322" }),
      createRunnerIdentity({ ...workflow, runAttempt: "3" }),
      createRunnerIdentity({ ...workflow, job: "another-job" }),
      createRunnerIdentity(workflow, "second-start"),
    ];

    for (const variant of variants) {
      expect(variant).not.toEqual(baseline);
    }
  });

  it("stays within the runner name limit", () => {
    const identity = createRunnerIdentity({
      repositoryId: "9".repeat(40),
      runId: "8".repeat(40),
      runAttempt: "123",
      job: "job",
    });

    expect(identity.label.length).toBeLessThanOrEqual(64);
    expect(identity.label).toMatch(/-[a-f0-9]{16}$/);
  });

  it("adds required platform labels and deduplicates additions", () => {
    expect(
      createRunnerLabels("lambda-mvm-1-2-3-abc", ["docker", "LINUX", "docker"]),
    ).toEqual([
      "lambda-mvm-1-2-3-abc",
      "self-hosted",
      "linux",
      "ARM64",
      "lambda-microvm",
      "docker",
    ]);
  });

  it("reads and validates GitHub workflow environment values", () => {
    expect(
      workflowIdentityFromEnvironment({
        GITHUB_REPOSITORY_ID: "1",
        GITHUB_RUN_ID: "2",
        GITHUB_RUN_ATTEMPT: "3",
        GITHUB_JOB: "start",
      }),
    ).toEqual({
      repositoryId: "1",
      runId: "2",
      runAttempt: "3",
      job: "start",
    });

    expect(() =>
      workflowIdentityFromEnvironment({
        GITHUB_REPOSITORY_ID: "1",
        GITHUB_RUN_ID: "2",
        GITHUB_RUN_ATTEMPT: "0",
        GITHUB_JOB: "start",
      }),
    ).toThrow("GITHUB_RUN_ATTEMPT");
  });
});
