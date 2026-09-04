import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import type { Db } from "../../src/db/client.js";
import { activeRuns } from "../../src/db/schema.js";
import * as schema from "../../src/db/schema.js";
import { e2eEnv } from "../env.js";

const CAMPAIGN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CapacityCampaign {
  readonly id: string;
  readonly ownerToken: string;
  readonly subjectKeys: readonly string[];
}

export class CapacityFixtureBaselineError extends Error {
  constructor(count: number) {
    super(
      `Capacity fixture baseline contains ${count} active run${count === 1 ? "" : "s"}; refusing to mutate it`,
    );
    this.name = "CapacityFixtureBaselineError";
  }
}

export class CapacityFixtureOwnershipError extends Error {
  constructor(operation: "refresh" | "cleanup", subjectKeys: readonly string[]) {
    super(
      `Capacity fixture ${operation} refused: owner/state drift for ${subjectKeys.join(", ")}`,
    );
    this.name = "CapacityFixtureOwnershipError";
  }
}

/**
 * A campaign identity is generated inside the test process, never accepted as
 * workflow_dispatch input. That keeps ownership both unique and unavailable
 * for an operator to accidentally reuse.
 */
export function createCapacityCampaign(
  slots: number,
  generateId: () => string = randomUUID,
): CapacityCampaign {
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new Error("Capacity fixture slot count must be a positive integer");
  }
  const id = generateId();
  if (!CAMPAIGN_ID.test(id)) {
    throw new Error("Capacity fixture campaign id must be a UUID");
  }
  const ownerToken = `e2e:capacity:${id}`;
  return Object.freeze({
    id,
    ownerToken,
    subjectKeys: Object.freeze(
      Array.from({ length: slots }, (_, slot) => `${ownerToken}:slot:${slot}`),
    ),
  });
}

type SeedRow = {
  baseline_count: number | string;
  inserted_count: number | string;
};
type GuardedMutationRow = {
  exact_count?: number | string;
  changed_count?: number | string;
  drift_count?: number | string;
  drift_subjects?: unknown;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function integer(value: number | string | undefined): number {
  return Number(value ?? 0);
}

function driftSubjects(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  }
  return [];
}

/** Schema-correct, exact-owner fixture operations for the isolated US-11 run. */
export class CapacityRegistry {
  constructor(private readonly db: Db) {}

  /**
   * The baseline read and multi-row insert share one database statement. A
   * pre-existing row makes the insert a no-op and is reported without ever
   * enumerating or deleting the foreign owner.
   */
  async seed(campaign: CapacityCampaign): Promise<number> {
    const result = await this.db.execute(sql`
      WITH baseline AS MATERIALIZED (
        SELECT count(*)::integer AS count
        FROM active_runs
      ), expected(subject_key) AS MATERIALIZED (
        SELECT value
        FROM jsonb_array_elements_text(${JSON.stringify(campaign.subjectKeys)}::jsonb)
      ), inserted AS (
        INSERT INTO active_runs (
          subject_key,
          ticket_key,
          owner_token,
          run_id,
          state,
          run_kind,
          created_at,
          updated_at
        )
        SELECT
          expected.subject_key,
          NULL,
          ${campaign.ownerToken},
          NULL,
          'reserved',
          'schedule',
          now(),
          now()
        FROM expected, baseline
        WHERE baseline.count = 0
        RETURNING subject_key
      )
      SELECT
        baseline.count AS baseline_count,
        (SELECT count(*)::integer FROM inserted) AS inserted_count
      FROM baseline
    `);
    const row = rowsOf<SeedRow>(result)[0];
    const baselineCount = integer(row?.baseline_count);
    if (baselineCount !== 0) throw new CapacityFixtureBaselineError(baselineCount);
    const insertedCount = integer(row?.inserted_count);
    if (insertedCount !== campaign.subjectKeys.length) {
      throw new Error(
        `Capacity fixture seed inserted ${insertedCount}/${campaign.subjectKeys.length} reservations`,
      );
    }
    return insertedCount;
  }

  /** Refresh only a complete set of still-unbound reservations. */
  async refresh(campaign: CapacityCampaign): Promise<number> {
    const result = await this.db.execute(sql`
      WITH expected(subject_key) AS MATERIALIZED (
        SELECT value
        FROM jsonb_array_elements_text(${JSON.stringify(campaign.subjectKeys)}::jsonb)
      ), exact AS MATERIALIZED (
        SELECT active.subject_key
        FROM active_runs AS active
        JOIN expected USING (subject_key)
        WHERE active.owner_token = ${campaign.ownerToken}
          AND active.state = 'reserved'
          AND active.run_id IS NULL
        FOR UPDATE OF active
      ), refreshed AS (
        UPDATE active_runs AS active
        SET updated_at = now()
        FROM exact
        WHERE (SELECT count(*) FROM exact) = ${campaign.subjectKeys.length}
          AND active.subject_key = exact.subject_key
          AND active.owner_token = ${campaign.ownerToken}
          AND active.state = 'reserved'
          AND active.run_id IS NULL
        RETURNING active.subject_key
      )
      SELECT
        (SELECT count(*)::integer FROM exact) AS exact_count,
        (SELECT count(*)::integer FROM refreshed) AS changed_count
    `);
    const row = rowsOf<GuardedMutationRow>(result)[0];
    const exactCount = integer(row?.exact_count);
    const refreshedCount = integer(row?.changed_count);
    if (
      exactCount !== campaign.subjectKeys.length ||
      refreshedCount !== campaign.subjectKeys.length
    ) {
      throw new CapacityFixtureOwnershipError("refresh", campaign.subjectKeys);
    }
    return refreshedCount;
  }

  /**
   * Compare every extant campaign subject before deleting anything. Missing
   * rows are an idempotent success; any foreign owner, bound run, or changed
   * state blocks the whole delete and leaves all campaign subjects untouched.
   */
  async cleanup(campaign: CapacityCampaign): Promise<number> {
    const result = await this.db.execute(sql`
      WITH expected(subject_key) AS MATERIALIZED (
        SELECT value
        FROM jsonb_array_elements_text(${JSON.stringify(campaign.subjectKeys)}::jsonb)
      ), observed AS MATERIALIZED (
        SELECT
          active.subject_key,
          active.owner_token,
          active.state,
          active.run_id,
          (
            active.owner_token = ${campaign.ownerToken}
            AND active.state = 'reserved'
            AND active.run_id IS NULL
          ) AS exact_owner
        FROM active_runs AS active
        JOIN expected USING (subject_key)
        FOR UPDATE OF active
      ), guard AS MATERIALIZED (
        SELECT count(*) FILTER (WHERE NOT exact_owner)::integer AS drift_count
        FROM observed
      ), deleted AS (
        DELETE FROM active_runs AS active
        USING expected, guard
        WHERE guard.drift_count = 0
          AND active.subject_key = expected.subject_key
          AND active.owner_token = ${campaign.ownerToken}
          AND active.state = 'reserved'
          AND active.run_id IS NULL
        RETURNING active.subject_key
      )
      SELECT
        (SELECT drift_count FROM guard) AS drift_count,
        (
          SELECT coalesce(jsonb_agg(subject_key), '[]'::jsonb)
          FROM observed
          WHERE NOT exact_owner
        ) AS drift_subjects,
        (SELECT count(*)::integer FROM deleted) AS changed_count
    `);
    const row = rowsOf<GuardedMutationRow>(result)[0];
    if (integer(row?.drift_count) > 0) {
      throw new CapacityFixtureOwnershipError(
        "cleanup",
        driftSubjects(row?.drift_subjects),
      );
    }
    return integer(row?.changed_count);
  }

  /** A null run id is still a claim; count rows instead of projecting run_id. */
  async countTicketClaims(ticketKey: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(activeRuns)
      .where(eq(activeRuns.ticketKey, ticketKey));
    return Number(row?.count ?? 0);
  }
}

export function createE2ECapacityRegistry(): CapacityRegistry {
  const db = drizzle({
    client: neon(e2eEnv.DATABASE_URL),
    schema,
  }) as unknown as Db;
  return new CapacityRegistry(db);
}

/**
 * Assertion failures still pass through the caller's ticket-safety barrier.
 * If that barrier cannot prove the ticket left AI, cleanup deliberately stops
 * and preserves capacity reservations for investigation.
 */
export async function withCapacityReservations<T>(input: {
  registry: CapacityRegistry;
  campaign: CapacityCampaign;
  run: () => Promise<T>;
  beforeRelease: () => Promise<void>;
}): Promise<T> {
  await input.registry.seed(input.campaign);
  try {
    return await input.run();
  } finally {
    await input.beforeRelease();
    await input.registry.cleanup(input.campaign);
  }
}
