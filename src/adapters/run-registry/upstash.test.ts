import { describe, it, expect, vi, beforeEach } from "vitest";
import { UpstashRunRegistry } from "./upstash.js";

const HASH_KEY = "blazebot:active-runs";

const mockRedis = {
  hsetnx: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hdel: vi.fn(),
  hgetall: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
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

  describe("markPendingCancel", () => {
    it("sets a key with TTL", async () => {
      const registry = createRegistry();
      await registry.markPendingCancel("PROJ-1");
      expect(mockRedis.set).toHaveBeenCalledWith(
        "blazebot:pending-cancel:PROJ-1",
        "1",
        { ex: 60 },
      );
    });
  });

  describe("consumePendingCancel", () => {
    it("returns true and deletes when flag exists", async () => {
      mockRedis.del.mockResolvedValueOnce(1);
      const registry = createRegistry();
      const result = await registry.consumePendingCancel("PROJ-1");
      expect(result).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith("blazebot:pending-cancel:PROJ-1");
    });

    it("returns false when flag does not exist", async () => {
      mockRedis.del.mockResolvedValueOnce(0);
      const registry = createRegistry();
      const result = await registry.consumePendingCancel("PROJ-1");
      expect(result).toBe(false);
    });
  });
});
