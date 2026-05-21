import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock env so tests don't need full env vars
vi.mock("../../env.js", () => ({
  env: {
    WORKFLOW_CONFIG_PATH: undefined,
    GITHUB_WEBHOOK_SECRET: undefined,
    VCS_KIND: "github",
  },
}));

// Import after mock is set up
const { loadConfig, WorkflowConfigSchema } = await import("./workflow-config.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_YAML = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers:
    - opened
    - synchronize
    - reopened
    - labeled
  default_ignore:
    - "**/*.lock"
  limits:
    max_changed_files: 25
    max_total_diff_bytes: 80000
    max_file_content_bytes: 30000
    max_check_annotations: 50
    max_review_comments: 10
    max_suggestions: 5
  checks:
    - id: complexity
      kind: complexity
      name: "AI / Complexity"
      enabled: true
      blocking: false
      fail_on: critical
      params:
        files: "**/*.{ts,tsx}"
        max_cyclomatic: 10
`;

const VALID_YAML_ENABLED = VALID_YAML.replace("enabled: false", "enabled: true");

function tmpFile(name: string): string {
  return join(tmpdir(), `workflow-config-test-${process.pid}-${name}.yaml`);
}

async function writeTmp(name: string, content: string): Promise<string> {
  const p = tmpFile(name);
  await writeFile(p, content, "utf8");
  return p;
}

async function cleanTmp(name: string): Promise<void> {
  await rm(tmpFile(name), { force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkflowConfigSchema", () => {
  it("accepts a valid config object", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "all" },
        triggers: ["opened"],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [],
      },
    };
    const result = WorkflowConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("rejects version other than 1", () => {
    const result = WorkflowConfigSchema.safeParse({ version: 2, review: {} });
    expect(result.success).toBe(false);
  });

  it("rejects unknown check kind", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "all" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [
          {
            id: "unknown-check",
            kind: "magic_review",
            name: "Magic",
            enabled: true,
            blocking: false,
            fail_on: "critical",
          },
        ],
      },
    };
    const result = WorkflowConfigSchema.safeParse(parsed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues.map((i) => i.path.join("."));
      expect(kinds.some((p) => p.includes("kind"))).toBe(true);
    }
  });

  it("accepts scope mode=all without label or branch_prefix", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "all" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [],
      },
    };
    expect(WorkflowConfigSchema.safeParse(parsed).success).toBe(true);
  });

  it("accepts scope mode=label with a label value", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "label", label: "ai-review" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [],
      },
    };
    expect(WorkflowConfigSchema.safeParse(parsed).success).toBe(true);
  });

  it("accepts scope mode=branch_prefix with a branch_prefix value", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "branch_prefix", branch_prefix: "blazebot/" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [],
      },
    };
    expect(WorkflowConfigSchema.safeParse(parsed).success).toBe(true);
  });

  it("rejects scope mode=label without a label value", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "label" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [],
      },
    };
    const result = WorkflowConfigSchema.safeParse(parsed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("label"))).toBe(true);
    }
  });

  it("rejects scope mode=branch_prefix without a branch_prefix value", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "branch_prefix" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [],
      },
    };
    const result = WorkflowConfigSchema.safeParse(parsed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("branch_prefix"))).toBe(true);
    }
  });

  it("rejects unknown top-level keys (strict schema)", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "all" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [],
      },
      surprise: "hi",
    };
    expect(WorkflowConfigSchema.safeParse(parsed).success).toBe(false);
  });

  it("rejects invalid fail_on value", () => {
    const parsed = {
      version: 1,
      review: {
        enabled: false,
        scope: { mode: "all" },
        triggers: [],
        default_ignore: [],
        limits: {
          max_changed_files: 10,
          max_total_diff_bytes: 1000,
          max_file_content_bytes: 500,
          max_check_annotations: 20,
          max_review_comments: 5,
          max_suggestions: 3,
        },
        checks: [
          {
            id: "check-one",
            kind: "complexity",
            name: "Check",
            enabled: true,
            blocking: false,
            fail_on: "fatal", // invalid
          },
        ],
      },
    };
    const result = WorkflowConfigSchema.safeParse(parsed);
    expect(result.success).toBe(false);
  });
});

describe("loadConfig — file I/O", () => {
  it("parses a valid YAML file successfully", async () => {
    const p = await writeTmp("valid", VALID_YAML);
    try {
      const { config, configHash } = await loadConfig({ path: p });
      expect(config.version).toBe(1);
      expect(config.review.enabled).toBe(false);
      expect(config.review.checks).toHaveLength(1);
      expect(config.review.checks[0]!.id).toBe("complexity");
      expect(typeof configHash).toBe("string");
      expect(configHash).toHaveLength(64); // sha256 hex = 64 chars
    } finally {
      await cleanTmp("valid");
    }
  });

  it("throws on invalid YAML syntax", async () => {
    const p = await writeTmp("badyaml", "version: 1\n  bad: [unclosed");
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(/Failed to parse YAML/);
    } finally {
      await cleanTmp("badyaml");
    }
  });

  it("throws when the file does not exist", async () => {
    await expect(loadConfig({ path: "/nonexistent/path/workflow.config.yaml" })).rejects.toThrow(
      /Failed to read workflow config/,
    );
  });

  it("throws with file path in error message for invalid config", async () => {
    const badConfig = `
version: 1
review:
  enabled: not-a-boolean
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks: []
`;
    const p = await writeTmp("invalid-field", badConfig);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(
        new RegExp(`\\[${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`),
      );
    } finally {
      await cleanTmp("invalid-field");
    }
  });
});

describe("loadConfig — check semantics", () => {
  it("rejects duplicate check IDs", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: complexity
      kind: complexity
      name: "First"
      enabled: true
      blocking: false
      fail_on: critical
    - id: complexity
      kind: ai_review
      name: "Second"
      enabled: true
      blocking: false
      fail_on: warning
`;
    const p = await writeTmp("dup-id", yaml);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(/Duplicate check id/);
    } finally {
      await cleanTmp("dup-id");
    }
  });

  it("rejects needs referencing an unknown check id", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: complexity
      kind: complexity
      name: "Complexity"
      enabled: true
      blocking: false
      fail_on: critical
      needs:
        - nonexistent-check
`;
    const p = await writeTmp("unknown-needs", yaml);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(
        /not a known check id|defined later/,
      );
    } finally {
      await cleanTmp("unknown-needs");
    }
  });

  it("rejects needs referencing a later (forward) check", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: first-check
      kind: complexity
      name: "First"
      enabled: true
      blocking: false
      fail_on: critical
      needs:
        - second-check
    - id: second-check
      kind: ai_review
      name: "Second"
      enabled: true
      blocking: false
      fail_on: warning
`;
    const p = await writeTmp("forward-needs", yaml);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(/defined later|not a known check id/);
    } finally {
      await cleanTmp("forward-needs");
    }
  });

  it("accepts needs referencing an earlier check", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: complexity
      kind: complexity
      name: "Complexity"
      enabled: true
      blocking: false
      fail_on: critical
    - id: ai-review
      kind: ai_review
      name: "AI Review"
      enabled: true
      blocking: false
      fail_on: warning
      needs:
        - complexity
      params:
        mode: per_file
        model: "claude-sonnet-4-5"
        prompt:
          source: builtin
`;
    const p = await writeTmp("valid-needs", yaml);
    try {
      const { config } = await loadConfig({ path: p });
      expect(config.review.checks[1]!.needs).toEqual(["complexity"]);
    } finally {
      await cleanTmp("valid-needs");
    }
  });
});

describe("loadConfig — configHash", () => {
  it("returns a stable hash across multiple invocations of the same config", async () => {
    const p = await writeTmp("stable-hash", VALID_YAML);
    try {
      const { configHash: h1 } = await loadConfig({ path: p });
      const { configHash: h2 } = await loadConfig({ path: p });
      expect(h1).toBe(h2);
    } finally {
      await cleanTmp("stable-hash");
    }
  });

  it("returns a different hash when config content changes", async () => {
    const p1 = await writeTmp("hash-a", VALID_YAML);
    const p2 = await writeTmp("hash-b", VALID_YAML.replace("enabled: false", "enabled: true"));
    try {
      const { configHash: h1 } = await loadConfig({ path: p1 });
      const { configHash: h2 } = await loadConfig({ path: p2 });
      expect(h1).not.toBe(h2);
    } finally {
      await cleanTmp("hash-a");
      await cleanTmp("hash-b");
    }
  });
});

describe("loadConfig — per-check params validation", () => {
  it("accepts a complexity check with valid params", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: complexity
      kind: complexity
      name: "Complexity"
      enabled: true
      blocking: false
      fail_on: critical
      params:
        files: "**/*.ts"
        max_cyclomatic: 12
        ignore: ["**/*.test.ts"]
`;
    const p = await writeTmp("complexity-valid-params", yaml);
    try {
      const { config } = await loadConfig({ path: p });
      // params are replaced with parsed/typed result (defaults filled in).
      expect(config.review.checks[0]!.params).toMatchObject({
        files: "**/*.ts",
        max_cyclomatic: 12,
        ignore: ["**/*.test.ts"],
      });
    } finally {
      await cleanTmp("complexity-valid-params");
    }
  });

  it("rejects a complexity check with bad params (max_cyclomatic is a string)", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: complexity
      kind: complexity
      name: "Complexity"
      enabled: true
      blocking: false
      fail_on: critical
      params:
        max_cyclomatic: "not-a-number"
`;
    const p = await writeTmp("complexity-bad-params", yaml);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(
        /Invalid params for check "complexity".*max_cyclomatic/s,
      );
    } finally {
      await cleanTmp("complexity-bad-params");
    }
  });

  it("accepts an ai_review check with valid params", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: ai-review
      kind: ai_review
      name: "AI Review"
      enabled: true
      blocking: false
      fail_on: warning
      params:
        mode: per_file
        model: "claude-sonnet-4-5"
        prompt:
          source: builtin
          name: default
        data:
          - file_diff
          - changed_files
`;
    const p = await writeTmp("aireview-valid-params", yaml);
    try {
      const { config } = await loadConfig({ path: p });
      expect(config.review.checks[0]!.params).toMatchObject({
        mode: "per_file",
        model: "claude-sonnet-4-5",
        prompt: { source: "builtin", name: "default" },
      });
    } finally {
      await cleanTmp("aireview-valid-params");
    }
  });

  it("rejects an ai_review check with invalid mode", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: ai-review
      kind: ai_review
      name: "AI Review"
      enabled: true
      blocking: false
      fail_on: warning
      params:
        mode: not_a_valid_mode
        model: "claude-sonnet-4-5"
        prompt:
          source: builtin
`;
    const p = await writeTmp("aireview-bad-mode", yaml);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(
        /Invalid params for check "ai-review".*mode/s,
      );
    } finally {
      await cleanTmp("aireview-bad-mode");
    }
  });

  it("rejects an ai_review check missing the prompt source", async () => {
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: ai-review
      kind: ai_review
      name: "AI Review"
      enabled: true
      blocking: false
      fail_on: warning
      params:
        mode: per_file
        model: "claude-sonnet-4-5"
        prompt: {}
`;
    const p = await writeTmp("aireview-no-prompt-source", yaml);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow(
        /Invalid params for check "ai-review".*prompt/s,
      );
    } finally {
      await cleanTmp("aireview-no-prompt-source");
    }
  });
});

describe("loadConfig — cycle detection", () => {
  it("rejects a direct cycle A -> B -> A", async () => {
    // Order-linear rule already rejects this (B's needs=[A] passes, A's needs=[B] is forward-ref).
    // The DFS detector should also flag it cleanly if the order rule is ever relaxed.
    const yaml = `
version: 1
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks:
    - id: a
      kind: complexity
      name: "A"
      enabled: true
      blocking: false
      fail_on: critical
      needs:
        - b
    - id: b
      kind: complexity
      name: "B"
      enabled: true
      blocking: false
      fail_on: critical
      needs:
        - a
`;
    const p = await writeTmp("cycle-direct", yaml);
    try {
      // The current order-linear rule fires first (b is not yet a known id when
      // a is processed). Either rejection reason is acceptable — the contract
      // is "cycles must be rejected at config-load."
      await expect(loadConfig({ path: p })).rejects.toThrow(
        /defined later|Cycle detected|not a known check id/,
      );
    } finally {
      await cleanTmp("cycle-direct");
    }
  });

});

describe("loadConfig — requireWebhookSecret", () => {
  let originalEnv: Record<string, unknown>;

  beforeEach(async () => {
    // Capture env mock state
    const envModule = await import("../../env.js");
    originalEnv = { ...envModule.env };
  });

  afterEach(async () => {
    // Restore env mock
    const envModule = await import("../../env.js");
    Object.assign(envModule.env, originalEnv);
  });

  it("throws when VCS_KIND=github, requireWebhookSecret=true, review.enabled=true, and GITHUB_WEBHOOK_SECRET is unset", async () => {
    const p = await writeTmp("ws-enabled", VALID_YAML_ENABLED);
    try {
      // env mock has VCS_KIND=github, GITHUB_WEBHOOK_SECRET: undefined
      await expect(
        loadConfig({ path: p, requireWebhookSecret: true }),
      ).rejects.toThrow(/GITHUB_WEBHOOK_SECRET/);
    } finally {
      await cleanTmp("ws-enabled");
    }
  });

  it("does not throw when requireWebhookSecret=true but review.enabled=false", async () => {
    const p = await writeTmp("ws-disabled", VALID_YAML);
    try {
      // review.enabled is false — secret not required even with requireWebhookSecret=true
      await expect(loadConfig({ path: p, requireWebhookSecret: true })).resolves.toBeDefined();
    } finally {
      await cleanTmp("ws-disabled");
    }
  });

  it("does not throw when requireWebhookSecret=true, review.enabled=true, and secret is set", async () => {
    const p = await writeTmp("ws-set", VALID_YAML_ENABLED);
    try {
      // Temporarily set the webhook secret in the mocked env
      const envModule = await import("../../env.js");
      (envModule.env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = "my-secret";
      await expect(loadConfig({ path: p, requireWebhookSecret: true })).resolves.toBeDefined();
    } finally {
      await cleanTmp("ws-set");
    }
  });

  it("does not require GITHUB_WEBHOOK_SECRET when VCS_KIND=gitlab", async () => {
    const p = await writeTmp("ws-gitlab", VALID_YAML_ENABLED);
    try {
      const envModule = await import("../../env.js");
      (envModule.env as Record<string, unknown>).VCS_KIND = "gitlab";
      (envModule.env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = undefined;
      // GitLab has no webhook entry yet; loader should not throw.
      await expect(
        loadConfig({ path: p, requireWebhookSecret: true }),
      ).resolves.toBeDefined();
    } finally {
      await cleanTmp("ws-gitlab");
    }
  });
});

describe("loadConfig — YAML schema hardening", () => {
  it("rejects YAML that uses non-JSON tags (e.g. !!timestamp)", async () => {
    // !!timestamp is a YAML-1.1 scalar tag — accepted under DEFAULT_SCHEMA,
    // rejected under JSON_SCHEMA. Encoding it as the `version` field forces
    // js-yaml to attempt the tag during parse; under JSON_SCHEMA it errors out
    // (or the resulting value fails Zod's z.literal(1)). Either rejection
    // path is acceptable — the contract is "YAML-only types are not parsed."
    const yaml = `
version: !!timestamp '2020-01-01'
review:
  enabled: false
  scope:
    mode: all
  triggers: []
  default_ignore: []
  limits:
    max_changed_files: 10
    max_total_diff_bytes: 1000
    max_file_content_bytes: 500
    max_check_annotations: 20
    max_review_comments: 5
    max_suggestions: 3
  checks: []
`;
    const p = await writeTmp("yaml-custom-tag", yaml);
    try {
      await expect(loadConfig({ path: p })).rejects.toThrow();
    } finally {
      await cleanTmp("yaml-custom-tag");
    }
  });
});
