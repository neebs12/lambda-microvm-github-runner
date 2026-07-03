export type RetryClassification = "retryable" | "capacity" | "fatal";

export type RetryOptions = {
  operation: string;
  deadline: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  classify?: (error: unknown) => RetryClassification;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class OperationRetryError extends Error {
  public constructor(
    operation: string,
    reason: "capacity" | "deadline" | "exhausted" | "fatal",
    errorName?: string,
  ) {
    const suffix = errorName === undefined ? "" : ` (${errorName})`;
    super(`${operation} failed: ${reason}${suffix}`);
    this.name = "OperationRetryError";
  }
}

export async function retryWithFullJitter<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 16_000;
  const classify = options.classify ?? classifyAwsError;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  validateOptions(
    options.operation,
    options.deadline,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    now,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (now() >= options.deadline) {
      throw new OperationRetryError(options.operation, "deadline");
    }

    try {
      return await task(attempt);
    } catch (error: unknown) {
      const classification = classify(error);
      const name = safeErrorName(error);

      if (classification === "capacity") {
        throw new OperationRetryError(options.operation, "capacity", name);
      }
      if (classification === "fatal") {
        throw new OperationRetryError(options.operation, "fatal", name);
      }
      if (attempt === maxAttempts) {
        throw new OperationRetryError(options.operation, "exhausted", name);
      }

      const delay = fullJitterDelay(
        attempt - 1,
        baseDelayMs,
        maxDelayMs,
        random,
      );
      if (now() + delay >= options.deadline) {
        throw new OperationRetryError(options.operation, "deadline", name);
      }
      await sleep(delay);
    }
  }

  throw new OperationRetryError(options.operation, "exhausted");
}

export function classifyAwsError(error: unknown): RetryClassification {
  const name = safeErrorName(error);
  if (name === "ServiceQuotaExceededException") {
    return "capacity";
  }

  if (
    new Set([
      "Throttling",
      "ThrottlingException",
      "TooManyRequestsException",
      "RequestTimeout",
      "RequestTimeoutException",
      "TimeoutError",
      "ServiceUnavailable",
      "ServiceUnavailableException",
      "InternalFailure",
      "InternalServerError",
      "InternalServerException",
    ]).has(name)
  ) {
    return "retryable";
  }

  const statusCode = safeStatusCode(error);
  return statusCode !== undefined && statusCode >= 500 ? "retryable" : "fatal";
}

export function fullJitterDelay(
  retryIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  if (
    !Number.isSafeInteger(retryIndex) ||
    retryIndex < 0 ||
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs < 0 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < baseDelayMs
  ) {
    throw new RangeError("Invalid full-jitter delay options");
  }
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** retryIndex);
  return Math.floor(assertRandom(random()) * (cap + 1));
}

function validateOptions(
  operation: string,
  deadline: number,
  maxAttempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
  now: () => number,
): void {
  if (operation.trim().length === 0) {
    throw new RangeError("Retry operation must not be empty");
  }
  if (
    !Number.isSafeInteger(deadline) ||
    deadline <= now() ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs < 0 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < baseDelayMs
  ) {
    throw new RangeError("Invalid retry options");
  }
}

function safeErrorName(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "UnknownError";
  }

  for (const field of ["name", "code"] as const) {
    const value: unknown = Reflect.get(error, field) as unknown;
    if (
      typeof value === "string" &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)
    ) {
      return value;
    }
  }
  return "UnknownError";
}

function safeStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const metadata: unknown = Reflect.get(error, "$metadata") as unknown;
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const statusCode: unknown = Reflect.get(
    metadata,
    "httpStatusCode",
  ) as unknown;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function assertRandom(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Random source must return a value in [0, 1)");
  }
  return value;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
