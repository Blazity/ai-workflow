import { beforeAll, describe, expect, it } from "vitest";
import type { SystemHealthResponse } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { readSystemHealthScan, saveSystemHealthScan } from "./last-scan.js";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

function report(generatedAt: string, live: number): SystemHealthResponse {
  return {
    generatedAt,
    summary: {
      total: 1,
      live,
      down: 1 - live,
      notConfigured: 0,
      criticalDown: 1 - live,
      checksTotal: 1,
      checksLive: live,
      checksDown: 1 - live,
      checksDegraded: 0,
    },
    integrations: [
      {
        id: "database",
        label: "Database",
        group: "core",
        envVars: ["DATABASE_URL"],
        critical: true,
        mode: live ? "live" : "down",
        ping: { ok: live === 1, latencyMs: 12 },
        checks: [
          {
            id: "connectivity",
            label: "Connection and query",
            description: "Verified independently.",
            critical: true,
            mode: live ? "live" : "down",
            envVars: ["DATABASE_URL"],
            evidenceSource: "live-probe",
          },
        ],
      },
    ],
  };
}

describe("system health last scan", () => {
  it("reads null before the first scan", async () => {
    expect(await readSystemHealthScan(db)).toBeNull();
  });

  it("stores the scan and returns it unchanged", async () => {
    const first = report("2026-08-21T10:00:00.000Z", 1);
    await saveSystemHealthScan(db, first);
    expect(await readSystemHealthScan(db)).toEqual(first);
  });

  it("keeps only the latest scan", async () => {
    const second = report("2026-08-21T11:00:00.000Z", 0);
    await saveSystemHealthScan(db, second);
    expect(await readSystemHealthScan(db)).toEqual(second);
  });
});
