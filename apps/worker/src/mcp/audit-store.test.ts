import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { mcpAuditEvents, organization } from "../db/schema.js";
import type { McpActorContext, McpAuditInput } from "./contracts.js";
import {
  listMcpAuditsForOrganization,
  pruneMcpAudits,
  writeMcpAudit,
} from "./audit-store.js";

let db: Db;

const occurredAt = new Date("2026-08-11T12:00:00.000Z");

function actor(organizationId: string): McpActorContext {
  return {
    kind: "user",
    subject: "user:audit",
    userId: "user-audit",
    clientId: "client-audit",
    organizationId,
    organizationSlug: organizationId,
    role: "admin",
    scopes: new Set(["mcp:read", "runs:dispatch"]),
    audience: "https://worker.example.com/mcp",
  };
}

function event(
  organizationId: string,
  outcome: McpAuditInput["outcome"],
  at = occurredAt,
): McpAuditInput {
  return {
    requestId: `request-${organizationId}-${outcome}-${at.getTime()}`,
    traceId: `trace-${organizationId}`,
    actor: actor(organizationId),
    toolName: "workflows.dispatch",
    mutationClass: "direct",
    targetRefs: ["workflow:17"],
    inputHash: "input-sha256-only",
    outputHash: outcome === "success" ? "output-sha256-only" : null,
    idempotencyKeyHash: "key-sha256-only",
    outcome,
    errorCode:
      outcome === "rejected"
        ? "FORBIDDEN"
        : outcome === "failed"
          ? "DEPENDENCY_UNAVAILABLE"
          : null,
    latencyMs: outcome === "attempted" ? 0 : 12,
    occurredAt: at,
  };
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values([
    { id: "org-audit-a", name: "Audit A", slug: "audit-a" },
    { id: "org-audit-b", name: "Audit B", slug: "audit-b" },
  ]);
});

describe("MCP audit store", () => {
  it("persists every terminal class as metadata and returns only one tenant", async () => {
    for (const outcome of ["attempted", "success", "rejected", "failed"] as const) {
      await writeMcpAudit(db, event("org-audit-a", outcome));
    }
    await writeMcpAudit(db, event("org-audit-b", "success"));

    const rows = await listMcpAuditsForOrganization(db, "org-audit-a", {
      since: new Date("2026-08-11T00:00:00.000Z"),
    });

    expect(rows.map((row) => row.outcome).sort()).toEqual([
      "attempted",
      "failed",
      "rejected",
      "success",
    ]);
    expect(rows.every((row) => row.organizationId === "org-audit-a")).toBe(true);
    expect(rows.every((row) => row.serverVersion === "0.1.0")).toBe(true);
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.contractHash))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("raw-fixture-payload-4f81");
    expect(Object.keys(rows[0] ?? {}).sort()).not.toContain("data");
  });

  it("prunes strictly before the exact 365-day boundary", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const boundary = new Date("2025-08-11T12:00:00.000Z");
    const beforeBoundary = new Date(boundary.getTime() - 1);
    await writeMcpAudit(db, event("org-audit-a", "success", beforeBoundary));
    await writeMcpAudit(db, event("org-audit-a", "success", boundary));
    await writeMcpAudit(db, event("org-audit-b", "success", now));

    await pruneMcpAudits(db, now, 365);

    const retained = await db
      .select()
      .from(mcpAuditEvents)
      .where(eq(mcpAuditEvents.organizationId, "org-audit-a"))
      .orderBy(asc(mcpAuditEvents.occurredAt));
    expect(retained.map((row) => row.occurredAt)).toEqual([boundary]);
  });
});
