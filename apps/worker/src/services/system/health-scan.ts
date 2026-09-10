/**
 * The two things the Health screen can ask for: the stored scan, and a new one.
 *
 * The probes and the scan store each take a connection; this binds it, and keeps
 * "run a scan" as one operation so that a scan which ran is always a scan that
 * was stored.
 */
import type { SystemHealthResponse } from "@shared/contracts";
import { getDb } from "../../db/client.js";
import { readSystemHealthScan, saveSystemHealthScan } from "./last-scan.js";
import { collectDeploymentSystemHealth } from "./probes.js";

/** The stored result of the last scan, or null before the first one. */
export function readLastSystemHealthScan(): Promise<SystemHealthResponse | null> {
  return readSystemHealthScan(getDb());
}

/** Probe every integration now, store the report, and return it. */
export async function runSystemHealthScan(): Promise<SystemHealthResponse> {
  const report = await collectDeploymentSystemHealth();
  await saveSystemHealthScan(getDb(), report);
  return report;
}
