import { PollingError } from "../polling.js";
import { getSafeErrorName, OperationRetryError } from "../retry.js";
import { ActionExecutionError, type ActionRuntime } from "./types.js";

export const STOP_TIMEOUT_MS = 60_000;
export const CLEANUP_TIMEOUT_MS = 30_000;
export const CONTROL_PORT = 8080;
export const CONTROL_TOKEN_EXPIRATION_MINUTES = 5;

export function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new ActionExecutionError(message);
  }
  return value;
}

export function retryOptions(
  operation: string,
  deadline: number,
  runtime: ActionRuntime,
  overrides: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {},
) {
  return {
    operation,
    deadline,
    maxAttempts: overrides.maxAttempts ?? 6,
    baseDelayMs: overrides.baseDelayMs ?? 1_000,
    maxDelayMs: overrides.maxDelayMs ?? 16_000,
    random: runtime.random,
    now: runtime.now,
    sleep: runtime.sleep,
  };
}

export function pollingRuntime(runtime: ActionRuntime) {
  return {
    random: runtime.random,
    now: runtime.now,
    sleep: runtime.sleep,
  };
}

export function userFacingFailure(
  stage: string,
  region: string,
  error: unknown,
): ActionExecutionError {
  if (error instanceof ActionExecutionError) {
    return error;
  }
  if (error instanceof OperationRetryError && error.reason === "capacity") {
    return new ActionExecutionError(
      `${stage} exhausted Lambda MicroVM capacity in ${region}; review AWS Service Quotas for this account and Region`,
    );
  }
  if (
    (error instanceof PollingError && error.reason === "deadline") ||
    (error instanceof OperationRetryError && error.reason === "deadline")
  ) {
    return new ActionExecutionError(`${stage} timed out in ${region}`);
  }
  return new ActionExecutionError(
    `${stage} failed (${getSafeErrorName(error)})`,
  );
}

export const systemRuntime: ActionRuntime = {
  now: Date.now,
  random: Math.random,
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};
