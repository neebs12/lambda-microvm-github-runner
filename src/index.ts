import * as core from "@actions/core";

import { run } from "./main.js";

try {
  run();
} catch (error: unknown) {
  core.setFailed(error instanceof Error ? error.message : "Action failed");
}
