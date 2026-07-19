import { requireDefined } from "./runtime.js";
import type { ActionReporter, StartResult } from "./types.js";

export function setStartOutputs(
  reporter: ActionReporter,
  result: StartResult,
): void {
  reporter.setOutput("label", result.label);
  reporter.setOutput("runner-name", result.runnerName);
  reporter.setOutput("runner-id", String(result.runnerId));
  reporter.setOutput("microvm-id", result.microvmId);
  reporter.setOutput("region", result.region);
  reporter.setOutput("image-version", result.imageVersion);
  if (result.server !== undefined) {
    reporter.setOutput("server", result.server);
    reporter.setOutput("warm-hit", String(result.warmHit));
    reporter.setOutput(
      "warm-expires-at",
      new Date(
        requireDefined(result.warmExpiresAt, "Warm expiry is missing"),
      ).toISOString(),
    );
    reporter.setOutput(
      "reuse-deadline",
      new Date(
        requireDefined(result.reuseDeadline, "Reuse deadline is missing"),
      ).toISOString(),
    );
  }
}
