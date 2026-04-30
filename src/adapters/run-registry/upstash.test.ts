import { describe, it, expect, vi, beforeEach } from "vitest";
import { UpstashRunRegistry } from "./upstash.js";

const HASH_KEY = `blazebot:active-runs:${process.env.VERCEL_ENV ?? "development"}`;
const THREAD_HASH_KEY = `blazebot:thread-parents:${process.env.VERCEL_ENV ?? "development"}`;

const mockRedis = {
  hsetnx: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hdel: vi.fn(),
  hgetall: vi.fn(),
  persist: vi.fn(),
};

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => mockRedis),
}));

function createRegistry() {
  return new UpstashRunRegistry({
    url: "https://fake.upstash.io",
    token: "fake-token",
  });
}

describe("UpstashRunRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default hset to resolve so the adapter's best-effort timestamp
    // writes (to ENTRY_TS_HASH_KEY / SANDBOX_HASH_KEY) don't blow up with
    // "cannot read .catch of undefined" in tests that only cared about
    // the primary HASH_KEY call.
    mockRedis.hset.mockResolvedValue(1);
    mockRedis.hdel.mockResolvedValue(1);
    mockRedis.persist.mockResolvedValue(1);
  });

  describe("claim", () => {
    it("returns true when key was not already set", async () => {
      mockRedis.hsetnx.mockResolvedValueOnce(1);
      const registry = createRegistry();
      const result = await registry.claim("PROJ-1", "claiming");
      expect(result).toBe(true);
      expect(mockRedis.hsetnx).toHaveBeenCalledWith(HASH_KEY, "PROJ-1", "claiming");
    });

    it("returns false when key already exists", async () => {
      mockRedis.hsetnx.mockResolvedValueOnce(0);
      const registry = createRegistry();
      const result = await registry.claim("PROJ-1", "claiming");
      expect(result).toBe(false);
    });
  });

  describe("register", () => {
    it("stores ticketKey -> runId in the hash", async () => {
      const registry = createRegistry();
      await registry.register("PROJ-1", "run_abc");
      expect(mockRedis.hset).toHaveBeenCalledWith(HASH_KEY, { "PROJ-1": "run_abc" });
    });
  });

  describe("getRunId", () => {
    it("returns runId when ticket is registered", async () => {
      mockRedis.hget.mockResolvedValueOnce("run_abc");
      const registry = createRegistry();
      const result = await registry.getRunId("PROJ-1");
      expect(result).toBe("run_abc");
      expect(mockRedis.hget).toHaveBeenCalledWith(HASH_KEY, "PROJ-1");
    });

    it("returns null when ticket is not registered", async () => {
      mockRedis.hget.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.getRunId("PROJ-99");
      expect(result).toBeNull();
    });
  });

  describe("unregister", () => {
    it("removes the ticketKey from the hash", async () => {
      const registry = createRegistry();
      await registry.unregister("PROJ-1");
      expect(mockRedis.hdel).toHaveBeenCalledWith(HASH_KEY, "PROJ-1");
    });
  });

  describe("listAll", () => {
    it("returns all registered ticket -> runId pairs", async () => {
      mockRedis.hgetall.mockResolvedValueOnce({
        "PROJ-1": "run_abc",
        "PROJ-2": "run_def",
      });
      const registry = createRegistry();
      const result = await registry.listAll();
      expect(result).toEqual([
        { ticketKey: "PROJ-1", runId: "run_abc" },
        { ticketKey: "PROJ-2", runId: "run_def" },
      ]);
    });

    it("returns empty array when no runs are registered", async () => {
      mockRedis.hgetall.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.listAll();
      expect(result).toEqual([]);
    });
  });

  const FAILED_HASH_KEY = `blazebot:failed-tickets:${process.env.VERCEL_ENV ?? "development"}`;

  describe("markFailed", () => {
    it("stores failure metadata in the failed-tickets hash", async () => {
      const registry = createRegistry();
      const meta = {
        runId: "run_abc",
        error: "Failed to move ticket to backlog: 403 Forbidden",
        failedAt: "2026-04-02T12:34:56.000Z",
      };
      await registry.markFailed("AWT-42", meta);
      expect(mockRedis.hset).toHaveBeenCalledWith(FAILED_HASH_KEY, {
        "AWT-42": JSON.stringify(meta),
      });
    });
  });

  describe("isTicketFailed", () => {
    it("returns true when a failure marker exists", async () => {
      mockRedis.hget.mockResolvedValueOnce('{"runId":"run_abc","error":"err","failedAt":"2026-04-02T12:34:56.000Z"}');
      const registry = createRegistry();
      const result = await registry.isTicketFailed("AWT-42");
      expect(result).toBe(true);
      expect(mockRedis.hget).toHaveBeenCalledWith(FAILED_HASH_KEY, "AWT-42");
    });

    it("returns false when no failure marker exists", async () => {
      mockRedis.hget.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.isTicketFailed("AWT-99");
      expect(result).toBe(false);
    });
  });

  describe("listAllFailed", () => {
    it("returns all failed ticket markers", async () => {
      mockRedis.hgetall.mockResolvedValueOnce({
        "AWT-1": '{"runId":"run_a","error":"err1","failedAt":"2026-04-02T10:00:00.000Z"}',
        "AWT-2": '{"runId":"run_b","error":"err2","failedAt":"2026-04-02T11:00:00.000Z"}',
      });
      const registry = createRegistry();
      const result = await registry.listAllFailed();
      expect(result).toEqual([
        { ticketKey: "AWT-1", meta: { runId: "run_a", error: "err1", failedAt: "2026-04-02T10:00:00.000Z" } },
        { ticketKey: "AWT-2", meta: { runId: "run_b", error: "err2", failedAt: "2026-04-02T11:00:00.000Z" } },
      ]);
      expect(mockRedis.hgetall).toHaveBeenCalledWith(FAILED_HASH_KEY);
    });

    it("returns empty array when no failed tickets", async () => {
      mockRedis.hgetall.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.listAllFailed();
      expect(result).toEqual([]);
    });
  });

  describe("clearFailedMark", () => {
    it("removes the failure marker from the hash", async () => {
      const registry = createRegistry();
      await registry.clearFailedMark("AWT-42");
      expect(mockRedis.hdel).toHaveBeenCalledWith(FAILED_HASH_KEY, "AWT-42");
    });
  });

  describe("ThreadStore methods", () => {
    it("setParent then getParent round-trips the message id", async () => {
      // Phase 1: setParent writes
      const registry = createRegistry();
      await registry.setParent("AWT-42", "1700000000.000123");
      expect(mockRedis.hset).toHaveBeenCalledWith(THREAD_HASH_KEY, {
        "AWT-42": "1700000000.000123",
      });
      expect(mockRedis.persist).toHaveBeenCalledWith(THREAD_HASH_KEY);

      // Phase 2: getParent reads
      mockRedis.hget.mockResolvedValueOnce("1700000000.000123");
      const result = await registry.getParent("AWT-42");
      expect(result).toBe("1700000000.000123");
      expect(mockRedis.hget).toHaveBeenCalledWith(THREAD_HASH_KEY, "AWT-42");
    });

    it("getParent returns null when no entry exists", async () => {
      mockRedis.hget.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.getParent("AWT-99");
      expect(result).toBeNull();
    });

    it("getParent coerces a number-typed result back to a string (Upstash JSON-parses Slack ts)", async () => {
      // Slack ts "1777542341.966359" is a string in our setParent call, but
      // the @upstash/redis client auto-JSON-parses values, turning numeric-
      // looking strings into JS numbers on retrieval. The Slack SDK calls
      // .startsWith on the returned messageId, so a number would crash it.
      mockRedis.hget.mockResolvedValueOnce(1777542341.966359);
      const registry = createRegistry();
      const result = await registry.getParent("AWT-42");
      expect(result).toBe("1777542341.966359");
      expect(typeof result).toBe("string");
    });

    it("clearParent deletes the entry from the thread hash", async () => {
      const registry = createRegistry();
      await registry.clearParent("AWT-42");
      expect(mockRedis.hdel).toHaveBeenCalledWith(THREAD_HASH_KEY, "AWT-42");
    });

    it("unregister does not touch the thread hash", async () => {
      const registry = createRegistry();
      await registry.unregister("AWT-42");
      // unregister deletes from HASH_KEY, SANDBOX_HASH_KEY, ENTRY_TS_HASH_KEY only.
      const hdelCalls = mockRedis.hdel.mock.calls.map((c) => c[0]);
      expect(hdelCalls).not.toContain(THREAD_HASH_KEY);
    });
  });
});
