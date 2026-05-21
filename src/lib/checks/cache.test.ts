import { describe, it, expect } from "vitest";
import {
  serializeCacheManifest,
  parseCacheManifest,
  isCacheEntryValid,
  type CacheIdentity,
} from "./cache.js";
import type { CheckCacheManifest } from "./types.js";

function makeManifest(overrides?: Partial<CheckCacheManifest>): CheckCacheManifest {
  return {
    cache_version: 1,
    check_id: "complexity",
    config_hash: "abc123",
    files: {
      "src/foo.ts": {
        content_hash: "deadbeef",
        status: "completed",
        finding_count: 2,
      },
    },
    ...overrides,
  };
}

describe("serializeCacheManifest / parseCacheManifest round-trip", () => {
  it("round-trips a manifest with no surrounding text", () => {
    const manifest = makeManifest();
    const text = serializeCacheManifest(manifest);
    expect(parseCacheManifest(text)).toEqual(manifest);
  });

  it("round-trips when embedded in surrounding text", () => {
    const manifest = makeManifest();
    const text = `Some header text\n${serializeCacheManifest(manifest)}\nSome footer text`;
    expect(parseCacheManifest(text)).toEqual(manifest);
  });

  it("round-trips manifest with optional previous_check_run_id", () => {
    const manifest = makeManifest({
      files: {
        "src/bar.ts": {
          content_hash: "cafebabe",
          status: "skipped",
          finding_count: 0,
          previous_check_run_id: 42,
        },
      },
    });
    const text = serializeCacheManifest(manifest);
    expect(parseCacheManifest(text)).toEqual(manifest);
  });
});

describe("parseCacheManifest — null inputs", () => {
  it("returns null for null", () => {
    expect(parseCacheManifest(null)).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(parseCacheManifest("")).toBe(null);
  });

  it("returns null for undefined", () => {
    expect(parseCacheManifest(undefined)).toBe(null);
  });
});

describe("parseCacheManifest — no marker", () => {
  it("returns null when no marker present", () => {
    expect(parseCacheManifest("Just some regular text without any markers")).toBe(null);
  });

  it("returns null when open marker present but no close marker", () => {
    expect(parseCacheManifest("<!-- ai-workflow-cache\n{}\n")).toBe(null);
  });
});

describe("parseCacheManifest — malformed JSON", () => {
  it("returns null when JSON is malformed", () => {
    const text = "<!-- ai-workflow-cache\nnot-valid-json\n-->";
    expect(parseCacheManifest(text)).toBe(null);
  });

  it("returns null when body is empty braces but missing required fields", () => {
    const text = "<!-- ai-workflow-cache\n{}\n-->";
    expect(parseCacheManifest(text)).toBe(null);
  });
});

describe("parseCacheManifest — cache_version validation", () => {
  it("returns null when cache_version is not 1", () => {
    const manifest = { ...makeManifest(), cache_version: 2 };
    const text = `<!-- ai-workflow-cache\n${JSON.stringify(manifest)}\n-->`;
    expect(parseCacheManifest(text)).toBe(null);
  });

  it("returns null when cache_version is missing", () => {
    const { cache_version: _, ...rest } = makeManifest();
    const text = `<!-- ai-workflow-cache\n${JSON.stringify(rest)}\n-->`;
    expect(parseCacheManifest(text)).toBe(null);
  });
});

describe("parseCacheManifest — entry shape validation", () => {
  it("returns null when finding_count is a string instead of number", () => {
    const manifest = {
      cache_version: 1,
      check_id: "complexity",
      config_hash: "abc123",
      files: {
        "src/foo.ts": {
          content_hash: "deadbeef",
          status: "completed",
          finding_count: "two", // wrong type
        },
      },
    };
    const text = `<!-- ai-workflow-cache\n${JSON.stringify(manifest)}\n-->`;
    expect(parseCacheManifest(text)).toBe(null);
  });

  it("returns null when status is an invalid value", () => {
    const manifest = {
      cache_version: 1,
      check_id: "complexity",
      config_hash: "abc123",
      files: {
        "src/foo.ts": {
          content_hash: "deadbeef",
          status: "pending", // not allowed
          finding_count: 0,
        },
      },
    };
    const text = `<!-- ai-workflow-cache\n${JSON.stringify(manifest)}\n-->`;
    expect(parseCacheManifest(text)).toBe(null);
  });

  it("returns null when content_hash is missing", () => {
    const manifest = {
      cache_version: 1,
      check_id: "complexity",
      config_hash: "abc123",
      files: {
        "src/foo.ts": {
          status: "completed",
          finding_count: 0,
        },
      },
    };
    const text = `<!-- ai-workflow-cache\n${JSON.stringify(manifest)}\n-->`;
    expect(parseCacheManifest(text)).toBe(null);
  });

  it("returns null when previous_check_run_id is a string instead of number", () => {
    const manifest = {
      cache_version: 1,
      check_id: "complexity",
      config_hash: "abc123",
      files: {
        "src/foo.ts": {
          content_hash: "deadbeef",
          status: "completed",
          finding_count: 0,
          previous_check_run_id: "not-a-number",
        },
      },
    };
    const text = `<!-- ai-workflow-cache\n${JSON.stringify(manifest)}\n-->`;
    expect(parseCacheManifest(text)).toBe(null);
  });
});

describe("parseCacheManifest — size cap", () => {
  it("returns null when body exceeds MAX_MANIFEST_BYTES", () => {
    // Generate a string well over 32KB
    const bigString = "x".repeat(33_000);
    const manifest = {
      cache_version: 1,
      check_id: "complexity",
      config_hash: bigString,
      files: {},
    };
    const text = `<!-- ai-workflow-cache\n${JSON.stringify(manifest)}\n-->`;
    expect(parseCacheManifest(text)).toBe(null);
  });
});

describe("isCacheEntryValid", () => {
  const manifest = makeManifest();
  const identity: CacheIdentity = {
    config_hash: "abc123",
    check_id: "complexity",
    content_hash: "deadbeef",
  };

  it("returns true when all fields match and status is completed", () => {
    expect(isCacheEntryValid(manifest, "src/foo.ts", identity)).toBe(true);
  });

  it("returns false when config_hash differs", () => {
    expect(isCacheEntryValid(manifest, "src/foo.ts", { ...identity, config_hash: "different" })).toBe(false);
  });

  it("returns false when check_id differs", () => {
    expect(isCacheEntryValid(manifest, "src/foo.ts", { ...identity, check_id: "other-check" })).toBe(false);
  });

  it("returns false when content_hash differs", () => {
    expect(isCacheEntryValid(manifest, "src/foo.ts", { ...identity, content_hash: "different" })).toBe(false);
  });

  it("returns false when file is missing from files", () => {
    expect(isCacheEntryValid(manifest, "src/missing.ts", identity)).toBe(false);
  });

  it("returns false when entry status is skipped", () => {
    const m = makeManifest({
      files: {
        "src/foo.ts": { content_hash: "deadbeef", status: "skipped", finding_count: 0 },
      },
    });
    expect(isCacheEntryValid(m, "src/foo.ts", identity)).toBe(false);
  });

  it("returns false when entry status is failed", () => {
    const m = makeManifest({
      files: {
        "src/foo.ts": { content_hash: "deadbeef", status: "failed", finding_count: 0 },
      },
    });
    expect(isCacheEntryValid(m, "src/foo.ts", identity)).toBe(false);
  });
});
