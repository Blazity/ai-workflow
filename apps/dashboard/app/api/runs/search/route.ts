// apps/dashboard/app/api/runs/search/route.ts
// Same-origin proxy for the spotlight ticket search. Lets the client search as
// it types without the server-only WORKER_API_TOKEN ever reaching the browser.
// Searches across all history (the worker turns `q` into a bound, escaped
// ILIKE over ticket key + title) and returns a slim payload for the palette.
import { NextResponse } from "next/server";
import { getJSON, withQuery } from "@/lib/api/server";
import type { RunsResponse } from "@shared/contracts";

const MAX_HITS = 8;

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ rows: [] });

  try {
    const data = await getJSON<RunsResponse>(
      withQuery("/api/v1/runs", { window: "all", q }),
    );
    const rows = data.rows.slice(0, MAX_HITS).map((r) => ({
      id: r.id,
      ticket: r.ticket,
      ticketTitle: r.ticketTitle,
      workflowName: r.workflowName,
      status: r.status,
      startedAtMin: r.startedAtMin,
    }));
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ rows: [] });
  }
}
