import { describe, expect, it, vi } from "vitest";

import {
  GitHubResponseError,
  RepositoryGitHubJitClient,
  type GitHubRequester,
} from "../src/github.js";

describe("RepositoryGitHubJitClient", () => {
  it("creates a repository JIT runner with the required request shape", async () => {
    const request = vi.fn<GitHubRequester>(async () => ({
      status: 201,
      data: {
        runner: {
          id: 42,
          name: "lambda-mvm-1",
          status: "offline",
          busy: false,
        },
        encoded_jit_config: "secret-jit",
      },
    }));
    const client = new RepositoryGitHubJitClient(
      "owner",
      "repository",
      request,
    );

    await expect(
      client.createJitRunner({
        owner: "owner",
        repository: "repository",
        runnerName: "lambda-mvm-1",
        runnerGroupId: 1,
        labels: ["self-hosted", "linux", "ARM64"],
      }),
    ).resolves.toEqual({
      runnerId: 42,
      runnerName: "lambda-mvm-1",
      encodedJitConfig: "secret-jit",
    });

    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig",
      expect.objectContaining({
        owner: "owner",
        repo: "repository",
        name: "lambda-mvm-1",
        runner_group_id: 1,
        labels: ["self-hosted", "linux", "ARM64"],
        work_folder: "_work",
      }),
    );
  });

  it("gets and deletes the exact repository runner", async () => {
    const request = vi
      .fn<GitHubRequester>()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 42,
          name: "lambda-mvm-1",
          status: "online",
          busy: false,
        },
      })
      .mockResolvedValueOnce({ status: 204, data: undefined });
    const client = new RepositoryGitHubJitClient(
      "owner",
      "repository",
      request,
    );

    await expect(client.getRunner(42)).resolves.toEqual({
      runnerId: 42,
      runnerName: "lambda-mvm-1",
      status: "online",
      busy: false,
    });
    await expect(client.deleteRunner(42)).resolves.toBeUndefined();

    expect(request.mock.calls[0]?.[1]).toMatchObject({ runner_id: 42 });
    expect(request.mock.calls[1]?.[1]).toMatchObject({ runner_id: 42 });
  });

  it("treats missing runners as absent for lookup and deletion", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const request = vi
      .fn<GitHubRequester>()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound);
    const client = new RepositoryGitHubJitClient(
      "owner",
      "repository",
      request,
    );

    await expect(client.getRunner(42)).resolves.toBeUndefined();
    await expect(client.deleteRunner(42)).resolves.toBeUndefined();
  });

  it("rejects malformed responses without reflecting response content", async () => {
    const secret = "secret-response-content";
    const client = new RepositoryGitHubJitClient(
      "owner",
      "repository",
      async () => ({ status: 201, data: { secret } }),
    );

    await expect(
      client.createJitRunner({
        owner: "owner",
        repository: "repository",
        runnerName: "runner",
        runnerGroupId: 1,
        labels: [],
      }),
    ).rejects.toEqual(expect.any(GitHubResponseError));
    await expect(
      client.createJitRunner({
        owner: "owner",
        repository: "repository",
        runnerName: "runner",
        runnerGroupId: 1,
        labels: [],
      }),
    ).rejects.not.toThrow(secret);
  });
});
