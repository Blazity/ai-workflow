/**
 * Vercel REST API client — Workflow Runs + Function Logs
 *
 * ─── Endpoint research (conducted 2026-05-28) ────────────────────────────────
 *
 * Sources consulted:
 *   • https://vercel.com/docs/workflows        (Workflows product overview)
 *   • https://vercel.com/docs/logs/runtime      (Runtime Logs UI docs)
 *   • https://vercel.com/llms.txt               (full sitemap)
 *   • https://openapi.vercel.sh/                (public OpenAPI spec)
 *   • https://vercel.com/docs/rest-api/logs/get-logs-for-a-deployment
 *
 * FINDINGS:
 *   Workflow Runs REST API: **Not publicly documented** as of the research date.
 *   The Workflows product exposes run observability via the Vercel dashboard UI
 *   (/observability/workflows) but no public GET /v1/workflows/runs endpoint was
 *   found in the OpenAPI spec or docs pages. Paths below are plausible but
 *   unverified — all marked TODO(verify).
 *
 *   Function Logs REST API: One documented endpoint exists:
 *     GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs
 *   It streams NDJSON per-deployment, not by time range, and does not accept
 *   `since`/`until` query params. The `/v2/logs` path used in the task skeleton
 *   was NOT found in the public spec — also marked TODO(verify).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { env, isConfigured } from "./env";

const API = "https://api.vercel.com";

export interface VercelRunRaw {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "success" | "running" | "failed" | "blocked" | "awaiting";
  startedAt: number;
  durationMs: number | null;
  model?: string;
  currentSpan?: { name: string; kind: string; index: number; total: number };
  progress?: number;
  etaSec?: number;
  pausedAt?: {
    spanName: string;
    question: string;
    questionFor: string;
    suggestedAnswers?: string[];
  };
  ticket?: string;
  prNumber?: number;
  prRepo?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = env.vercel.token();
  const team = env.vercel.teamId();
  const url = new URL(API + path);
  if (team) url.searchParams.set("teamId", team);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Vercel ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasRuns(value: unknown): value is { runs: VercelRunRaw[] } {
  return isRecord(value) && Array.isArray(value.runs);
}

function hasLogs(
  value: unknown,
): value is {
  logs: { timestamp: number; durationMs: number; statusCode: number }[];
} {
  return isRecord(value) && Array.isArray(value.logs);
}

/**
 * List workflow runs for the configured project.
 *
 * TODO(verify): The path `/v1/workflows/runs` and query parameters
 * (`projectId`, `status`, `since`, `limit`) are **unverified** — no public
 * REST API documentation for Workflow Runs was found. Adjust once Vercel
 * publishes the endpoint or it is confirmed via support/private docs.
 */
export async function listRuns(opts: {
  status?: VercelRunRaw["status"][];
  since?: number;
  limit?: number;
}): Promise<VercelRunRaw[]> {
  if (!isConfigured.vercel()) return [];
  const project = env.vercel.projectId()!;
  const qs = new URLSearchParams({ projectId: project });
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.since) qs.set("since", String(opts.since));
  opts.status?.forEach((s) => qs.append("status", s));
  // TODO(verify): path not found in public Vercel OpenAPI spec as of 2026-05-28
  try {
    const data = await call<unknown>(`/v1/workflows/runs?${qs}`);
    if (!hasRuns(data)) {
      console.warn("vercel_list_runs_unverified_shape");
      return [];
    }
    return data.runs;
  } catch (err) {
    console.warn("vercel_list_runs_unverified_endpoint_failed", err);
    return [];
  }
}

/**
 * List function log summaries for the configured project within a time window.
 *
 * TODO(verify): The path `/v2/logs` with `since`/`until` query params was NOT
 * found in the public Vercel REST API spec. The only documented log endpoint
 * is per-deployment streaming NDJSON:
 *   GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs
 * which does not support time-range queries. Replace this path once the
 * correct endpoint is confirmed.
 */
export async function listFunctionLogs(opts: {
  since: number;
  until: number;
}): Promise<{ timestamp: number; durationMs: number; statusCode: number }[]> {
  if (!isConfigured.vercel()) return [];
  const project = env.vercel.projectId()!;
  // TODO(verify): path not found in public Vercel OpenAPI spec as of 2026-05-28
  try {
    const data = await call<unknown>(
      `/v2/logs?projectId=${project}&since=${opts.since}&until=${opts.until}`,
    );
    if (!hasLogs(data)) {
      console.warn("vercel_list_function_logs_unverified_shape");
      return [];
    }
    return data.logs;
  } catch (err) {
    console.warn("vercel_list_function_logs_unverified_endpoint_failed", err);
    return [];
  }
}
