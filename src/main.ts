import * as core from "@actions/core";

import { parseActionConfig, type RawActionInputs } from "./config.js";
import { createGitHubJitClient } from "./github.js";
import { workflowIdentityFromEnvironment } from "./identity.js";
import { createAwsMicrovmClient } from "./microvms.js";
import {
  startRunner,
  stopRunner,
  type ActionReporter,
  type RepositoryContext,
} from "./orchestration.js";

export class ActionEnvironmentError extends Error {
  public constructor(field: string) {
    super(`GitHub Actions environment '${field}' is missing or invalid`);
    this.name = "ActionEnvironmentError";
  }
}

export async function run(): Promise<void> {
  const raw = readActionInputs();
  if (raw.githubToken !== undefined && raw.githubToken.length > 0) {
    core.setSecret(raw.githubToken);
  }

  const config = parseActionConfig(raw);
  const microvms = createAwsMicrovmClient(config.region);
  const reporter = actionReporter();

  if (config.mode === "start") {
    const context = repositoryContextFromEnvironment();
    const github = createGitHubJitClient(
      config.githubToken,
      context.owner,
      context.repository,
    );
    await startRunner(config, context, github, microvms, reporter);
  } else {
    await stopRunner(config, microvms, reporter);
  }
}

function readActionInputs(): RawActionInputs {
  return {
    mode: core.getInput("mode"),
    githubToken: core.getInput("github-token"),
    imageId: core.getInput("image-id"),
    imageVersion: core.getInput("image-version"),
    executionRoleArn: core.getInput("execution-role-arn"),
    region: core.getInput("region"),
    runnerGroupId: core.getInput("runner-group-id"),
    runnerLabels: core.getInput("runner-labels"),
    maxLifetimeSeconds: core.getInput("max-lifetime-seconds"),
    maximumDurationSeconds: core.getInput("maximum-duration-seconds"),
    startupTimeoutSeconds: core.getInput("startup-timeout-seconds"),
    egressConnectors: core.getInput("egress-connectors"),
    ingressConnectors: core.getInput("ingress-connectors"),
    cloudwatchLogGroup: core.getInput("cloudwatch-log-group"),
    idempotencyKey: core.getInput("idempotency-key"),
    microvmId: core.getInput("microvm-id"),
    server: core.getInput("server"),
    serverCapacity: core.getInput("server-capacity"),
    stateTable: core.getInput("state-table"),
    leaseTimeoutSeconds: core.getInput("lease-timeout-seconds"),
    reuseSafetyMarginSeconds: core.getInput("reuse-safety-margin-seconds"),
    debug: core.getInput("debug"),
  };
}

function repositoryContextFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RepositoryContext {
  const repository = environment.GITHUB_REPOSITORY;
  if (
    repository === undefined ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new ActionEnvironmentError("GITHUB_REPOSITORY");
  }
  const [owner, name] = repository.split("/", 2);
  if (owner === undefined || name === undefined) {
    throw new ActionEnvironmentError("GITHUB_REPOSITORY");
  }
  return {
    owner,
    repository: name,
    workflow: workflowIdentityFromEnvironment(environment),
    isForkPullRequest: forkPullRequestFromEnvironment(environment),
  };
}

function forkPullRequestFromEnvironment(
  environment: NodeJS.ProcessEnv,
): boolean {
  if (
    !["pull_request", "pull_request_target"].includes(
      environment.GITHUB_EVENT_NAME ?? "",
    ) ||
    environment.GITHUB_EVENT_PATH === undefined
  ) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(
      readFileSync(environment.GITHUB_EVENT_PATH, "utf8"),
    );
    const pullRequest = objectField(payload, "pull_request");
    const head = objectField(pullRequest, "head");
    const repository = objectField(head, "repo");
    return repository?.fork === true;
  } catch {
    return true;
  }
}

function objectField(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const child: unknown = Reflect.get(value, field) as unknown;
  return typeof child === "object" && child !== null
    ? (child as Record<string, unknown>)
    : undefined;
}

function actionReporter(): ActionReporter {
  return {
    setSecret: core.setSecret,
    setOutput: core.setOutput,
    info: core.info,
    debug: core.debug,
    warning: core.warning,
  };
}
import { readFileSync } from "node:fs";
