import { describe, expect, it } from "vitest";

import {
  InputValidationError,
  parseActionConfig,
  type RawActionInputs,
} from "../src/config.js";

const validStartInputs: RawActionInputs = {
  mode: "start",
  githubToken: "github-secret",
  imageId: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
  executionRoleArn: "arn:aws:iam::123456789012:role/microvm-runner",
};

describe("parseActionConfig", () => {
  it("parses start defaults and AWS_REGION", () => {
    const config = parseActionConfig(validStartInputs, {
      AWS_REGION: "us-east-1",
    });

    expect(config).toEqual({
      mode: "start",
      region: "us-east-1",
      debug: false,
      githubToken: "github-secret",
      imageId: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
      executionRoleArn: "arn:aws:iam::123456789012:role/microvm-runner",
      runnerGroupId: 1,
      runnerLabels: ["lambda-microvm", "docker"],
      maximumDurationSeconds: 7_200,
      leaseTimeoutSeconds: 7_200,
      reuseSafetyMarginSeconds: 1_800,
      startupTimeoutSeconds: 180,
      egressConnectors: [
        "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
      ],
      ingressConnectors: [
        "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS",
      ],
    });
  });

  it("treats blank optional inputs as omitted", () => {
    const config = parseActionConfig(
      {
        ...validStartInputs,
        debug: "",
        runnerGroupId: "",
        runnerLabels: "",
        maximumDurationSeconds: "",
        startupTimeoutSeconds: "",
        egressConnectors: "",
        ingressConnectors: "",
      },
      { AWS_REGION: "us-east-1" },
    );

    expect(config).toMatchObject({
      debug: false,
      runnerGroupId: 1,
      maximumDurationSeconds: 7_200,
      startupTimeoutSeconds: 180,
    });
  });

  it("parses stop inputs independently from start inputs", () => {
    const config = parseActionConfig(
      {
        mode: "stop",
        region: "ap-southeast-2",
        microvmId: "mvm-123",
        runnerGroupId: "not-used",
      },
      {},
    );

    expect(config).toEqual({
      mode: "stop",
      region: "ap-southeast-2",
      debug: false,
      microvmId: "mvm-123",
    });
  });

  it("uses the same server input for warm start and stop", () => {
    const start = parseActionConfig(
      { ...validStartInputs, server: "docker-builds" },
      { AWS_REGION: "us-east-1" },
    );
    expect(start).toMatchObject({
      mode: "start",
      server: "docker-builds",
      leaseTimeoutSeconds: 7_200,
      ingressConnectors: [
        "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
      ],
    });

    expect(
      parseActionConfig(
        { mode: "stop", region: "us-east-1", server: "lmvm1_handle" },
        {},
      ),
    ).toEqual({
      mode: "stop",
      region: "us-east-1",
      debug: false,
      server: "lmvm1_handle",
    });
  });

  it("keeps legacy microvm-id only for direct termination", () => {
    expect(() =>
      parseActionConfig(
        { ...validStartInputs, microvmId: "mvm-1" },
        { AWS_REGION: "us-east-1" },
      ),
    ).toThrow("supported only by stop mode");
    expect(() =>
      parseActionConfig(
        {
          mode: "stop",
          region: "us-east-1",
          microvmId: "mvm-1",
          server: "lmvm1_handle",
        },
        {},
      ),
    ).toThrow("exactly one");
  });

  it.each(["githubToken", "imageId", "executionRoleArn"] as const)(
    "requires start input %s",
    (field) => {
      const raw: RawActionInputs = { ...validStartInputs, [field]: "" };

      expect(() => parseActionConfig(raw, { AWS_REGION: "us-east-1" })).toThrow(
        InputValidationError,
      );
    },
  );

  it("requires a MicroVM ID in stop mode", () => {
    expect(() =>
      parseActionConfig({ mode: "stop", region: "us-east-1" }, {}),
    ).toThrow("microvm-id");
  });

  it.each([
    [{ ...validStartInputs, mode: "START" }, "mode"],
    [{ ...validStartInputs, maximumDurationSeconds: "0" }, "maximum-duration"],
    [
      { ...validStartInputs, maximumDurationSeconds: "28801" },
      "maximum-duration",
    ],
    [{ ...validStartInputs, startupTimeoutSeconds: "1.5" }, "startup-timeout"],
    [{ ...validStartInputs, runnerGroupId: "-1" }, "runner-group-id"],
    [{ ...validStartInputs, debug: "yes" }, "debug"],
    [{ ...validStartInputs, runnerLabels: "docker,,linux" }, "runner-labels"],
    [
      { ...validStartInputs, runnerLabels: "spaces are invalid" },
      "runner-labels",
    ],
    [{ ...validStartInputs, egressConnectors: "[1]" }, "egress-connectors"],
    [
      { ...validStartInputs, ingressConnectors: "[broken" },
      "ingress-connectors",
    ],
  ] satisfies [RawActionInputs, string][])(
    "rejects invalid input %#",
    (raw, expectedField) => {
      expect(() => parseActionConfig(raw, { AWS_REGION: "us-east-1" })).toThrow(
        expectedField,
      );
    },
  );

  it("accepts max-lifetime-seconds through eight hours", () => {
    expect(
      parseActionConfig(
        { ...validStartInputs, maxLifetimeSeconds: "28800" },
        { AWS_REGION: "us-east-1" },
      ),
    ).toMatchObject({ maximumDurationSeconds: 28_800 });
  });

  it("rejects excessive or conflicting lifetime inputs", () => {
    expect(() =>
      parseActionConfig(
        { ...validStartInputs, maxLifetimeSeconds: "28801" },
        { AWS_REGION: "us-east-1" },
      ),
    ).toThrow("max-lifetime-seconds");
    expect(() =>
      parseActionConfig(
        {
          ...validStartInputs,
          maxLifetimeSeconds: "7200",
          maximumDurationSeconds: "3600",
        },
        { AWS_REGION: "us-east-1" },
      ),
    ).toThrow("cannot be combined");
  });

  it("accepts JSON and comma-separated connector lists", () => {
    const config = parseActionConfig(
      {
        ...validStartInputs,
        region: "eu-west-1",
        egressConnectors: '["connector-a", "connector-b"]',
        ingressConnectors: "connector-c,connector-d",
      },
      {},
    );

    expect(config.mode).toBe("start");
    if (config.mode === "start") {
      expect(config.egressConnectors).toEqual(["connector-a", "connector-b"]);
      expect(config.ingressConnectors).toEqual(["connector-c", "connector-d"]);
    }
  });

  it("expands managed connector names using the image partition", () => {
    const config = parseActionConfig(
      {
        ...validStartInputs,
        region: "us-gov-west-1",
        imageId:
          "arn:aws-us-gov:lambda:us-gov-west-1:123456789012:microvm-image:runner",
        egressConnectors: "INTERNET_EGRESS,connector-a",
        ingressConnectors: '["NO_INGRESS"]',
      },
      {},
    );

    expect(config).toMatchObject({
      egressConnectors: [
        "arn:aws-us-gov:lambda:us-gov-west-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
        "connector-a",
      ],
      ingressConnectors: [
        "arn:aws-us-gov:lambda:us-gov-west-1:aws:network-connector:aws-network-connector:NO_INGRESS",
      ],
    });
  });

  it("does not include secret input values in validation errors", () => {
    const secret = "do-not-print-this-token";
    let message = "";
    try {
      parseActionConfig(
        {
          ...validStartInputs,
          githubToken: secret,
          executionRoleArn: secret,
        },
        { AWS_REGION: "us-east-1" },
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(secret);
  });
});
