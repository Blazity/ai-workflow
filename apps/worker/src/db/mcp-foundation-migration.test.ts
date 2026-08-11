import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpAuditEvents,
  mcpIdempotencyKeys,
  mcpRateLimitWindows,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "./schema.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const openClients: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function migrateRepositoryTwice(): Promise<PGlite> {
  const client = new PGlite();
  openClients.push(client);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: migrationsDir });
  await migrate(db, { migrationsFolder: migrationsDir });
  return client;
}

function indexShape(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).indexes.map((tableIndex) => ({
    name: tableIndex.config.name,
    columns: tableIndex.config.columns.map((column) => {
      if (!("name" in column) || typeof column.name !== "string") {
        throw new Error("Expected an indexed table column");
      }
      return column.name;
    }),
    unique: tableIndex.config.unique,
  }));
}

describe("MCP foundation Drizzle schema", () => {
  it("exports the OAuth and tenant-scoped MCP tables", () => {
    expect(getTableName(oauthClient)).toBe("oauth_client");
    expect(getTableName(oauthRefreshToken)).toBe("oauth_refresh_token");
    expect(getTableName(oauthAccessToken)).toBe("oauth_access_token");
    expect(getTableName(oauthConsent)).toBe("oauth_consent");
    expect(getTableName(mcpIdempotencyKeys)).toBe("mcp_idempotency_keys");
    expect(getTableName(mcpAuditEvents)).toBe("mcp_audit_events");
    expect(getTableName(mcpRateLimitWindows)).toBe("mcp_rate_limit_windows");
  });

  it("scopes idempotency and rate limits to the full actor/client/tool namespace", () => {
    expect(indexShape(mcpIdempotencyKeys)).toEqual(
      expect.arrayContaining([
        {
          name: "mcp_idempotency_keys_namespace_unique",
          columns: [
            "organization_id",
            "actor_subject",
            "client_id",
            "tool_name",
            "idempotency_key",
          ],
          unique: true,
        },
        {
          name: "mcp_idempotency_keys_expires_at_idx",
          columns: ["expires_at"],
          unique: false,
        },
      ]),
    );

    const rateLimitConfig = getTableConfig(mcpRateLimitWindows);
    expect(
      rateLimitConfig.primaryKeys.map((key) => key.columns.map((column) => column.name)),
    ).toContainEqual([
      "organization_id",
      "actor_subject",
      "client_id",
      "tool_name",
      "window_started_at",
    ]);
    expect(indexShape(mcpRateLimitWindows)).toContainEqual({
      name: "mcp_rate_limit_windows_expires_at_idx",
      columns: ["expires_at"],
      unique: false,
    });
  });

  it("references organizations and provides the required audit lookup indexes", () => {
    for (const table of [mcpIdempotencyKeys, mcpAuditEvents, mcpRateLimitWindows]) {
      const organizationReference = getTableConfig(table).foreignKeys.find(
        (foreignKey) => foreignKey.reference().columns[0]?.name === "organization_id",
      );
      expect(organizationReference).toBeDefined();
      expect(getTableName(organizationReference!.reference().foreignTable)).toBe(
        "organization",
      );
    }

    expect(indexShape(mcpAuditEvents)).toEqual(
      expect.arrayContaining([
        {
          name: "mcp_audit_events_organization_occurred_at_idx",
          columns: ["organization_id", "occurred_at"],
          unique: false,
        },
        {
          name: "mcp_audit_events_request_id_idx",
          columns: ["request_id"],
          unique: false,
        },
      ]),
    );
  });

  it("indexes OAuth and MCP expiration columns for cleanup", () => {
    expect(indexShape(oauthRefreshToken)).toContainEqual({
      name: "oauth_refresh_token_expires_at_idx",
      columns: ["expires_at"],
      unique: false,
    });
    expect(indexShape(oauthAccessToken)).toContainEqual({
      name: "oauth_access_token_expires_at_idx",
      columns: ["expires_at"],
      unique: false,
    });
  });
});

describe("0044 MCP foundation migration", () => {
  it("is harmless when the repository migration harness runs twice", async () => {
    const client = await migrateRepositoryTwice();
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'oauth_client',
          'oauth_refresh_token',
          'oauth_access_token',
          'oauth_consent',
          'mcp_idempotency_keys',
          'mcp_audit_events',
          'mcp_rate_limit_windows'
        )
      ORDER BY table_name
    `);

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "mcp_audit_events",
      "mcp_idempotency_keys",
      "mcp_rate_limit_windows",
      "oauth_access_token",
      "oauth_client",
      "oauth_consent",
      "oauth_refresh_token",
    ]);
  });

  it("allows the same idempotency key across tenants and rejects a duplicate namespace", async () => {
    const client = await migrateRepositoryTwice();
    await client.exec(`
      INSERT INTO organization (id, name, slug)
      VALUES
        ('org-a', 'Organization A', 'organization-a'),
        ('org-b', 'Organization B', 'organization-b');

      INSERT INTO mcp_idempotency_keys (
        organization_id,
        actor_subject,
        client_id,
        tool_name,
        idempotency_key,
        payload_hash,
        state,
        expires_at
      ) VALUES
        ('org-a', 'actor-1', 'client-1', 'workflow.start', 'same-key', 'hash-a', 'started', now()),
        ('org-b', 'actor-1', 'client-1', 'workflow.start', 'same-key', 'hash-b', 'started', now());
    `);

    await expect(
      client.exec(`
        INSERT INTO mcp_idempotency_keys (
          organization_id,
          actor_subject,
          client_id,
          tool_name,
          idempotency_key,
          payload_hash,
          state,
          expires_at
        ) VALUES (
          'org-a', 'actor-1', 'client-1', 'workflow.start', 'same-key', 'hash-c', 'started', now()
        );
      `),
    ).rejects.toThrow();
  });

  it("rejects idempotency states outside started, completed and failed", async () => {
    const client = await migrateRepositoryTwice();
    await client.exec(`
      INSERT INTO organization (id, name, slug)
      VALUES ('org-state', 'Organization State', 'organization-state');
    `);

    await expect(
      client.exec(`
        INSERT INTO mcp_idempotency_keys (
          organization_id,
          actor_subject,
          client_id,
          tool_name,
          idempotency_key,
          payload_hash,
          state,
          expires_at
        ) VALUES (
          'org-state', 'actor-1', 'client-1', 'workflow.start', 'bad-state', 'hash', 'pending', now()
        );
      `),
    ).rejects.toThrow();
  });
});
