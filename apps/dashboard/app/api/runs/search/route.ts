// apps/dashboard/app/api/runs/search/route.ts
// Same-origin proxy for the spotlight ticket search. Lets the client search as
// it types without the worker-issued ba_session cookie ever reaching the browser
// (the dashboard replays it server-side as Authorization: Bearer).
// Searches across all history (the worker turns `q` into a bound, escaped
// ILIKE over ticket key + title), then collapses runs into one hit per ticket.
import { NextResponse } from "next/server";
import { getJSON, withQuery } from "@/lib/api/server";
import type { RunsResponse } from "@shared/contracts";
import { dedupeHitsByTicket } from "./dedupe";

const MAX_HITS = 8;

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ rows: [] });

  try {
    const data = await getJSON<RunsResponse>(
      withQuery("/api/v1/runs", { window: "all", q }),
    );
    const rows = dedupeHitsByTicket(data.rows).slice(0, MAX_HITS);
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ rows: [] });
  }
}
