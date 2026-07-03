import type {
  CreateJitRunnerRequest,
  GitHubJitClient,
  GitHubRunner,
  JitRunner,
  Microvm,
  MicrovmClient,
  RunMicrovmRequest,
  RunMicrovmResult,
} from "../../src/clients.js";

export class MockGitHubJitClient implements GitHubJitClient {
  public readonly createRequests: CreateJitRunnerRequest[] = [];
  public readonly getRequests: number[] = [];
  public readonly deleteRequests: number[] = [];

  public constructor(
    private readonly handlers: {
      create?: (request: CreateJitRunnerRequest) => Promise<JitRunner>;
      get?: (runnerId: number) => Promise<GitHubRunner | undefined>;
      delete?: (runnerId: number) => Promise<void>;
    } = {},
  ) {}

  public async createJitRunner(
    request: CreateJitRunnerRequest,
  ): Promise<JitRunner> {
    this.createRequests.push(structuredClone(request));
    if (this.handlers.create === undefined) {
      throw new Error("Unexpected createJitRunner call");
    }
    return this.handlers.create(request);
  }

  public async getRunner(runnerId: number): Promise<GitHubRunner | undefined> {
    this.getRequests.push(runnerId);
    if (this.handlers.get === undefined) {
      throw new Error("Unexpected getRunner call");
    }
    return this.handlers.get(runnerId);
  }

  public async deleteRunner(runnerId: number): Promise<void> {
    this.deleteRequests.push(runnerId);
    if (this.handlers.delete === undefined) {
      throw new Error("Unexpected deleteRunner call");
    }
    await this.handlers.delete(runnerId);
  }
}

export class MockMicrovmClient implements MicrovmClient {
  public readonly runRequests: RunMicrovmRequest[] = [];
  public readonly getRequests: string[] = [];
  public readonly terminateRequests: string[] = [];

  public constructor(
    private readonly handlers: {
      run?: (request: RunMicrovmRequest) => Promise<RunMicrovmResult>;
      get?: (microvmId: string) => Promise<Microvm | undefined>;
      terminate?: (microvmId: string) => Promise<void>;
    } = {},
  ) {}

  public async run(request: RunMicrovmRequest): Promise<RunMicrovmResult> {
    this.runRequests.push(structuredClone(request));
    if (this.handlers.run === undefined) {
      throw new Error("Unexpected run call");
    }
    return this.handlers.run(request);
  }

  public async get(microvmId: string): Promise<Microvm | undefined> {
    this.getRequests.push(microvmId);
    if (this.handlers.get === undefined) {
      throw new Error("Unexpected get call");
    }
    return this.handlers.get(microvmId);
  }

  public async terminate(microvmId: string): Promise<void> {
    this.terminateRequests.push(microvmId);
    if (this.handlers.terminate === undefined) {
      throw new Error("Unexpected terminate call");
    }
    await this.handlers.terminate(microvmId);
  }
}
