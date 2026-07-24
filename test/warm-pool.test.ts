import {
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";

import {
  DynamoWarmPoolStore,
  effectivePoolKey,
  PoolAtCapacityError,
} from "../src/warm-pool.js";

const request = {
  poolKey: "REPOSITORY#123#SERVER#abc",
  acquisitionId: "acquisition-1",
  leaseId: "a".repeat(64),
  leaseOwner: "run:1:job",
  now: 5_000,
  leaseExpiresAt: 10_000,
};

describe("DynamoWarmPoolStore", () => {
  it("claims the most recently used healthy READY member conditionally", async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof QueryCommand) {
        expect(command.input.ConsistentRead).toBe(true);
        return {
          Items: [
            controlItem(2),
            memberItem("older", 4_000),
            memberItem("newer", 4_500),
          ],
        };
      }
      expect(command).toBeInstanceOf(UpdateItemCommand);
      const update = (command as UpdateItemCommand).input;
      expect(update.Key?.SK).toEqual({ S: "MEMBER#newer" });
      expect(update.ConditionExpression).toContain("#state = :ready");
      return {
        Attributes: leasedMemberItem("newer", request.leaseId),
      };
    });
    const store = new DynamoWarmPoolStore("warm-state", send);

    await expect(store.acquire(request)).resolves.toMatchObject({
      needsCreation: false,
      member: { memberId: "newer", state: "LEASED" },
    });
  });

  it("fails clearly without writing when this request is at capacity", async () => {
    const send = vi.fn(async (command: object) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return { Items: [controlItem(2)] };
    });
    const store = new DynamoWarmPoolStore("warm-state", send);

    await expect(
      store.acquire({ ...request, serverCapacity: 2 }),
    ).rejects.toBeInstanceOf(PoolAtCapacityError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reserves count and CREATING member in one bounded transaction", async () => {
    const send = vi
      .fn<(command: object) => Promise<unknown>>()
      .mockResolvedValueOnce({ Items: [controlItem(2)] })
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(TransactWriteItemsCommand);
        const transaction = (command as TransactWriteItemsCommand).input;
        expect(transaction.TransactItems).toHaveLength(2);
        expect(
          transaction.TransactItems?.[0]?.Update?.ConditionExpression,
        ).toContain("activeCount < :capacity");
        expect(transaction.TransactItems?.[1]?.Put?.ConditionExpression).toBe(
          "attribute_not_exists(PK)",
        );
        return {};
      });
    const store = new DynamoWarmPoolStore("warm-state", send);

    const result = await store.acquire({ ...request, serverCapacity: 3 });
    expect(result.needsCreation).toBe(true);
    expect(result.member.state).toBe("CREATING");
  });

  it("atomically limits twenty concurrent creators to capacity five", async () => {
    const memory = new ReservationDynamo();
    const store = new DynamoWarmPoolStore("warm-state", memory.send);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, async (_value, index) =>
        store.acquire({
          ...request,
          acquisitionId: `acquisition-${String(index)}`,
          leaseId: index.toString(16).padStart(64, "0"),
          serverCapacity: 5,
        }),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      5,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      15,
    );
    expect(memory.activeCount).toBe(5);
    expect(memory.members.size).toBe(5);
  });

  it("applies mixed capacities locally and lets omission grow the busy pool", async () => {
    const memory = new ReservationDynamo();
    const store = new DynamoWarmPoolStore("warm-state", memory.send);
    for (let index = 0; index < 3; index += 1) {
      await store.acquire(uniqueRequest(index, 3));
    }
    await expect(store.acquire(uniqueRequest(10, 2))).rejects.toBeInstanceOf(
      PoolAtCapacityError,
    );
    await expect(store.acquire(uniqueRequest(11, 4))).resolves.toMatchObject({
      needsCreation: true,
    });
    await expect(
      store.acquire({
        ...request,
        acquisitionId: "acquisition-12",
        leaseId: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ needsCreation: true });
    expect(memory.activeCount).toBe(5);
  });
});

describe("effectivePoolKey", () => {
  const input = {
    repositoryId: "123",
    serverKey: "docker-builds",
    region: "us-east-1",
    architecture: "ARM64",
    imageId: "image",
    imageVersion: "7",
    executionRoleArn: "role",
    ingressConnectors: ["b", "a"],
    egressConnectors: ["internet"],
    maxLifetimeSeconds: 7_200,
  };

  it("is stable across connector order and changes across compatibility boundaries", () => {
    expect(effectivePoolKey({ ...input, ingressConnectors: ["a", "b"] })).toBe(
      effectivePoolKey(input),
    );
    expect(effectivePoolKey({ ...input, maxLifetimeSeconds: 3_600 })).not.toBe(
      effectivePoolKey(input),
    );
    expect(effectivePoolKey({ ...input, repositoryId: "456" })).not.toBe(
      effectivePoolKey(input),
    );
  });
});

function controlItem(activeCount: number) {
  return {
    PK: { S: request.poolKey },
    SK: { S: "CONTROL" },
    activeCount: { N: String(activeCount) },
  };
}

function memberItem(memberId: string, lastUsedAt: number) {
  return {
    PK: { S: request.poolKey },
    SK: { S: `MEMBER#${memberId}` },
    memberId: { S: memberId },
    state: { S: "READY" },
    leaseGeneration: { N: "1" },
    reuseDeadline: { N: "9000" },
    lastUsedAt: { N: String(lastUsedAt) },
  };
}

function leasedMemberItem(memberId: string, leaseId: string) {
  return {
    ...memberItem(memberId, 4_500),
    state: { S: "LEASED" },
    leaseId: { S: leaseId },
    leaseGeneration: { N: "2" },
    acquisitionId: { S: request.acquisitionId },
    leaseOwner: { S: request.leaseOwner },
    leaseExpiresAt: { N: String(request.leaseExpiresAt) },
    microvmId: { S: "mvm-1" },
    endpoint: { S: "mvm.example" },
    imageVersion: { S: "7" },
    startedAt: { N: "1000" },
    maxLifetimeSeconds: { N: "7200" },
    expiresAt: { N: "7201000" },
  };
}

function uniqueRequest(index: number, capacity: number) {
  return {
    ...request,
    acquisitionId: `acquisition-${String(index)}`,
    leaseId: index.toString(16).padStart(64, "0"),
    serverCapacity: capacity,
  };
}

class ReservationDynamo {
  public activeCount = 0;
  public readonly members = new Map<string, Record<string, unknown>>();

  public readonly send = async (command: object): Promise<unknown> => {
    await Promise.resolve();
    if (command instanceof QueryCommand) {
      return {
        Items: [controlItem(this.activeCount), ...this.members.values()],
      };
    }
    if (command instanceof TransactWriteItemsCommand) {
      const transaction = command.input.TransactItems;
      const update = transaction?.[0]?.Update;
      const put = transaction?.[1]?.Put;
      const capacityText = update?.ExpressionAttributeValues?.[":capacity"];
      const capacity =
        capacityText !== undefined && "N" in capacityText
          ? Number(capacityText.N)
          : undefined;
      const item = put?.Item as Record<string, unknown> | undefined;
      const memberIdValue = item?.memberId;
      const memberId =
        typeof memberIdValue === "object" &&
        memberIdValue !== null &&
        "S" in memberIdValue
          ? String(memberIdValue.S)
          : undefined;
      if (
        (capacity !== undefined && this.activeCount >= capacity) ||
        memberId === undefined ||
        this.members.has(memberId)
      ) {
        throw Object.assign(new Error("conditional"), {
          name: "TransactionCanceledException",
        });
      }
      this.activeCount += 1;
      this.members.set(memberId, item ?? {});
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  };
}
