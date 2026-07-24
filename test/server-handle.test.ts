import { describe, expect, it } from "vitest";

import {
  decodeExplicitWarmHandle,
  encodeExplicitWarmHandle,
  hashServerKey,
  ServerHandleError,
} from "../src/server-handle.js";

describe("explicit warm server handles", () => {
  const handle = {
    version: 1 as const,
    kind: "explicit" as const,
    region: "us-east-1",
    microvmId: "mvm-1",
    serverKeyHash: hashServerKey("build-cache"),
    startedAt: 1_000,
    reuseDeadline: 6_000,
    expiresAt: 7_000,
  };

  it("round trips without embedding the server key", () => {
    const encoded = encodeExplicitWarmHandle(handle);
    expect(encoded).not.toContain("build-cache");
    expect(decodeExplicitWarmHandle(encoded)).toEqual(handle);
  });

  it.each(["", "not base64!", Buffer.from("{}").toString("base64url")])(
    "rejects malformed handle %#",
    (value) => {
      expect(() => decodeExplicitWarmHandle(value)).toThrow(ServerHandleError);
    },
  );
});
