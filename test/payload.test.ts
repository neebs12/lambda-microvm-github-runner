import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  decodeJitPayload,
  encodeJitPayload,
  encodeRunHookPayload,
  MAX_RUN_HOOK_PAYLOAD_BYTES,
} from "../src/payload.js";

describe("JIT payload codec", () => {
  it("masks, compresses and round-trips a JIT configuration", () => {
    const secret = JSON.stringify({
      encoded_jit_config: "A".repeat(2_000),
    });
    const mask = vi.fn();

    const payload = encodeJitPayload(secret, mask);

    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(
      MAX_RUN_HOOK_PAYLOAD_BYTES,
    );
    expect(decodeJitPayload(payload)).toBe(secret);
    expect(mask).toHaveBeenNthCalledWith(1, secret);
    expect(mask).toHaveBeenNthCalledWith(2, payload);
  });

  it("enforces the encoded byte limit exactly", () => {
    const secret = randomBytes(512).toString("base64");
    const payload = encodeJitPayload(secret, () => undefined);
    const byteLength = Buffer.byteLength(payload, "utf8");

    expect(encodeJitPayload(secret, () => undefined, byteLength)).toBe(payload);
    expect(() =>
      encodeJitPayload(secret, () => undefined, byteLength - 1),
    ).toThrow(`${String(byteLength - 1)}-byte limit`);
  });

  it("round-trips the versioned run hook envelope without exposing it", () => {
    const jit = "encoded-jit-secret";
    const mask = vi.fn();

    const payload = encodeRunHookPayload(jit, "us-east-1", mask);

    expect(decodeJitPayload(payload)).toBe(jit);
    expect(mask).toHaveBeenCalledWith(payload);
  });

  it("never includes the JIT value in errors", () => {
    const secret = randomBytes(4_096).toString("hex");
    let message = "";

    try {
      encodeJitPayload(secret, () => undefined, 8);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(secret);
  });

  it("rejects malformed payloads without reflecting them", () => {
    const invalid = "not a secret payload!";
    let message = "";

    try {
      decodeJitPayload(invalid);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(invalid);
  });

  it("bounds decompressed payload size", () => {
    const compressedBomb = gzipSync("A".repeat(1024 * 1024 + 1)).toString(
      "base64",
    );

    expect(() => decodeJitPayload(compressedBomb)).toThrow(
      "payload decompression failed",
    );
  });
});
