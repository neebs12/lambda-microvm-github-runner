import { createHash } from "node:crypto";

const MAX_HANDLE_BYTES = 4_096;
export const SERVER_HANDLE_PREFIX = "lmvm1_";

export type ExplicitWarmHandle = {
  version: 1;
  kind: "explicit";
  region: string;
  microvmId: string;
  serverKeyHash: string;
  startedAt: number;
  expiresAt: number;
  reuseDeadline: number;
};

export type PoolWarmHandle = {
  version: 1;
  kind: "pool";
  region: string;
  tableName: string;
  poolKey: string;
  memberId: string;
  microvmId: string;
  leaseId: string;
  leaseGeneration: number;
  expiresAt: number;
  reuseDeadline: number;
};

export type ServerHandle = ExplicitWarmHandle | PoolWarmHandle;

export class ServerHandleError extends Error {
  public constructor() {
    super("Invalid server handle");
    this.name = "ServerHandleError";
  }
}

export function hashServerKey(serverKey: string): string {
  return createHash("sha256").update(serverKey, "utf8").digest("hex");
}

export function encodeExplicitWarmHandle(value: ExplicitWarmHandle): string {
  return `${SERVER_HANDLE_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function encodePoolWarmHandle(value: PoolWarmHandle): string {
  return `${SERVER_HANDLE_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function decodeExplicitWarmHandle(value: string): ExplicitWarmHandle {
  const handle = decodeServerHandle(value);
  if (handle.kind !== "explicit") {
    throw new ServerHandleError();
  }
  return handle;
}

export function decodeServerHandle(value: string): ServerHandle {
  if (
    !value.startsWith(SERVER_HANDLE_PREFIX) ||
    Buffer.byteLength(value, "utf8") > MAX_HANDLE_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new ServerHandleError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(
        value.slice(SERVER_HANDLE_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
  } catch {
    throw new ServerHandleError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "version") !== 1 ||
    !validRegion(Reflect.get(parsed, "region")) ||
    !validIdentifier(Reflect.get(parsed, "microvmId")) ||
    !validTimestamp(Reflect.get(parsed, "expiresAt")) ||
    !validTimestamp(Reflect.get(parsed, "reuseDeadline"))
  ) {
    throw new ServerHandleError();
  }
  const kind: unknown = Reflect.get(parsed, "kind") as unknown;
  if (kind === "explicit") {
    if (
      !validHash(Reflect.get(parsed, "serverKeyHash")) ||
      !validTimestamp(Reflect.get(parsed, "startedAt"))
    ) {
      throw new ServerHandleError();
    }
    const handle = parsed as ExplicitWarmHandle;
    if (
      handle.startedAt >= handle.reuseDeadline ||
      handle.reuseDeadline >= handle.expiresAt
    ) {
      throw new ServerHandleError();
    }
    return handle;
  }
  if (
    kind !== "pool" ||
    !validTableName(Reflect.get(parsed, "tableName")) ||
    !validIdentifier(Reflect.get(parsed, "poolKey")) ||
    !validHash(Reflect.get(parsed, "memberId")) ||
    !validHash(Reflect.get(parsed, "leaseId")) ||
    !validPositiveInteger(Reflect.get(parsed, "leaseGeneration"))
  ) {
    throw new ServerHandleError();
  }
  const handle = parsed as PoolWarmHandle;
  if (handle.reuseDeadline >= handle.expiresAt) {
    throw new ServerHandleError();
  }
  return handle;
}

function validRegion(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(value)
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2_048 &&
    !/\s/.test(value)
  );
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validTableName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{3,255}$/.test(value);
}
