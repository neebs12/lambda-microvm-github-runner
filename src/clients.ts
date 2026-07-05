export type CreateJitRunnerRequest = {
  owner: string;
  repository: string;
  runnerName: string;
  runnerGroupId: number;
  labels: string[];
};

export type JitRunner = {
  runnerId: number;
  runnerName: string;
  encodedJitConfig: string;
};

export type GitHubRunner = {
  runnerId: number;
  runnerName: string;
  status: string;
  busy: boolean;
};

export type GitHubJitClient = {
  createJitRunner(request: CreateJitRunnerRequest): Promise<JitRunner>;
  getRunner(runnerId: number): Promise<GitHubRunner | undefined>;
  deleteRunner(runnerId: number): Promise<void>;
};

export type RunMicrovmRequest = {
  clientToken: string;
  region: string;
  imageId: string;
  imageVersion?: string;
  executionRoleArn: string;
  maximumDurationSeconds: number;
  ingressConnectors: string[];
  egressConnectors: string[];
  runHookPayload: string;
  cloudwatchLogGroup?: string;
};

export type RunMicrovmResult = {
  microvmId: string;
  imageVersion: string;
};

export type Microvm = {
  microvmId: string;
  state: string;
  stateReason?: string;
  imageVersion?: string;
};

export type MicrovmClient = {
  run(request: RunMicrovmRequest): Promise<RunMicrovmResult>;
  get(microvmId: string): Promise<Microvm | undefined>;
  terminate(microvmId: string): Promise<void>;
};
