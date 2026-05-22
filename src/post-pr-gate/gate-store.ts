import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

/**
 * Application-level dedupe, force-push tracking, and per-PR locking for
 * post-pr-gate runs.
 *
 * Three keys per PR:
 *   gate:lock:{repo}#{pr}        — short-TTL mutex around the webhook critical
 *                                  section. Released in `finally`; if the route
 *                                  process dies, the TTL releases it.
 *   gate:dedupe:{repo}#{pr}@{sha} — SET NX with the real `handle.runId`.
 *                                  Absent value means "never claimed for this SHA".
 *   gate:current:{repo}#{pr}     — JSON pointer to the latest run.
 *                                  Used to cancel the previous run on force-push.
 *
 * Lifetime: 14 days. PRs older than that fall back to "fresh" behavior on
 * re-delivery; acceptable for our use case.
 *
 * The `envPrefix` is passed in (not read from `process.env` at module load),
 * so namespacing is explicit and unit-testable. Production callers pass
 * `env.VERCEL_ENV` from the validated env schema.
 */

const TTL_SECONDS = 60 * 60 * 24 * 14;
const LOCK_TTL_SECONDS = 30;

export interface CurrentGateRun {
  runId: string;
  headSha: string;
  checkRunIds: number[];
}

export class GateStore {
  private redis: Redis;
  private envPrefix: string;

  constructor(opts: { url: string; token: string; envPrefix: string }) {
    this.redis = new Redis({ url: opts.url, token: opts.token });
    this.envPrefix = opts.envPrefix;
  }

  private lockKey(repo: string, pr: number): string {
    return `blazebot:gate:lock:${this.envPrefix}:${repo}#${pr}`;
  }

  private currentKey(repo: string, pr: number): string {
    return `blazebot:gate:current:${this.envPrefix}:${repo}#${pr}`;
  }

  private dedupeKey(repo: string, pr: number, headSha: string): string {
    return `blazebot:gate:dedupe:${this.envPrefix}:${repo}#${pr}@${headSha}`;
  }

  /**
   * Acquire the per-PR lock. Returns a token if acquired, null if busy.
   * Caller MUST call `releaseLock` with the same token in a `finally`.
   */
  async acquireLock(repo: string, pr: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.redis.set(this.lockKey(repo, pr), token, {
      nx: true,
      ex: LOCK_TTL_SECONDS,
    });
    return res === "OK" ? token : null;
  }

  /**
   * Release the per-PR lock — only if our token still owns it. A no-op if the
   * lock TTL'd out and another holder took over.
   */
  async releaseLock(repo: string, pr: number, token: string): Promise<void> {
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    await this.redis.eval(script, [this.lockKey(repo, pr)], [token]);
  }

  /**
   * Atomically claim a {repo, pr, headSha} as a unique gate run.
   * Returns the existing runId if already claimed, null if we won the race.
   * Designed to be called *inside* `acquireLock`, but the SET NX is a
   * defense-in-depth in case the lock TTL'd out mid-critical-section.
   */
  async claimRun(
    repo: string,
    pr: number,
    headSha: string,
    runId: string,
  ): Promise<string | null> {
    const res = await this.redis.set(
      this.dedupeKey(repo, pr, headSha),
      runId,
      { nx: true, ex: TTL_SECONDS },
    );
    if (res === "OK") return null;
    return (await this.redis.get<string>(this.dedupeKey(repo, pr, headSha))) ?? null;
  }

  async getDedupe(
    repo: string,
    pr: number,
    headSha: string,
  ): Promise<string | null> {
    return (await this.redis.get<string>(this.dedupeKey(repo, pr, headSha))) ?? null;
  }

  async getCurrent(repo: string, pr: number): Promise<CurrentGateRun | null> {
    return this.redis.get<CurrentGateRun>(this.currentKey(repo, pr));
  }

  async setCurrent(
    repo: string,
    pr: number,
    value: CurrentGateRun,
  ): Promise<void> {
    await this.redis.set(this.currentKey(repo, pr), value, { ex: TTL_SECONDS });
  }

  async appendCheckRunIds(
    repo: string,
    pr: number,
    ids: number[],
  ): Promise<void> {
    const current = await this.getCurrent(repo, pr);
    if (!current) return;
    await this.setCurrent(repo, pr, {
      ...current,
      checkRunIds: [...current.checkRunIds, ...ids],
    });
  }

  async clearCurrent(repo: string, pr: number): Promise<void> {
    await this.redis.del(this.currentKey(repo, pr));
  }
}
