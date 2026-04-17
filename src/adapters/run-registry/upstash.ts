import { Redis } from "@upstash/redis";
import type { RunRegistryAdapter, FailedTicketMeta } from "./types.js";

const ENV_PREFIX = process.env.VERCEL_ENV ?? "development";
const HASH_KEY = `blazebot:active-runs:${ENV_PREFIX}`;
const FAILED_HASH_KEY = `blazebot:failed-tickets:${ENV_PREFIX}`;
const SANDBOX_HASH_KEY = `blazebot:sandboxes:${ENV_PREFIX}`;

export class UpstashRunRegistry implements RunRegistryAdapter {
  private redis: Redis;

  constructor(opts: { url: string; token: string }) {
    this.redis = new Redis({ url: opts.url, token: opts.token });
  }

  async claim(ticketKey: string, runId: string): Promise<boolean> {
    const result = await this.redis.hsetnx(HASH_KEY, ticketKey, runId);
    return result === 1;
  }

  async register(ticketKey: string, runId: string): Promise<void> {
    await this.redis.hset(HASH_KEY, { [ticketKey]: runId });
    // Ensure the hash has no expiry — defend against external TTL being set
    await this.redis.persist(HASH_KEY);
  }

  async getRunId(ticketKey: string): Promise<string | null> {
    return this.redis.hget<string>(HASH_KEY, ticketKey);
  }

  async unregister(ticketKey: string): Promise<void> {
    // Clear both hashes in one round-trip. The sandbox link is useless
    // without the run entry, and callers expect unregister() to fully
    // detach the ticket.
    await Promise.all([
      this.redis.hdel(HASH_KEY, ticketKey),
      this.redis.hdel(SANDBOX_HASH_KEY, ticketKey),
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
}
