/* oxlint-disable unicorn/no-array-sort */
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

const SQL_TABLES = [
  "account", "active_run_sandboxes", "active_runs", "agent_memory_documents",
  "approval_requests", "carry_schema_resync_audit", "clarification_requests",
  "dispatch_capacity_queue", "env_marker", "failed_tickets", "gate_current",
  "gate_dedupe", "gate_locks", "harness_capability_catalogs",
  "harness_profile_version_skills", "harness_profile_versions", "harness_profiles",
  "harness_skill_artifact_files", "harness_skill_artifacts", "invitation",
  "invite_email_delivery", "jwks", "manual_dispatch_requests", "mcp_audit_events",
  "mcp_idempotency_keys", "mcp_rate_limit_windows", "member", "oauth_access_token",
  "oauth_client", "oauth_consent", "oauth_refresh_token", "organization",
  "pre_pr_check_config_versions", "pr_autofix_attempts", "prompt_library",
  "prompt_library_versions", "repositories", "repository_catalog_state",
  "repository_profile_versions", "schedule_occurrences", "session", "settings",
  "settings_versions", "sso_provider",
  "system_health_observation_counters", "system_health_scans", "thread_parents",
  "trigger_deliveries", "trigger_rate_limits", "trigger_rejection_counters", "user",
  "verification", "webhook_trigger_deliveries", "webhook_trigger_endpoints",
  "webhook_trigger_rate_limits", "webhook_trigger_rejection_counters",
  "workflow_block_attempts", "workflow_definition_triggers",
  "workflow_definition_versions", "workflow_definitions", "workflow_owned_branches",
  "workflow_pr_review_publication_comments", "workflow_pr_review_publications",
  "workflow_run_external_checks", "workflow_run_observations", "workflow_runs",
  "workflow_schedules",
] as const;

describe("schema barrel", () => {
  it("exports the literal 67-table schema exactly once", () => {
    const names = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableName(table as PgTable))
      .sort();
    expect(names).toEqual([...SQL_TABLES].sort());
    expect(new Set(names).size).toBe(67);
  });
});
