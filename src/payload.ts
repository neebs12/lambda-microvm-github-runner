import { gunzipSync, gzipSync } from "node:zlib";

export const MAX_RUN_HOOK_PAYLOAD_BYTES = 4_096;
const MAX_JIT_CONFIG_BYTES = 1024 * 1024;

export type SecretMasker = (secret: string) => void;

export class PayloadEncodingError extends Error {
  public constructor(reason: string) {
    super(`Unable to encode JIT configuration: ${reason}`);
    this.name = "PayloadEncodingError";
  }
}

export function encodeJitPayload(
  encodedJitConfig: string,
  maskSecret: SecretMasker,
  maximumBytes = MAX_RUN_HOOK_PAYLOAD_BYTES,
): string {
  maskSecret(encodedJitConfig);

  if (encodedJitConfig.length === 0) {
    throw new PayloadEncodingError("value is empty");
  }
  if (
    Buffer.byteLength(encodedJitConfig, "utf8") > MAX_JIT_CONFIG_BYTES ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) {
    throw new PayloadEncodingError("value is outside accepted bounds");
  }

  let payload: string;
  try {
    payload = gzipSync(Buffer.from(encodedJitConfig, "utf8"), {
      level: 9,
    }).toString("base64");
  } catch {
    throw new PayloadEncodingError("compression failed");
  }

  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > maximumBytes) {
    throw new PayloadEncodingError(
      `compressed payload exceeds the ${String(maximumBytes)}-byte limit`,
    );
  }

  maskSecret(payload);
  return payload;
}

export function encodeRunHookPayload(
  encodedJitConfig: string,
  region: string,
  maskSecret: SecretMasker,
  maximumBytes = MAX_RUN_HOOK_PAYLOAD_BYTES,
): string {
  maskSecret(encodedJitConfig);
  return encodeJitPayload(
    JSON.stringify({
      version: 1,
      jit: encodedJitConfig,
      region,
    }),
    (value) => {
      if (value !== encodedJitConfig) {
        maskSecret(value);
      }
    },
    maximumBytes,
  );
}

export function decodeJitPayload(payload: string): string {
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    throw new PayloadEncodingError("payload is not valid base64");
  }

  try {
    const decoded = gunzipSync(Buffer.from(payload, "base64"), {
      maxOutputLength: MAX_JIT_CONFIG_BYTES,
    }).toString("utf8");
    const envelope = parseRunHookEnvelope(decoded);
    return envelope ?? decoded;
  } catch {
    throw new PayloadEncodingError("payload decompression failed");
  }
}

function parseRunHookEnvelope(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Reflect.get(parsed, "version") === 1 &&
      typeof Reflect.get(parsed, "jit") === "string" &&
      typeof Reflect.get(parsed, "region") === "string"
    ) {
      return Reflect.get(parsed, "jit") as string;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
