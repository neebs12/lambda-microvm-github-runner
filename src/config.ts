export const MAXIMUM_DURATION_SECONDS = 28_800;
export const MAX_STARTUP_TIMEOUT_SECONDS = 3_600;

export type RawActionInputs = {
  mode?: string;
  githubToken?: string;
  imageId?: string;
  imageVersion?: string;
  executionRoleArn?: string;
  region?: string;
  runnerGroupId?: string;
  runnerLabels?: string;
  maximumDurationSeconds?: string;
  startupTimeoutSeconds?: string;
  egressConnectors?: string;
  ingressConnectors?: string;
  cloudwatchLogGroup?: string;
  idempotencyKey?: string;
  microvmId?: string;
  debug?: string;
};

type CommonConfig = {
  region: string;
  debug: boolean;
};

export type StartConfig = CommonConfig & {
  mode: "start";
  githubToken: string;
  imageId: string;
  imageVersion?: string;
  executionRoleArn: string;
  runnerGroupId: number;
  runnerLabels: string[];
  maximumDurationSeconds: number;
  startupTimeoutSeconds: number;
  egressConnectors: string[];
  ingressConnectors: string[];
  cloudwatchLogGroup?: string;
  idempotencyKey?: string;
};

export type StopConfig = CommonConfig & {
  mode: "stop";
  microvmId: string;
};

export type ActionConfig = StartConfig | StopConfig;

export class InputValidationError extends Error {
  public constructor(field: string, reason: string) {
    super(`Invalid input '${field}': ${reason}`);
    this.name = "InputValidationError";
  }
}

export function parseActionConfig(
  raw: RawActionInputs,
  environment: NodeJS.ProcessEnv = process.env,
): ActionConfig {
  const mode = required(raw.mode, "mode");
  const region = optional(raw.region) ?? optional(environment.AWS_REGION);

  if (region === undefined) {
    throw new InputValidationError(
      "region",
      "provide it explicitly or set AWS_REGION",
    );
  }
  validateRegion(region);

  const debug = parseBoolean(optional(raw.debug) ?? "false", "debug");

  if (mode === "stop") {
    return {
      mode,
      region,
      debug,
      microvmId: validateOpaqueIdentifier(
        required(raw.microvmId, "microvm-id"),
        "microvm-id",
      ),
    };
  }

  if (mode !== "start") {
    throw new InputValidationError("mode", "must be 'start' or 'stop'");
  }

  const imageVersion = optional(raw.imageVersion);
  const cloudwatchLogGroup = optional(raw.cloudwatchLogGroup);
  const idempotencyKey = optional(raw.idempotencyKey);

  if (imageVersion !== undefined) {
    validateOpaqueIdentifier(imageVersion, "image-version");
  }
  if (cloudwatchLogGroup !== undefined) {
    validateLogGroup(cloudwatchLogGroup);
  }
  if (idempotencyKey !== undefined) {
    validateIdempotencyKey(idempotencyKey);
  }

  const imageId = validateOpaqueIdentifier(
    required(raw.imageId, "image-id"),
    "image-id",
  );
  const config: StartConfig = {
    mode,
    region,
    debug,
    githubToken: required(raw.githubToken, "github-token"),
    imageId,
    executionRoleArn: validateRoleArn(
      required(raw.executionRoleArn, "execution-role-arn"),
    ),
    runnerGroupId: parseIntegerInRange(
      optional(raw.runnerGroupId) ?? "1",
      "runner-group-id",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    runnerLabels: parseRunnerLabels(
      optional(raw.runnerLabels) ?? "lambda-microvm,docker",
    ),
    maximumDurationSeconds: parseIntegerInRange(
      optional(raw.maximumDurationSeconds) ?? "3600",
      "maximum-duration-seconds",
      1,
      MAXIMUM_DURATION_SECONDS,
    ),
    startupTimeoutSeconds: parseIntegerInRange(
      optional(raw.startupTimeoutSeconds) ?? "180",
      "startup-timeout-seconds",
      1,
      MAX_STARTUP_TIMEOUT_SECONDS,
    ),
    egressConnectors: expandManagedConnectors(
      parseConnectorList(
        optional(raw.egressConnectors) ?? "INTERNET_EGRESS",
        "egress-connectors",
      ),
      region,
      imageId,
    ),
    ingressConnectors: expandManagedConnectors(
      parseConnectorList(
        optional(raw.ingressConnectors) ?? "NO_INGRESS",
        "ingress-connectors",
      ),
      region,
      imageId,
    ),
    ...(imageVersion === undefined ? {} : { imageVersion }),
    ...(cloudwatchLogGroup === undefined ? {} : { cloudwatchLogGroup }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };

  return config;
}

function required(value: string | undefined, field: string): string {
  const parsed = optional(value);
  if (parsed === undefined) {
    throw new InputValidationError(field, "is required");
  }
  return parsed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseBoolean(value: string, field: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new InputValidationError(field, "must be 'true' or 'false'");
}

function parseIntegerInRange(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new InputValidationError(field, "must be an integer");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InputValidationError(
      field,
      `must be between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return parsed;
}

function parseRunnerLabels(value: string): string[] {
  const labels = parseCommaSeparated(value, "runner-labels");
  if (labels.length > 20) {
    throw new InputValidationError(
      "runner-labels",
      "must contain no more than 20 labels",
    );
  }

  const deduplicated = new Map<string, string>();
  for (const label of labels) {
    if (label.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
      throw new InputValidationError(
        "runner-labels",
        "labels must be 1-100 characters using letters, digits, '.', '_' or '-'",
      );
    }
    deduplicated.set(label.toLowerCase(), label);
  }
  return [...deduplicated.values()];
}

function parseConnectorList(value: string, field: string): string[] {
  let connectors: string[];
  if (value.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new InputValidationError(field, "must contain valid JSON");
    }
    if (!isStringArray(parsed)) {
      throw new InputValidationError(
        field,
        "JSON value must be a string array",
      );
    }
    connectors = parsed;
  } else {
    connectors = parseCommaSeparated(value, field);
  }

  if (connectors.length > 10) {
    throw new InputValidationError(
      field,
      "must contain no more than 10 connectors",
    );
  }

  return connectors.map((connector) => {
    const trimmed = connector.trim();
    if (trimmed.length === 0 || trimmed.length > 2_048 || /\s/.test(trimmed)) {
      throw new InputValidationError(
        field,
        "connector identifiers must be 1-2048 characters without whitespace",
      );
    }
    return trimmed;
  });
}

function expandManagedConnectors(
  connectors: string[],
  region: string,
  imageId: string,
): string[] {
  const imagePartition = /^arn:([^:]+):/.exec(imageId)?.[1];
  const partition =
    imagePartition ??
    (region.startsWith("cn-")
      ? "aws-cn"
      : region.startsWith("us-gov-")
        ? "aws-us-gov"
        : "aws");

  return connectors.map((connector) =>
    connector === "INTERNET_EGRESS" || connector === "NO_INGRESS"
      ? `arn:${partition}:lambda:${region}:aws:network-connector:aws-network-connector:${connector}`
      : connector,
  );
}

function parseCommaSeparated(value: string, field: string): string[] {
  const values = value.split(",").map((item) => item.trim());
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    throw new InputValidationError(
      field,
      "must be a comma-separated list without empty values",
    );
  }
  return values;
}

function validateRegion(value: string): void {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(value)) {
    throw new InputValidationError(
      "region",
      "must be a valid AWS Region identifier",
    );
  }
}

function validateRoleArn(value: string): string {
  if (
    !/^arn:(?:aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[\w+=,.@/-]+$/.test(
      value,
    )
  ) {
    throw new InputValidationError(
      "execution-role-arn",
      "must be an IAM role ARN",
    );
  }
  return value;
}

function validateOpaqueIdentifier(value: string, field: string): string {
  if (value.length > 2_048 || /\s/.test(value)) {
    throw new InputValidationError(
      field,
      "must be at most 2048 characters without whitespace",
    );
  }
  return value;
}

function validateLogGroup(value: string): void {
  if (
    value.length > 512 ||
    !/^[.\-_/#A-Za-z0-9]+$/.test(value) ||
    value.includes("..")
  ) {
    throw new InputValidationError(
      "cloudwatch-log-group",
      "must be a valid CloudWatch Logs group name",
    );
  }
}

function validateIdempotencyKey(value: string): void {
  if (value.length > 256 || containsControlCharacter(value)) {
    throw new InputValidationError(
      "idempotency-key",
      "must be at most 256 characters without control characters",
    );
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
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
