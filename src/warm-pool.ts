import { createHash } from "node:crypto";

import {
  DynamoDBClient,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

import { getSafeErrorName } from "./retry.js";

const CONTROL_SORT_KEY = "CONTROL";
const MEMBER_PREFIX = "MEMBER#";
const MAX_ACQUIRE_ATTEMPTS = 8;

export type WarmMemberState =
  "CREATING" | "READY" | "LEASED" | "SUSPENDING" | "DESTROYING" | "DEAD";

export type WarmPoolMember = {
  poolKey: string;
  memberId: string;
  state: WarmMemberState;
  leaseId: string;
  leaseGeneration: number;
  acquisitionId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  microvmId?: string;
  endpoint?: string;
  imageVersion?: string;
  startedAt?: number;
  maxLifetimeSeconds?: number;
  expiresAt?: number;
  reuseDeadline?: number;
  lastUsedAt?: number;
};

export type AcquireWarmPoolRequest = {
  poolKey: string;
  acquisitionId: string;
  leaseId: string;
  leaseOwner: string;
  now: number;
  leaseExpiresAt: number;
  serverCapacity?: number;
};

export type AcquiredWarmMember = {
  member: WarmPoolMember;
  needsCreation: boolean;
};

export type CreatedWarmMember = {
  microvmId: string;
  endpoint: string;
  imageVersion: string;
  startedAt: number;
  maxLifetimeSeconds: number;
  expiresAt: number;
  reuseDeadline: number;
  ttl: number;
};

export class PoolAtCapacityError extends Error {
  public constructor(capacity: number) {
    super(`Warm server pool is at request capacity ${String(capacity)}`);
    this.name = "PoolAtCapacityError";
  }
}

export class WarmPoolStateError extends Error {
  public constructor(operation: string) {
    super(`Warm pool state operation failed: ${operation}`);
    this.name = "WarmPoolStateError";
  }
}

export type WarmPoolStore = {
  acquire(request: AcquireWarmPoolRequest): Promise<AcquiredWarmMember>;
  markCreated(
    member: WarmPoolMember,
    created: CreatedWarmMember,
  ): Promise<WarmPoolMember>;
  beginRelease(
    member: WarmPoolMember,
    destroy: boolean,
  ): Promise<WarmPoolMember>;
  completeRelease(member: WarmPoolMember, now: number): Promise<void>;
  markDead(member: WarmPoolMember): Promise<void>;
  abandonCreation(member: WarmPoolMember): Promise<void>;
  reconciliationCandidates(
    poolKey: string,
    now: number,
  ): Promise<WarmPoolMember[]>;
  beginReconciliation(
    member: WarmPoolMember,
    now: number,
  ): Promise<WarmPoolMember | undefined>;
  markReconciledDead(member: WarmPoolMember): Promise<void>;
};

type DynamoSender = (command: object) => Promise<unknown>;

export class DynamoWarmPoolStore implements WarmPoolStore {
  public constructor(
    private readonly tableName: string,
    private readonly send: DynamoSender,
  ) {}

  public async acquire(
    request: AcquireWarmPoolRequest,
  ): Promise<AcquiredWarmMember> {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const items = await this.query(request.poolKey);
      const idempotent = items.members.find(
        (member) =>
          member.acquisitionId === request.acquisitionId &&
          ["CREATING", "LEASED"].includes(member.state),
      );
      if (idempotent !== undefined) {
        return {
          member: idempotent,
          needsCreation: idempotent.state === "CREATING",
        };
      }

      const ready = items.members
        .filter(
          (member) =>
            member.state === "READY" &&
            member.reuseDeadline !== undefined &&
            member.reuseDeadline > request.now,
        )
        .sort(
          (left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0),
        );
      for (const member of ready) {
        const claimed = await this.claimReady(member, request);
        if (claimed !== undefined) {
          return { member: claimed, needsCreation: false };
        }
      }

      if (
        request.serverCapacity !== undefined &&
        items.activeCount >= request.serverCapacity
      ) {
        throw new PoolAtCapacityError(request.serverCapacity);
      }
      const reserved = reservation(request);
      try {
        await this.reserveCreation(reserved, request.serverCapacity);
        return { member: reserved, needsCreation: true };
      } catch (error: unknown) {
        if (!isContention(error)) {
          throw new WarmPoolStateError("reserve creation");
        }
      }
    }
    throw new WarmPoolStateError("acquire contention exhausted");
  }

  public async markCreated(
    member: WarmPoolMember,
    created: CreatedWarmMember,
  ): Promise<WarmPoolMember> {
    const response = record(
      await this.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key(member.poolKey, member.memberId),
          ConditionExpression:
            "#state = :creating AND leaseId = :leaseId AND leaseGeneration = :generation",
          UpdateExpression:
            "SET #state = :leased, microvmId = :microvmId, endpoint = :endpoint, imageVersion = :imageVersion, startedAt = :startedAt, maxLifetimeSeconds = :maxLifetime, expiresAt = :expiresAt, reuseDeadline = :reuseDeadline, #ttl = :ttl",
          ExpressionAttributeNames: { "#state": "state", "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":creating": textValue("CREATING"),
            ":leased": textValue("LEASED"),
            ":leaseId": textValue(member.leaseId),
            ":generation": numberAttribute(member.leaseGeneration),
            ":microvmId": textValue(created.microvmId),
            ":endpoint": textValue(created.endpoint),
            ":imageVersion": textValue(created.imageVersion),
            ":startedAt": numberAttribute(created.startedAt),
            ":maxLifetime": numberAttribute(created.maxLifetimeSeconds),
            ":expiresAt": numberAttribute(created.expiresAt),
            ":reuseDeadline": numberAttribute(created.reuseDeadline),
            ":ttl": numberAttribute(created.ttl),
          },
          ReturnValues: "ALL_NEW",
        }),
      ),
    );
    return parseMember(attributes(response.Attributes));
  }

  public async beginRelease(
    member: WarmPoolMember,
    destroy: boolean,
  ): Promise<WarmPoolMember> {
    const response = record(
      await this.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key(member.poolKey, member.memberId),
          ConditionExpression:
            "#state = :leased AND leaseId = :leaseId AND leaseGeneration = :generation",
          UpdateExpression: "SET #state = :nextState",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":leased": textValue("LEASED"),
            ":nextState": textValue(destroy ? "DESTROYING" : "SUSPENDING"),
            ":leaseId": textValue(member.leaseId),
            ":generation": numberAttribute(member.leaseGeneration),
          },
          ReturnValues: "ALL_NEW",
        }),
      ),
    );
    return parseMember(attributes(response.Attributes));
  }

  public async completeRelease(
    member: WarmPoolMember,
    now: number,
  ): Promise<void> {
    await this.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: key(member.poolKey, member.memberId),
        ConditionExpression:
          "#state = :suspending AND leaseId = :leaseId AND leaseGeneration = :generation",
        UpdateExpression:
          "SET #state = :ready, lastUsedAt = :now REMOVE leaseId, leaseOwner, leaseExpiresAt, acquisitionId",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":suspending": textValue("SUSPENDING"),
          ":ready": textValue("READY"),
          ":leaseId": textValue(member.leaseId),
          ":generation": numberAttribute(member.leaseGeneration),
          ":now": numberAttribute(now),
        },
      }),
    );
  }

  public async markDead(member: WarmPoolMember): Promise<void> {
    try {
      await this.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key(member.poolKey, member.memberId),
                ConditionExpression:
                  "#state = :destroying AND leaseId = :leaseId AND leaseGeneration = :generation",
                UpdateExpression:
                  "SET #state = :dead REMOVE leaseId, leaseOwner, leaseExpiresAt, acquisitionId",
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: {
                  ":destroying": textValue("DESTROYING"),
                  ":dead": textValue("DEAD"),
                  ":leaseId": textValue(member.leaseId),
                  ":generation": numberAttribute(member.leaseGeneration),
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: controlKey(member.poolKey),
                ConditionExpression: "activeCount > :zero",
                UpdateExpression: "ADD activeCount :minusOne",
                ExpressionAttributeValues: {
                  ":zero": numberAttribute(0),
                  ":minusOne": numberAttribute(-1),
                },
              },
            },
          ],
        }),
      );
    } catch (error: unknown) {
      if (!isContention(error)) {
        throw new WarmPoolStateError("mark dead");
      }
    }
  }

  public async abandonCreation(member: WarmPoolMember): Promise<void> {
    try {
      await this.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key(member.poolKey, member.memberId),
                ConditionExpression:
                  "#state = :creating AND leaseId = :leaseId AND leaseGeneration = :generation",
                UpdateExpression:
                  "SET #state = :dead REMOVE leaseId, leaseOwner, leaseExpiresAt, acquisitionId",
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: {
                  ":creating": textValue("CREATING"),
                  ":dead": textValue("DEAD"),
                  ":leaseId": textValue(member.leaseId),
                  ":generation": numberAttribute(member.leaseGeneration),
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: controlKey(member.poolKey),
                ConditionExpression: "activeCount > :zero",
                UpdateExpression: "ADD activeCount :minusOne",
                ExpressionAttributeValues: {
                  ":zero": numberAttribute(0),
                  ":minusOne": numberAttribute(-1),
                },
              },
            },
          ],
        }),
      );
    } catch (error: unknown) {
      if (!isContention(error)) {
        throw new WarmPoolStateError("abandon creation");
      }
    }
  }

  public async reconciliationCandidates(
    poolKey: string,
    now: number,
  ): Promise<WarmPoolMember[]> {
    const { members } = await this.query(poolKey);
    return members.filter((member) => {
      if (member.state === "DEAD") {
        return false;
      }
      if (member.expiresAt !== undefined && member.expiresAt <= now) {
        return true;
      }
      if (
        member.state === "READY" &&
        member.reuseDeadline !== undefined &&
        member.reuseDeadline <= now
      ) {
        return true;
      }
      return (
        ["CREATING", "LEASED", "SUSPENDING", "DESTROYING"].includes(
          member.state,
        ) &&
        member.leaseExpiresAt > 0 &&
        member.leaseExpiresAt <= now
      );
    });
  }

  public async beginReconciliation(
    member: WarmPoolMember,
    now: number,
  ): Promise<WarmPoolMember | undefined> {
    try {
      const response = record(
        await this.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: key(member.poolKey, member.memberId),
            ConditionExpression:
              "#state = :expectedState AND leaseGeneration = :generation AND (expiresAt <= :now OR reuseDeadline <= :now OR leaseExpiresAt <= :now)",
            UpdateExpression: "SET #state = :destroying",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: {
              ":expectedState": textValue(member.state),
              ":generation": numberAttribute(member.leaseGeneration),
              ":now": numberAttribute(now),
              ":destroying": textValue("DESTROYING"),
            },
            ReturnValues: "ALL_NEW",
          }),
        ),
      );
      return parseMember(attributes(response.Attributes));
    } catch (error: unknown) {
      if (isContention(error)) {
        return undefined;
      }
      throw new WarmPoolStateError("begin reconciliation");
    }
  }

  public async markReconciledDead(member: WarmPoolMember): Promise<void> {
    try {
      await this.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key(member.poolKey, member.memberId),
                ConditionExpression:
                  "#state = :destroying AND leaseGeneration = :generation",
                UpdateExpression:
                  "SET #state = :dead REMOVE leaseId, leaseOwner, leaseExpiresAt, acquisitionId",
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: {
                  ":destroying": textValue("DESTROYING"),
                  ":dead": textValue("DEAD"),
                  ":generation": numberAttribute(member.leaseGeneration),
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: controlKey(member.poolKey),
                ConditionExpression: "activeCount > :zero",
                UpdateExpression: "ADD activeCount :minusOne",
                ExpressionAttributeValues: {
                  ":zero": numberAttribute(0),
                  ":minusOne": numberAttribute(-1),
                },
              },
            },
          ],
        }),
      );
    } catch (error: unknown) {
      if (!isContention(error)) {
        throw new WarmPoolStateError("complete reconciliation");
      }
    }
  }

  private async query(poolKey: string): Promise<{
    activeCount: number;
    members: WarmPoolMember[];
  }> {
    const items: Record<string, AttributeValue>[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = record(
        await this.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": textValue(poolKey) },
            ConsistentRead: true,
            ...(exclusiveStartKey === undefined
              ? {}
              : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        ),
      );
      if (Array.isArray(response.Items)) {
        items.push(...response.Items.map(attributes));
      }
      const lastKey = attributes(response.LastEvaluatedKey);
      if (Object.keys(lastKey).length === 0) {
        exclusiveStartKey = undefined;
        break;
      }
      exclusiveStartKey = lastKey;
    }
    if (exclusiveStartKey !== undefined) {
      throw new WarmPoolStateError("pool partition is too large");
    }
    const control = items.find(
      (item) => stringAttribute(item.SK) === CONTROL_SORT_KEY,
    );
    const members = items
      .filter((item) => stringAttribute(item.SK)?.startsWith(MEMBER_PREFIX))
      .map(parseMember);
    return {
      activeCount: numericAttribute(control?.activeCount) ?? 0,
      members,
    };
  }

  private async claimReady(
    member: WarmPoolMember,
    request: AcquireWarmPoolRequest,
  ): Promise<WarmPoolMember | undefined> {
    try {
      const response = record(
        await this.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: key(member.poolKey, member.memberId),
            ConditionExpression: "#state = :ready AND reuseDeadline > :now",
            UpdateExpression:
              "SET #state = :leased, leaseId = :leaseId, leaseGeneration = if_not_exists(leaseGeneration, :zero) + :one, acquisitionId = :acquisitionId, leaseOwner = :leaseOwner, leaseExpiresAt = :leaseExpiresAt",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: {
              ":ready": textValue("READY"),
              ":leased": textValue("LEASED"),
              ":now": numberAttribute(request.now),
              ":leaseId": textValue(request.leaseId),
              ":zero": numberAttribute(0),
              ":one": numberAttribute(1),
              ":acquisitionId": textValue(request.acquisitionId),
              ":leaseOwner": textValue(request.leaseOwner),
              ":leaseExpiresAt": numberAttribute(request.leaseExpiresAt),
            },
            ReturnValues: "ALL_NEW",
          }),
        ),
      );
      return parseMember(attributes(response.Attributes));
    } catch (error: unknown) {
      if (isContention(error)) {
        return undefined;
      }
      throw new WarmPoolStateError("claim ready member");
    }
  }

  private async reserveCreation(
    member: WarmPoolMember,
    capacity: number | undefined,
  ): Promise<void> {
    await this.send(
      new TransactWriteItemsCommand({
        ClientRequestToken: member.acquisitionId.slice(0, 36),
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: controlKey(member.poolKey),
              ...(capacity === undefined
                ? {}
                : {
                    ConditionExpression:
                      "attribute_not_exists(activeCount) OR activeCount < :capacity",
                  }),
              UpdateExpression: "SET itemType = :control ADD activeCount :one",
              ExpressionAttributeValues: {
                ":control": textValue("CONTROL"),
                ":one": numberAttribute(1),
                ...(capacity === undefined
                  ? {}
                  : { ":capacity": numberAttribute(capacity) }),
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: memberItem(member),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  }
}

export function createDynamoWarmPoolStore(
  tableName: string,
  region: string,
): DynamoWarmPoolStore {
  const client = new DynamoDBClient({ region, maxAttempts: 1 });
  return new DynamoWarmPoolStore(
    tableName,
    client.send.bind(client) as unknown as DynamoSender,
  );
}

export function effectivePoolKey(input: {
  repositoryId: string;
  serverKey: string;
  region: string;
  architecture: string;
  imageId: string;
  imageVersion: string;
  executionRoleArn: string;
  ingressConnectors: string[];
  egressConnectors: string[];
  maxLifetimeSeconds: number;
}): string {
  const canonical = JSON.stringify({
    repositoryId: input.repositoryId,
    serverKey: input.serverKey,
    region: input.region,
    architecture: input.architecture,
    imageId: input.imageId,
    imageVersion: input.imageVersion,
    executionRoleArn: input.executionRoleArn,
    ingressConnectors: [...input.ingressConnectors].sort(),
    egressConnectors: [...input.egressConnectors].sort(),
    maxLifetimeSeconds: input.maxLifetimeSeconds,
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `REPOSITORY#${input.repositoryId}#SERVER#${digest}`;
}

function reservation(request: AcquireWarmPoolRequest): WarmPoolMember {
  const memberId = createHash("sha256")
    .update(`${request.poolKey}\0${request.acquisitionId}`)
    .digest("hex");
  return {
    poolKey: request.poolKey,
    memberId,
    state: "CREATING",
    leaseId: request.leaseId,
    leaseGeneration: 1,
    acquisitionId: request.acquisitionId,
    leaseOwner: request.leaseOwner,
    leaseExpiresAt: request.leaseExpiresAt,
  };
}

function memberItem(member: WarmPoolMember): Record<string, AttributeValue> {
  return {
    PK: textValue(member.poolKey),
    SK: textValue(`${MEMBER_PREFIX}${member.memberId}`),
    itemType: textValue("MEMBER"),
    memberId: textValue(member.memberId),
    state: textValue(member.state),
    leaseId: textValue(member.leaseId),
    leaseGeneration: numberAttribute(member.leaseGeneration),
    acquisitionId: textValue(member.acquisitionId),
    leaseOwner: textValue(member.leaseOwner),
    leaseExpiresAt: numberAttribute(member.leaseExpiresAt),
  };
}

function parseMember(item: Record<string, AttributeValue>): WarmPoolMember {
  const poolKey = requiredString(item.PK);
  const memberId = requiredString(item.memberId);
  const state = requiredString(item.state) as WarmMemberState;
  if (
    !(
      [
        "CREATING",
        "READY",
        "LEASED",
        "SUSPENDING",
        "DESTROYING",
        "DEAD",
      ] as string[]
    ).includes(state)
  ) {
    throw new WarmPoolStateError("invalid member state");
  }
  return {
    poolKey,
    memberId,
    state,
    leaseId: stringAttribute(item.leaseId) ?? "",
    leaseGeneration: numericAttribute(item.leaseGeneration) ?? 0,
    acquisitionId: stringAttribute(item.acquisitionId) ?? "",
    leaseOwner: stringAttribute(item.leaseOwner) ?? "",
    leaseExpiresAt: numericAttribute(item.leaseExpiresAt) ?? 0,
    ...optionalString("microvmId", item.microvmId),
    ...optionalString("endpoint", item.endpoint),
    ...optionalString("imageVersion", item.imageVersion),
    ...optionalNumber("startedAt", item.startedAt),
    ...optionalNumber("maxLifetimeSeconds", item.maxLifetimeSeconds),
    ...optionalNumber("expiresAt", item.expiresAt),
    ...optionalNumber("reuseDeadline", item.reuseDeadline),
    ...optionalNumber("lastUsedAt", item.lastUsedAt),
  };
}

function key(
  poolKey: string,
  memberId: string,
): Record<string, AttributeValue> {
  return {
    PK: textValue(poolKey),
    SK: textValue(`${MEMBER_PREFIX}${memberId}`),
  };
}

function controlKey(poolKey: string): Record<string, AttributeValue> {
  return { PK: textValue(poolKey), SK: textValue(CONTROL_SORT_KEY) };
}

function textValue(value: string): AttributeValue {
  return { S: value };
}

function numberAttribute(value: number): AttributeValue {
  return { N: String(value) };
}

function stringAttribute(
  value: AttributeValue | undefined,
): string | undefined {
  return value !== undefined && "S" in value ? value.S : undefined;
}

function numericAttribute(
  value: AttributeValue | undefined,
): number | undefined {
  if (value === undefined || !("N" in value)) {
    return undefined;
  }
  const parsed = Number(value.N);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function requiredString(value: AttributeValue | undefined): string {
  const parsed = stringAttribute(value);
  if (parsed === undefined) {
    throw new WarmPoolStateError("invalid member item");
  }
  return parsed;
}

function optionalString(
  name: string,
  value: AttributeValue | undefined,
): Record<string, string> {
  const parsed = stringAttribute(value);
  return parsed === undefined ? {} : { [name]: parsed };
}

function optionalNumber(
  name: string,
  value: AttributeValue | undefined,
): Record<string, number> {
  const parsed = numericAttribute(value);
  return parsed === undefined ? {} : { [name]: parsed };
}

function attributes(value: unknown): Record<string, AttributeValue> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, AttributeValue>)
    : {};
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function isContention(error: unknown): boolean {
  return [
    "ConditionalCheckFailedException",
    "TransactionCanceledException",
    "TransactionConflictException",
  ].includes(getSafeErrorName(error));
}
