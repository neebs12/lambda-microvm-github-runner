export type PollDecision<T> =
  | { status: "pending" }
  | { status: "success"; value: T }
  | { status: "failure"; reason: string };

export type PollingOptions<TObserved, TResult> = {
  operation: string;
  deadline: number;
  observe: () => Promise<TObserved>;
  decide: (observed: TObserved) => PollDecision<TResult>;
  initialDelayMaxMs?: number;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class PollingError extends Error {
  public constructor(
    operation: string,
    reason: "deadline" | "terminal",
    detail?: string,
  ) {
    const suffix = detail === undefined ? "" : ` (${detail})`;
    super(`${operation} polling failed: ${reason}${suffix}`);
    this.name = "PollingError";
  }
}

export async function pollSequentially<TObserved, TResult>(
  options: PollingOptions<TObserved, TResult>,
): Promise<TResult> {
  const initialDelayMaxMs = options.initialDelayMaxMs ?? 2_000;
  const baseIntervalMs = options.baseIntervalMs ?? 2_000;
  const maxIntervalMs = options.maxIntervalMs ?? 5_000;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  validateOptions(
    options.operation,
    options.deadline,
    initialDelayMaxMs,
    baseIntervalMs,
    maxIntervalMs,
    now,
  );

  const initialDelay = Math.floor(
    assertRandom(random()) * (initialDelayMaxMs + 1),
  );
  await sleepWithinDeadline(
    initialDelay,
    options.operation,
    options.deadline,
    now,
    sleep,
  );

  let pendingCount = 0;
  while (now() < options.deadline) {
    const observed = await options.observe();
    const decision = options.decide(observed);

    if (decision.status === "success") {
      return decision.value;
    }
    if (decision.status === "failure") {
      throw new PollingError(
        options.operation,
        "terminal",
        sanitizeReason(decision.reason),
      );
    }

    const cap = Math.min(
      maxIntervalMs,
      Math.round(baseIntervalMs * 1.5 ** pendingCount),
    );
    const floor = Math.floor(cap / 2);
    const interval =
      floor + Math.floor(assertRandom(random()) * (cap - floor + 1));
    pendingCount += 1;

    await sleepWithinDeadline(
      interval,
      options.operation,
      options.deadline,
      now,
      sleep,
    );
  }

  throw new PollingError(options.operation, "deadline");
}

function validateOptions(
  operation: string,
  deadline: number,
  initialDelayMaxMs: number,
  baseIntervalMs: number,
  maxIntervalMs: number,
  now: () => number,
): void {
  if (
    operation.trim().length === 0 ||
    !Number.isSafeInteger(deadline) ||
    deadline <= now() ||
    !Number.isSafeInteger(initialDelayMaxMs) ||
    initialDelayMaxMs < 0 ||
    !Number.isSafeInteger(baseIntervalMs) ||
    baseIntervalMs < 1 ||
    !Number.isSafeInteger(maxIntervalMs) ||
    maxIntervalMs < baseIntervalMs
  ) {
    throw new RangeError("Invalid polling options");
  }
}

async function sleepWithinDeadline(
  milliseconds: number,
  operation: string,
  deadline: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (now() + milliseconds >= deadline) {
    throw new PollingError(operation, "deadline");
  }
  await sleep(milliseconds);
}

function sanitizeReason(reason: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(reason)
    ? reason
    : "terminal-state";
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
