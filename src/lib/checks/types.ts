import type { z } from "zod";

export type Severity = "info" | "warning" | "critical";

export interface FindingLocation {
  path: string;
  start_line: number;
  end_line?: number;
}

export interface RelatedLocation {
  path: string;
  start_line?: number;
  note?: string;
}

export interface SuggestedChange {
  path: string;
  start_line: number;
  end_line: number;
  replacement: string;
}

export interface Finding {
  severity: Severity;
  message: string;
  primary_location?: FindingLocation;
  related_locations?: RelatedLocation[];
  suggestion?: SuggestedChange;
  fingerprint: string;
}

export interface CheckCacheManifest {
  cache_version: 1;
  check_id: string;
  config_hash: string;
  files: Record<string, {
    content_hash: string;
    status: "completed" | "skipped" | "failed";
    finding_count: number;
    previous_check_run_id?: number;
  }>;
}

export interface CheckResult {
  summary: string;
  findings: Finding[];
  notices: string[];
  cache_manifest?: CheckCacheManifest;
}

export interface PRContext {
  owner: string;
  repo: string;
  pr_number: number;
  pr_url: string;
  base_sha: string;
  head_sha: string;
  labels: string[];
}

export type RequestedReviewData = Record<string, unknown>;

export interface CheckContext {
  pr: PRContext;
  requested_data: RequestedReviewData;
  dependency_results: Record<string, CheckResult>;
  previous_cache?: CheckCacheManifest;
}

export interface Check<TParams = unknown> {
  readonly kind: string;
  readonly paramsSchema: z.ZodType<TParams>;
  run(params: TParams, ctx: CheckContext): Promise<CheckResult>;
}
