import { getOctokit } from "@actions/github";

import type {
  CreateJitRunnerRequest,
  GitHubJitClient,
  GitHubRunner,
  JitRunner,
} from "./clients.js";

const API_VERSION = "2026-03-10";

type GitHubResponse = {
  status: number;
  data: unknown;
};

export type GitHubRequester = (
  route: string,
  parameters: Record<string, unknown>,
) => Promise<GitHubResponse>;

export class GitHubResponseError extends Error {
  public constructor(operation: string) {
    super(`GitHub ${operation} returned an invalid response`);
    this.name = "GitHubResponseError";
  }
}

export class RepositoryGitHubJitClient implements GitHubJitClient {
  public constructor(
    private readonly owner: string,
    private readonly repository: string,
    private readonly request: GitHubRequester,
  ) {}

  public async createJitRunner(
    request: CreateJitRunnerRequest,
  ): Promise<JitRunner> {
    this.assertRepository(request);
    const response = await this.request(
      "POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig",
      {
        owner: this.owner,
        repo: this.repository,
        name: request.runnerName,
        runner_group_id: request.runnerGroupId,
        labels: request.labels,
        work_folder: "_work",
        headers: {
          "X-GitHub-Api-Version": API_VERSION,
        },
      },
    );
    const data = asRecord(response.data);
    const runner = asRecord(data.runner);
    const runnerId = positiveInteger(runner.id);
    const runnerName = stringValue(runner.name);
    const encodedJitConfig = stringValue(data.encoded_jit_config);

    if (
      response.status !== 201 ||
      runnerId === undefined ||
      runnerName === undefined ||
      encodedJitConfig === undefined ||
      encodedJitConfig.length === 0
    ) {
      throw new GitHubResponseError("JIT creation");
    }

    return { runnerId, runnerName, encodedJitConfig };
  }

  public async getRunner(runnerId: number): Promise<GitHubRunner | undefined> {
    try {
      const response = await this.request(
        "GET /repos/{owner}/{repo}/actions/runners/{runner_id}",
        {
          owner: this.owner,
          repo: this.repository,
          runner_id: runnerId,
          headers: {
            "X-GitHub-Api-Version": API_VERSION,
          },
        },
      );
      const data = asRecord(response.data);
      const id = positiveInteger(data.id);
      const name = stringValue(data.name);
      const status = stringValue(data.status);
      const busy = booleanValue(data.busy);

      if (
        response.status !== 200 ||
        id === undefined ||
        name === undefined ||
        status === undefined ||
        busy === undefined
      ) {
        throw new GitHubResponseError("runner lookup");
      }
      return { runnerId: id, runnerName: name, status, busy };
    } catch (error: unknown) {
      if (httpStatus(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  public async deleteRunner(runnerId: number): Promise<void> {
    try {
      const response = await this.request(
        "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}",
        {
          owner: this.owner,
          repo: this.repository,
          runner_id: runnerId,
          headers: {
            "X-GitHub-Api-Version": API_VERSION,
          },
        },
      );
      if (response.status !== 204) {
        throw new GitHubResponseError("runner deletion");
      }
    } catch (error: unknown) {
      if (httpStatus(error) !== 404) {
        throw error;
      }
    }
  }

  private assertRepository(request: CreateJitRunnerRequest): void {
    if (
      request.owner !== this.owner ||
      request.repository !== this.repository
    ) {
      throw new GitHubResponseError("repository validation");
    }
  }
}

export function createGitHubJitClient(
  token: string,
  owner: string,
  repository: string,
): GitHubJitClient {
  const octokit = getOctokit(token);
  const request = octokit.request.bind(octokit) as unknown as GitHubRequester;
  return new RepositoryGitHubJitClient(owner, repository, request);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status: unknown = Reflect.get(error, "status") as unknown;
  return typeof status === "number" ? status : undefined;
}
