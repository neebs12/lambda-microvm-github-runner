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
    maximumDurationSeconds: core.getInput("maximum-duration-seconds"),
    startupTimeoutSeconds: core.getInput("startup-timeout-seconds"),
    egressConnectors: core.getInput("egress-connectors"),
    ingressConnectors: core.getInput("ingress-connectors"),
    cloudwatchLogGroup: core.getInput("cloudwatch-log-group"),
    idempotencyKey: core.getInput("idempotency-key"),
    microvmId: core.getInput("microvm-id"),
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
  };
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
