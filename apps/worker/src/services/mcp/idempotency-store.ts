import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/types.js";
import {
  completeConnectedMcpIdempotencyLease,
  completeMcpIdempotencyLease,
  failConnectedMcpIdempotencyLease,
  failMcpIdempotencyLease,
  findConnectedMcpIdempotencyRow,
  findMcpIdempotencyRow,
  insertConnectedMcpIdempotencyLease,
  insertMcpIdempotencyLease,
  reclaimConnectedMcpIdempotencyLease,
  reclaimMcpIdempotencyLease,
  releaseConnectedMcpIdempotencyLease,
  releaseMcpIdempotencyLease,
  sweepConnectedExpiredMcpIdempotencyKeys,
  sweepExpiredMcpIdempotencyKeys,
} from "../../db/repositories/mcp.js";
import {
  McpPublicError,
  type IdempotencyInput,
  type McpErrorCode,
} from "./contracts.js";

type Lease = Omit<IdempotencyInput, "now" | "expiresAt"> & {
  expiresAt: string;
  nonce: string;
};

// expires_at means two different things depending on the row's state, because
// the schema has one column for both and a started row and a terminal row are
// answering different questions. While the row is "started" it is a lease: the
// deadline after which a caller that never reported back has abandoned its
// attempt, and the key may be taken over. The caller sets that one, short
// enough that a frozen invocation costs minutes. The moment the row turns
// terminal it stops being a lease and becomes the answer, so the expiry moves
// here, to how long a repeat of the same key keeps getting that same answer.
// Reclaiming on "expiresAt <= now" then reads correctly in both states.
const RESPONSE_TTL_MS = 24 * 60 * 60 * 1_000;

const SWEEP_BATCH_LIMIT = 100;

interface McpIdempotencyStore {
  insert: (input: Parameters<typeof insertMcpIdempotencyLease>[1]) => ReturnType<typeof insertMcpIdempotencyLease>;
  find: (input: Parameters<typeof findMcpIdempotencyRow>[1]) => ReturnType<typeof findMcpIdempotencyRow>;
  reclaim: (input: Parameters<typeof reclaimMcpIdempotencyLease>[1]) => ReturnType<typeof reclaimMcpIdempotencyLease>;
  complete: (input: Parameters<typeof completeMcpIdempotencyLease>[1]) => ReturnType<typeof completeMcpIdempotencyLease>;
  fail: (input: Parameters<typeof failMcpIdempotencyLease>[1]) => ReturnType<typeof failMcpIdempotencyLease>;
  release: (input: Parameters<typeof releaseMcpIdempotencyLease>[1]) => ReturnType<typeof releaseMcpIdempotencyLease>;
  sweep: (now: Date, limit: number) => ReturnType<typeof sweepExpiredMcpIdempotencyKeys>;
}

function mcpIdempotencyStore(db: Db): McpIdempotencyStore {
  return {
    insert: (input) => insertMcpIdempotencyLease(db, input),
    find: (input) => findMcpIdempotencyRow(db, input),
    reclaim: (input) => reclaimMcpIdempotencyLease(db, input),
    complete: (input) => completeMcpIdempotencyLease(db, input),
    fail: (input) => failMcpIdempotencyLease(db, input),
    release: (input) => releaseMcpIdempotencyLease(db, input),
    sweep: (now, limit) => sweepExpiredMcpIdempotencyKeys(db, now, limit),
  };
}

const connectedMcpIdempotencyStore: McpIdempotencyStore = {
  insert: insertConnectedMcpIdempotencyLease,
  find: findConnectedMcpIdempotencyRow,
  reclaim: reclaimConnectedMcpIdempotencyLease,
  complete: completeConnectedMcpIdempotencyLease,
  fail: failConnectedMcpIdempotencyLease,
  release: releaseConnectedMcpIdempotencyLease,
  sweep: sweepConnectedExpiredMcpIdempotencyKeys,
};

function leaseFor(input: IdempotencyInput): string {
  const lease: Lease = {
    organizationId: input.organizationId,
    actorSubject: input.actorSubject,
    clientId: input.clientId,
    toolName: input.toolName,
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
    expiresAt: input.expiresAt.toISOString(),
    // Two issuances of the same key can share a deadline down to the
    // millisecond, and a released attempt is retried under the same key at
    // whatever instant the retry arrives. The nonce is what still tells them
    // apart, because callers name durable work after the lease they hold and
    // must never inherit the name a dead attempt already used. Nothing matches
    // on it: expiresAt with state 'started' stays the concurrency token, since
    // the row has no column to keep a nonce in.
    nonce: randomUUID(),
  };
  return Buffer.from(JSON.stringify(lease), "utf8").toString("base64url");
}

function parseLease(leaseId: string): Lease {
  try {
    const parsed = JSON.parse(Buffer.from(leaseId, "base64url").toString("utf8")) as Lease;
    if (
      !parsed ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.actorSubject !== "string" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.toolName !== "string" ||
      typeof parsed.idempotencyKey !== "string" ||
      typeof parsed.payloadHash !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      !Number.isFinite(new Date(parsed.expiresAt).getTime())
    ) {
      throw new Error("invalid lease");
    }
    return parsed;
  } catch {
    throw new McpPublicError("INTERNAL_ERROR", "Invalid mutation lease", false);
  }
}

function safeReplayMessage(code: McpErrorCode): string {
  switch (code) {
    case "DEPENDENCY_UNAVAILABLE":
      return "Dependency unavailable";
    case "RATE_LIMITED":
      return "Rate limit exceeded";
    case "CONFLICT":
      return "Conflict";
    case "IDEMPOTENCY_CONFLICT":
      return "Idempotency conflict";
    case "FORBIDDEN":
    case "INSUFFICIENT_SCOPE":
      return "Access denied";
    case "NOT_FOUND":
      return "Not found";
    case "VALIDATION_FAILED":
      return "Validation failed";
    case "UNAUTHENTICATED":
      return "Authentication required";
    case "INTERNAL_ERROR":
      return "Internal error";
    // Reached whenever a mutation lost the race with its own deadline: the
    // deadline seals the key with this code precisely so a repeat cannot take
    // the lease over and dispatch a second time.
    case "TIMEOUT":
      return "Timed out";
  }
}

// A stored outcome is a record, not a verdict being reached again: the attempt
// that produced it is over, and repeating the same key cannot change it. Saying
// "retryable" here would put an agent in a loop with no exit, so the replay is
// final and names the two moves that do lead somewhere.
function replayedFailure(code: McpErrorCode): McpPublicError {
  return new McpPublicError(
    code,
    `${safeReplayMessage(code)}. This idempotency key already carries the outcome of an earlier attempt: confirm the state with runs.get, and dispatch again under a new idempotency key.`,
    false,
  );
}

async function withSafeStoreErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpPublicError) throw error;
    throw new McpPublicError(
      "DEPENDENCY_UNAVAILABLE",
      "Dependency unavailable",
      true,
    );
  }
}

// Retention sweep for the cron to call. Taking a key over only ever replaces
// one row with another, so nothing on the request path removes a key that is
// simply done with: without this, every key ever issued stays forever. One
// bounded batch per call, oldest first, so repeated ticks converge.
//
// The table carries no surrogate key, so the batch is named by the expiry
// instants it covers rather than by row identity. A row tying with the batch on
// its instant is expired by the same cutoff, so a tie can only take more dead
// rows, never a live one, and the count comes from what the delete removed.
export async function sweepMcpIdempotencyKeys(
  db: Db,
  now: Date,
  options: { limit?: number } = {},
): Promise<{ deleted: number }> {
  return sweepMcpIdempotencyKeysWithStore(mcpIdempotencyStore(db), now, options);
}

export function sweepConnectedMcpIdempotencyKeys(
  now: Date,
  options: { limit?: number } = {},
): Promise<{ deleted: number }> {
  return sweepMcpIdempotencyKeysWithStore(connectedMcpIdempotencyStore, now, options);
}

async function sweepMcpIdempotencyKeysWithStore(
  store: McpIdempotencyStore,
  now: Date,
  options: { limit?: number },
): Promise<{ deleted: number }> {
  return { deleted: await store.sweep(now, options.limit ?? SWEEP_BATCH_LIMIT) };
}

export async function beginMcpMutation<T>(
  db: Db,
  input: IdempotencyInput,
): Promise<{ kind: "execute"; leaseId: string } | { kind: "replay"; response: T }> {
  return beginMcpMutationWithStore<T>(mcpIdempotencyStore(db), input);
}

export function beginConnectedMcpMutation<T>(
  input: IdempotencyInput,
): Promise<{ kind: "execute"; leaseId: string } | { kind: "replay"; response: T }> {
  return beginMcpMutationWithStore<T>(connectedMcpIdempotencyStore, input);
}

async function beginMcpMutationWithStore<T>(
  store: McpIdempotencyStore,
  input: IdempotencyInput,
): Promise<{ kind: "execute"; leaseId: string } | { kind: "replay"; response: T }> {
  return withSafeStoreErrors(async () => {
    const inserted = await store.insert(input);
    if (inserted) return { kind: "execute", leaseId: leaseFor(input) };

    let existing = await store.find(input);
    if (!existing) {
      throw new McpPublicError("CONFLICT", "Concurrent mutation, retry", true);
    }
    // Checked before anything is overwritten, because taking a row over is a
    // retry of the request it names and the payload is what says whether this
    // is that request. A "started" row is protected even once its lease is
    // gone: the attempt it names has an unknown outcome, so stamping a
    // different payload onto it would both hide a second ticket behind one key
    // and leave that attempt able to write its answer into a row that by then
    // describes something else. A terminal row past its response lifetime is
    // the opposite, a forgotten key that anything may claim, which is what the
    // expiry is for.
    const rejectDifferentRequest = (row: {
      payloadHash: string;
      state: string;
      expiresAt: Date;
    }): void => {
      const spent =
        row.state !== "started" && row.expiresAt.getTime() <= input.now.getTime();
      if (row.payloadHash === input.payloadHash || spent) return;
      throw new McpPublicError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was used with a different payload",
        false,
      );
    };
    rejectDifferentRequest(existing);

    if (existing.expiresAt.getTime() <= input.now.getTime()) {
      const reclaimed = await store.reclaim({ ...input, now: input.now });
      if (reclaimed) {
        return { kind: "execute" as const, leaseId: leaseFor(input) };
      }
      existing = await store.find(input);
      if (!existing) {
        throw new McpPublicError("CONFLICT", "Concurrent mutation, retry", true);
      }
      // The row that won the race is a different row than the one checked
      // above, and it may well name a different request.
      rejectDifferentRequest(existing);
    }

    if (existing.state === "completed") {
      return { kind: "replay" as const, response: existing.safeResponse as T };
    }
    if (existing.state === "failed") {
      throw replayedFailure((existing.errorCode ?? "INTERNAL_ERROR") as McpErrorCode);
    }
    throw new McpPublicError("CONFLICT", "Mutation is still in progress; retry", true);
  });
}

export async function completeMcpMutation<T>(
  db: Db,
  leaseId: string,
  response: T,
  now: Date,
): Promise<void> {
  return completeMcpMutationWithStore(mcpIdempotencyStore(db), leaseId, response, now);
}

export function completeConnectedMcpMutation<T>(
  leaseId: string,
  response: T,
  now: Date,
): Promise<void> {
  return completeMcpMutationWithStore(connectedMcpIdempotencyStore, leaseId, response, now);
}

async function completeMcpMutationWithStore<T>(
  store: McpIdempotencyStore,
  leaseId: string,
  response: T,
  now: Date,
): Promise<void> {
  return withSafeStoreErrors(async () => {
    const lease = parseLease(leaseId);
    const updated = await store.complete({
      ...lease,
      leaseExpiresAt: new Date(lease.expiresAt),
      response,
      expiresAt: new Date(now.getTime() + RESPONSE_TTL_MS),
    });
    if (!updated) {
      throw new McpPublicError("CONFLICT", "Mutation lease is no longer active", true);
    }
  });
}

// The third way out of a lease, next to completing and failing it: the attempt
// is over and left nothing worth replaying, so the key goes back to being
// unused. Deleting is what makes the next attempt genuinely new. A terminal row
// has no way back out, so marking one here would answer every retry with a
// refusal that was only ever about the attempt that hit it, for the entire
// response lifetime. Same optimistic guard as the terminal transitions, so a
// lease already taken over by someone else is never deleted underneath them.
export async function releaseMcpMutation(db: Db, leaseId: string): Promise<void> {
  return releaseMcpMutationWithStore(mcpIdempotencyStore(db), leaseId);
}

export function releaseConnectedMcpMutation(leaseId: string): Promise<void> {
  return releaseMcpMutationWithStore(connectedMcpIdempotencyStore, leaseId);
}

async function releaseMcpMutationWithStore(
  store: McpIdempotencyStore,
  leaseId: string,
): Promise<void> {
  return withSafeStoreErrors(async () => {
    const lease = parseLease(leaseId);
    const released = await store.release({
      ...lease,
      leaseExpiresAt: new Date(lease.expiresAt),
    });
    if (!released) {
      throw new McpPublicError("CONFLICT", "Mutation lease is no longer active", true);
    }
  });
}

export async function failMcpMutation(
  db: Db,
  leaseId: string,
  errorCode: McpErrorCode,
  now: Date,
): Promise<void> {
  return failMcpMutationWithStore(mcpIdempotencyStore(db), leaseId, errorCode, now);
}

export function failConnectedMcpMutation(
  leaseId: string,
  errorCode: McpErrorCode,
  now: Date,
): Promise<void> {
  return failMcpMutationWithStore(connectedMcpIdempotencyStore, leaseId, errorCode, now);
}

async function failMcpMutationWithStore(
  store: McpIdempotencyStore,
  leaseId: string,
  errorCode: McpErrorCode,
  now: Date,
): Promise<void> {
  return withSafeStoreErrors(async () => {
    const lease = parseLease(leaseId);
    const updated = await store.fail({
      ...lease,
      leaseExpiresAt: new Date(lease.expiresAt),
      errorCode,
      expiresAt: new Date(now.getTime() + RESPONSE_TTL_MS),
    });
    if (!updated) {
      throw new McpPublicError("CONFLICT", "Mutation lease is no longer active", true);
    }
  });
}
