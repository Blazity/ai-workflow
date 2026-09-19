/**
 * A request for visibility data, and what came back, in the terms a person is
 * told about: the data, or why it is not on the screen.
 *
 * A READ FAILURE IS NEVER A MISSING-BRIEFING REASON. A 404 (the worker has not
 * deployed the route yet: the worker and the dashboard deploy separately), a
 * 5xx, a timeout and a network error all say "could not be loaded" and offer a
 * retry; a 401 asks to sign in again. Only the worker's own `missing` field
 * says why a briefing does not exist.
 */
import type { VisibilityRead } from "@shared/agent-visibility";

import type { ApiResult } from "@/lib/api/client";
import type { VisibilityProblem } from "./contract";

export type LoadFailure =
  | { kind: "unauthorized" }
  | { kind: "unavailable"; status: number | null; message: string }
  | { kind: "unreadable"; problem: VisibilityProblem };

export type Loaded<T> = { ok: true; value: T } | { ok: false; failure: LoadFailure };

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Runs `request` and reads its body with `read`. An aborted request rethrows,
 *  so the caller that aborted it can drop it. */
export async function loadVisibility<T>(
  request: () => Promise<ApiResult<unknown>>,
  read: (value: unknown) => VisibilityRead<T>,
): Promise<Loaded<T>> {
  let result: ApiResult<unknown>;
  try {
    result = await request();
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      ok: false,
      failure: { kind: "unavailable", status: null, message: "The dashboard could not reach the worker." },
    };
  }
  if (!result.ok) {
    if (result.status === 401) return { ok: false, failure: { kind: "unauthorized" } };
    return { ok: false, failure: { kind: "unavailable", status: result.status, message: result.errorMessage } };
  }
  const read_ = read(result.data);
  return read_.ok ? { ok: true, value: read_.value } : { ok: false, failure: { kind: "unreadable", problem: read_ } };
}

/** What to tell a person about a failure to load `what` ("Briefings",
 *  "This section's text"). */
export function failureSentence(failure: LoadFailure, what: string): string {
  switch (failure.kind) {
    case "unauthorized":
      return `${what} could not be loaded: your session has ended. Sign in again to continue.`;
    case "unavailable":
      if (failure.status === null) return `${what} could not be loaded: ${failure.message}`;
      if (failure.status === 404) {
        return `${what} could not be loaded: the worker answered 404 (not found). A worker older than this dashboard does not serve them yet.`;
      }
      if (failure.status === 504) return `${what} could not be loaded: the worker did not answer in time.`;
      return `${what} could not be loaded: the worker answered ${failure.status} (${failure.message}).`;
    case "unreadable":
      return failure.problem.reason === "newer_version"
        ? `${failure.problem.message} Reload the page once the dashboard is updated.`
        : `${what} could not be read: ${failure.problem.message}`;
  }
}
