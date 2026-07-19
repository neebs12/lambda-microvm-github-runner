import type { WorkflowIdentity } from "../identity.js";

export type RepositoryContext = {
  owner: string;
  repository: string;
  workflow: WorkflowIdentity;
  isForkPullRequest?: boolean;
};

export type ActionReporter = {
  setSecret(secret: string): void;
  setOutput(name: string, value: string): void;
  info(message: string): void;
  debug(message: string): void;
  warning(message: string): void;
};

export type ActionRuntime = {
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export type StartResult = {
  label: string;
  runnerName: string;
  runnerId: number;
  microvmId: string;
  region: string;
  imageVersion: string;
  server?: string;
  warmHit?: boolean;
  warmExpiresAt?: number;
  reuseDeadline?: number;
};

export class ActionExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActionExecutionError";
  }
}
