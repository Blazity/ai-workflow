import type { SystemHealthResponse } from "@shared/contracts";
import {
  readConnectedSystemHealthScan,
  saveConnectedSystemHealthScan,
} from "../../db/repositories/system-health.js";

/** Overwrites the stored scan so the Health screen can show it on load. */
export function saveSystemHealthScan(report: SystemHealthResponse): Promise<void> {
  return saveConnectedSystemHealthScan(report);
}

/** The last stored scan, or `null` before the first one. Never runs a probe. */
export function readSystemHealthScan(): Promise<SystemHealthResponse | null> {
  return readConnectedSystemHealthScan();
}
