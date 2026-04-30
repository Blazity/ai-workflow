import { Redis } from "@upstash/redis";
import type { RunRegistryAdapter, FailedTicketMeta, ThreadStore } from "./types.js";

const ENV_PREFIX = process.env.VERCEL_ENV ?? "development";
const HASH_KEY = `blazebot:active-runs:${ENV_PREFIX}`;
const FAILED_HASH_KEY = `blazebot:failed-tickets:${ENV_PREFIX}`;
const SANDBOX_HASH_KEY = `blazebot:sandboxes:${ENV_PREFIX}`;
const ENTRY_TS_HASH_KEY = `blazebot:entry-timestamps:${ENV_PREFIX}`;
const THREAD_HASH_KEY = `blazebot:thread-parents:${ENV_PREFIX}`;

export class UpstashRunRegistry implements RunRegistryAdapter, ThreadStore {
  private redis: Redis;

  constructor(opts: { url: string; token: string }) {
    this.redis = new Redis({ url: opts.url, token: opts.token });
  }

  async claim(ticketKey: string, runId: string): Promise<boolean> {
    const result = await this.redis.hsetnx(HASH_KEY, ticketKey, runId);
    if (result !== 1) return false;
    // Stamp creation time so reconcile can tell a just-written entry from
    // a genuine orphan. Best-effort — if this write fails, reconcile just
    // falls back to treating the entry as ageless (cleanup-eligible).
    await this.redis
      .hset(ENTRY_TS_HASH_KEY, { [ticketKey]: String(Date.now()) })
      .catch(() => {});
    return true;
  }

  async register(ticketKey: string, runId: string): Promise<void> {
    await this.redis.hset(HASH_KEY, { [ticketKey]: runId });
    // Ensure the hash has no expiry — defend against external TTL being set
    await this.redis.persist(HASH_KEY);
    // Refresh the creation timestamp: register() is called both on the
    // initial claim → runId swap and by external seeders, so it's the
    // authoritative write point.
    await this.redis
      .hset(ENTRY_TS_HASH_KEY, { [ticketKey]: String(Date.now()) })
      .catch(() => {});
  }

  async getRunId(ticketKey: string): Promise<string | null> {
    return this.redis.hget<string>(HASH_KEY, ticketKey);
  }

  async unregister(ticketKey: string): Promise<void> {
    // Clear all three hashes in one round-trip. Each is useless without
    // the others, and callers expect unregister() to fully detach.
    await Promise.all([
      this.redis.hdel(HASH_KEY, ticketKey),
      this.redis.hdel(SANDBOX_HASH_KEY, ticketKey),
      this.redis.hdel(ENTRY_TS_HASH_KEY, ticketKey),
    ]);
  }

  async listAll(): Promise<Array<{ ticketKey: string; runId: string }>> {
    const all = await this.redis.hgetall<Record<string, string>>(HASH_KEY);
    if (!all) return [];
    return Object.entries(all).map(([ticketKey, runId]) => ({ ticketKey, runId }));
  }

  async registerSandbox(ticketKey: string, sandboxId: string): Promise<void> {
    await this.redis.hset(SANDBOX_HASH_KEY, { [ticketKey]: sandboxId });
    await this.redis.persist(SANDBOX_HASH_KEY);
  }

  async getSandboxId(ticketKey: string): Promise<string | null> {
    return this.redis.hget<string>(SANDBOX_HASH_KEY, ticketKey);
  }

  async getEntryCreatedAt(ticketKey: string): Promise<number | null> {
    const raw = await this.redis.hget<string | number>(
      ENTRY_TS_HASH_KEY,
      ticketKey,
    );
    if (raw == null) return null;
    const parsed = typeof raw === "number" ? raw : parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async markFailed(ticketKey: string, meta: FailedTicketMeta): Promise<void> {
    await this.redis.hset(FAILED_HASH_KEY, { [ticketKey]: JSON.stringify(meta) });
  }

  async isTicketFailed(ticketKey: string): Promise<boolean> {
    const value = await this.redis.hget(FAILED_HASH_KEY, ticketKey);
    return value != null;
  }

  async listAllFailed(): Promise<Array<{ ticketKey: string; meta: FailedTicketMeta }>> {
    const all = await this.redis.hgetall<Record<string, string>>(FAILED_HASH_KEY);
    if (!all) return [];
    return Object.entries(all).map(([ticketKey, raw]) => ({
      ticketKey,
      meta: (typeof raw === "string" ? JSON.parse(raw) : raw) as FailedTicketMeta,
    }));
  }

  async clearFailedMark(ticketKey: string): Promise<void> {
    await this.redis.hdel(FAILED_HASH_KEY, ticketKey);
  }

  async getParent(ticketKey: string): Promise<string | null> {
    // Slack ts values like "1777542341.966359" look numeric, and the Upstash
    // client auto-JSON-parses string-encoded numbers back into JS numbers.
    // Coerce to string so the Slack SDK (which calls .startsWith on it) works.
    const raw = await this.redis.hget<string | number>(THREAD_HASH_KEY, ticketKey);
    if (raw == null) return null;
    return String(raw);
  }

  async setParent(ticketKey: string, messageId: string): Promise<void> {
    await this.redis.hset(THREAD_HASH_KEY, { [ticketKey]: messageId });
    // Defend against any external TTL — the thread mapping must outlive runs.
    await this.redis.persist(THREAD_HASH_KEY);
  }

  async clearParent(ticketKey: string): Promise<void> {
    await this.redis.hdel(THREAD_HASH_KEY, ticketKey);
  }
}
