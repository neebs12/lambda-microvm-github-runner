import { createHash } from "node:crypto";

const MAX_RUNNER_NAME_LENGTH = 64;
const REQUIRED_RUNNER_LABELS = [
  "self-hosted",
  "linux",
  "ARM64",
  "lambda-microvm",
] as const;

export type WorkflowIdentity = {
  repositoryId: string;
  runId: string;
  runAttempt: string;
  job: string;
};

export type RunnerIdentity = {
  label: string;
  runnerName: string;
  clientToken: string;
};

export class WorkflowIdentityError extends Error {
  public constructor(field: string) {
    super(`GitHub workflow identity '${field}' is missing or invalid`);
    this.name = "WorkflowIdentityError";
  }
}

export function workflowIdentityFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowIdentity {
  return {
    repositoryId: positiveInteger(
      environment.GITHUB_REPOSITORY_ID,
      "GITHUB_REPOSITORY_ID",
    ),
    runId: positiveInteger(environment.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    runAttempt: positiveInteger(
      environment.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT",
    ),
    job: nonEmpty(environment.GITHUB_JOB, "GITHUB_JOB"),
  };
}

export function createRunnerIdentity(
  workflow: WorkflowIdentity,
  idempotencyKey?: string,
): RunnerIdentity {
  validateWorkflowIdentity(workflow);

  const canonicalIdentity = JSON.stringify({
    repositoryId: workflow.repositoryId,
    runId: workflow.runId,
    runAttempt: workflow.runAttempt,
    job: workflow.job,
    idempotencyKey: idempotencyKey ?? "",
  });
  const digest = sha256(canonicalIdentity);
  const jobHash = digest.slice(0, 12);
  const prefix = [
    "lambda-mvm",
    workflow.repositoryId,
    workflow.runId,
    workflow.runAttempt,
  ].join("-");
  const label = truncateWithHash(`${prefix}-${jobHash}`, digest);

  return {
    label,
    runnerName: label,
    clientToken: `lambda-mvm-${digest}`,
  };
}

export function createRunnerLabels(
  uniqueLabel: string,
  additionalLabels: readonly string[],
): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(uniqueLabel)) {
    throw new WorkflowIdentityError("uniqueLabel");
  }

  const labels = new Map<string, string>();
  for (const label of [
    uniqueLabel,
    ...REQUIRED_RUNNER_LABELS,
    ...additionalLabels,
  ]) {
    const key = label.toLowerCase();
    if (!labels.has(key)) {
      labels.set(key, label);
    }
  }
  return [...labels.values()];
}

function validateWorkflowIdentity(workflow: WorkflowIdentity): void {
  positiveInteger(workflow.repositoryId, "repositoryId");
  positiveInteger(workflow.runId, "runId");
  positiveInteger(workflow.runAttempt, "runAttempt");
  nonEmpty(workflow.job, "job");
}

function positiveInteger(value: string | undefined, field: string): string {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new WorkflowIdentityError(field);
  }
  return value;
}

function nonEmpty(value: string | undefined, field: string): string {
  if (
    value === undefined ||
    value.trim().length === 0 ||
    containsControlCharacter(value)
  ) {
    throw new WorkflowIdentityError(field);
  }
  return value;
}

function truncateWithHash(value: string, digest: string): string {
  if (value.length <= MAX_RUNNER_NAME_LENGTH) {
    return value;
  }
  const suffix = `-${digest.slice(0, 16)}`;
  return `${value.slice(0, MAX_RUNNER_NAME_LENGTH - suffix.length)}${suffix}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}
