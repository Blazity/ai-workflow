import { SAFE_ID, badRequest, forward, notFound, type WorkerProxy } from "../worker-forward";

type BriefingsRouteContext = {
  params: Promise<{ runId: string; path?: string[] }>;
};

const SECTION_INDEX = /^(?:0|[1-9][0-9]{0,3})$/;
const WHOLE_NUMBER = /^(?:0|[1-9][0-9]{0,9})$/;
/** A cursor is opaque, and short: it is handed out by the worker. */
const CURSOR = /^[A-Za-z0-9_.:=-]{1,200}$/;

const LIST = ["cursor", "limit"] as const;

/**
 * The query parameters each briefing route takes, and nothing else: anything
 * the dashboard did not mean to send never reaches the worker.
 */
function allowedParameters(path: readonly string[]): readonly string[] | null {
  if (path.length === 0) return ["nodeId", "attempt", "activationScopeId", ...LIST];
  const [briefingId, collection, index, child] = path;
  if (!SAFE_ID.test(briefingId!)) return null;
  if (path.length === 2 && (collection === "sections" || collection === "repository-context" || collection === "unresolved-sources")) {
    return LIST;
  }
  if (collection !== "sections" || !SECTION_INDEX.test(index ?? "")) return null;
  if (path.length === 3) return ["offset", "limit"];
  if (path.length === 4 && (child === "parts" || child === "spans")) return LIST;
  return null;
}

function valid(name: string, value: string): boolean {
  if (name === "cursor") return CURSOR.test(value);
  if (name === "attempt" || name === "offset" || name === "limit") return WHOLE_NUMBER.test(value);
  return SAFE_ID.test(value);
}

/**
 * `GET /api/runs/{runId}/briefings[/...]`: the agent briefings of a run,
 * forwarded to the worker's `/api/v1/runs/{runId}/briefings[/...]` with the
 * same path, as the worker read routes serve them.
 */
export async function handleBriefingsGet(
  request: Request,
  { params }: BriefingsRouteContext,
  workerProxy: WorkerProxy,
) {
  const { runId, path = [] } = await params;
  if (!SAFE_ID.test(runId)) return notFound();
  const allowed = allowedParameters(path);
  if (allowed === null) return notFound();
  const query = new URLSearchParams();
  for (const name of allowed) {
    const value = new URL(request.url).searchParams.get(name);
    if (value === null || value === "") continue;
    if (!valid(name, value)) return badRequest(`${name} is not a value this route takes`);
    query.set(name, value);
  }
  const suffix = path.map(encodeURIComponent).join("/");
  const text = query.toString();
  return forward(
    workerProxy,
    `/api/v1/runs/${encodeURIComponent(runId)}/briefings${suffix ? `/${suffix}` : ""}${text ? `?${text}` : ""}`,
  );
}
