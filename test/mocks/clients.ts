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
  public readonly resolveImageVersionRequests: string[] = [];
  public readonly runRequests: RunMicrovmRequest[] = [];
  public readonly getRequests: string[] = [];
  public readonly suspendRequests: string[] = [];
  public readonly resumeRequests: string[] = [];
  public readonly authTokenRequests: {
    microvmId: string;
    port: number;
    expirationMinutes: number;
  }[] = [];
  public readonly terminateRequests: string[] = [];

  public constructor(
    private readonly handlers: {
      run?: (request: RunMicrovmRequest) => Promise<RunMicrovmResult>;
      resolveImageVersion?: (imageId: string) => Promise<string>;
      get?: (microvmId: string) => Promise<Microvm | undefined>;
      suspend?: (microvmId: string) => Promise<void>;
      resume?: (microvmId: string) => Promise<void>;
      createAuthToken?: (
        microvmId: string,
        port: number,
        expirationMinutes: number,
      ) => Promise<{ token: string }>;
      terminate?: (microvmId: string) => Promise<void>;
    } = {},
  ) {}

  public async resolveImageVersion(imageId: string): Promise<string> {
    this.resolveImageVersionRequests.push(imageId);
    if (this.handlers.resolveImageVersion === undefined) {
      throw new Error("Unexpected resolveImageVersion call");
    }
    return this.handlers.resolveImageVersion(imageId);
  }

  public async run(request: RunMicrovmRequest): Promise<RunMicrovmResult> {
    this.runRequests.push(structuredClone(request));
    if (this.handlers.run === undefined) {
      throw new Error("Unexpected run call");
    }
    return this.handlers.run(request);
  }

  public async suspend(microvmId: string): Promise<void> {
    this.suspendRequests.push(microvmId);
    if (this.handlers.suspend === undefined) {
      throw new Error("Unexpected suspend call");
    }
    await this.handlers.suspend(microvmId);
  }

  public async resume(microvmId: string): Promise<void> {
    this.resumeRequests.push(microvmId);
    if (this.handlers.resume === undefined) {
      throw new Error("Unexpected resume call");
    }
    await this.handlers.resume(microvmId);
  }

  public async createAuthToken(
    microvmId: string,
    port: number,
    expirationMinutes: number,
  ): Promise<{ token: string }> {
    this.authTokenRequests.push({ microvmId, port, expirationMinutes });
    if (this.handlers.createAuthToken === undefined) {
      throw new Error("Unexpected createAuthToken call");
    }
    return this.handlers.createAuthToken(microvmId, port, expirationMinutes);
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
