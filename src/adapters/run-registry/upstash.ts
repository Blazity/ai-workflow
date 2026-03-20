import { Redis } from "@upstash/redis";
import type { RunRegistryAdapter } from "./types.js";

const HASH_KEY = "blazebot:active-runs";

export class UpstashRunRegistry implements RunRegistryAdapter {
  private redis: Redis;

  constructor(opts: { url: string; token: string }) {
    this.redis = new Redis({ url: opts.url, token: opts.token });
  }

  async register(ticketKey: string, runId: string): Promise<void> {
    await this.redis.hset(HASH_KEY, { [ticketKey]: runId });
  }

  async getRunId(ticketKey: string): Promise<string | null> {
    return this.redis.hget<string>(HASH_KEY, ticketKey);
  }

  async unregister(ticketKey: string): Promise<void> {
    await this.redis.hdel(HASH_KEY, ticketKey);
  }

  async listAll(): Promise<Array<{ ticketKey: string; runId: string }>> {
    const all = await this.redis.hgetall<Record<string, string>>(HASH_KEY);
    if (!all) return [];
    return Object.entries(all).map(([ticketKey, runId]) => ({ ticketKey, runId }));
  }
}
