import * as core from "@actions/core";

import { parseActionConfig, type RawActionInputs } from "./config.js";
import {
  createRunnerIdentity,
  workflowIdentityFromEnvironment,
} from "./identity.js";

export function run(): void {
  const raw = readActionInputs();
  if (raw.githubToken !== undefined && raw.githubToken.length > 0) {
    core.setSecret(raw.githubToken);
  }

  const config = parseActionConfig(raw);
  if (config.mode === "start") {
    const identity = createRunnerIdentity(
      workflowIdentityFromEnvironment(),
      config.idempotencyKey,
    );
    core.debug(
      `Validated start request for runner '${identity.runnerName}' in ${config.region}`,
    );
  } else {
    core.debug(`Validated stop request in ${config.region}`);
  }

  throw new Error(
    "External GitHub and AWS orchestration is not implemented in this scaffold",
  );
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
