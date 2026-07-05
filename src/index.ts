import * as core from "@actions/core";

import { InputValidationError } from "./config.js";
import { WorkflowIdentityError } from "./identity.js";
import { ActionEnvironmentError, run } from "./main.js";
import { ActionExecutionError } from "./orchestration.js";

void run().catch((error: unknown) => {
  core.setFailed(userFacingMessage(error));
});

function userFacingMessage(error: unknown): string {
  if (
    error instanceof InputValidationError ||
    error instanceof WorkflowIdentityError ||
    error instanceof ActionEnvironmentError ||
    error instanceof ActionExecutionError
  ) {
    return error.message;
  }
  return "Action failed unexpectedly";
}
