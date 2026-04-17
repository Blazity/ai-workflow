import { Redis } from "@upstash/redis";
import { e2eEnv } from "../env.js";

const HASH_KEY = `blazebot:active-runs:${e2eEnv.VERCEL_ENV}`;
const FAILED_HASH_KEY = `blazebot:failed-tickets:${e2eEnv.VERCEL_ENV}`;

const redis = new Redis({
  url: e2eEnv.AI_WORKFLOW_KV_REST_API_URL,
  token: e2eEnv.AI_WORKFLOW_KV_REST_API_TOKEN,
});

export async function getRunId(ticketKey: string): Promise<string | null> {
  return redis.hget<string>(HASH_KEY, ticketKey);
}


export async function listAll(): Promise<
  Array<{ ticketKey: string; runId: string }>
> {
  const all = await redis.hgetall<Record<string, string>>(HASH_KEY);
  if (!all) return [];
  return Object.entries(all).map(([ticketKey, runId]) => ({
    ticketKey,
    runId,
  }));
}

export async function setEntry(
  ticketKey: string,
  runId: string,
): Promise<void> {
  await redis.hset(HASH_KEY, { [ticketKey]: runId });
}

export async function cleanup(ticketKey: string): Promise<void> {
  await redis.hdel(HASH_KEY, ticketKey).catch(() => {});
}

export interface FailedTicketMeta {
  runId: string;
  error: string;
  failedAt: string;
}

export async function markFailed(
  ticketKey: string,
  meta: FailedTicketMeta,
): Promise<void> {
  await redis.hset(FAILED_HASH_KEY, { [ticketKey]: JSON.stringify(meta) });
}

export async function isTicketFailed(ticketKey: string): Promise<boolean> {
  const value = await redis.hget(FAILED_HASH_KEY, ticketKey);
  return value != null;
}

export async function cleanupFailed(ticketKey: string): Promise<void> {
  await redis.hdel(FAILED_HASH_KEY, ticketKey).catch(() => {});
}
