/**
 * A Mem0 project in memory for the memory store's tests (`store.ts`),
 * answering the calls that store makes the way the live platform answered
 * them on 2026-09-25 (`live-probe.ts`; the recorded bodies are the `live-*`
 * fixtures, and each record here starts as the recorded one). Nothing here
 * reaches the network.
 *
 * What it models, because the store has to cope with each:
 *
 * - `POST /v3/memories/`: filters (`AND`, a bare value, `in`, `*`) are
 *   required and must name an entity; `page_size` at most 200; newest first,
 *   `created_at` TO THE SECOND in the `-07:00` offset, and within one second
 *   in an order that is not the order of writing (here: by text). A memory
 *   Merge folded into another (`merged`) is hidden unless the body carries
 *   `include_merged: true` (Mem0's Dream page); `%` is an ordinary character.
 * - `POST /v3/memories/add/` with `infer: false` only: one result per message
 *   in order, an exact repeat of a text its scope holds answered with that
 *   memory's id. With `queueing`, every add answers `PENDING` with an event id
 *   and lands on `settle()`.
 * - `POST /v3/memories/search/`: a score in [0, 1] for every memory the
 *   filters select (word overlap here, never zero, as live scores were
 *   not), cut by `threshold` and `top_k`.
 * - `PUT /v1/memories/{id}/`: text and the WHOLE metadata replaced, the same
 *   id; not refused for an immutable memory (live), 404 for an unknown id.
 * - `DELETE /v1/memories/{id}/`: 404 for an unknown id; with
 *   `delete_linked=true`, also every memory it superseded, counted in
 *   `cascade_count`. The probe never saw a cascade, so this one follows both
 *   links: `replaced_by` of the older memory, and `linked` of the deleted one
 *   (Mem0's SDK names its `linked_memory_ids`, which no listing shows).
 * - `consolidate()`: Supersede as Mem0 documents it (the probe never saw it
 *   act on a direct import): an older memory similar to a newer one in its
 *   scope gets `replaced_by`, an immutable one never.
 */
import assert from "node:assert/strict";
import { recordedJson, json, type Sent } from "./test-support";

interface PlatformMemory {
  id: string;
  memory: string;
  user_id: string | null;
  agent_id: string | null;
  app_id: string | null;
  metadata: Record<string, unknown> | null;
  replaced_by: string | null;
  immutable: boolean;
  /** Folded into another by Merge: hidden from a listing and a search without `include_merged`. */
  merged: boolean;
  /** Mem0's `linked_memory_ids`: never listed, followed by `delete_linked`. */
  linked: string[];
  /** When it was written, to the millisecond; Mem0 lists it to the second. */
  at: number;
  updatedAt: number;
}

type Condition = Record<string, unknown>;

const listed = recordedJson<{ results: Record<string, unknown>[] }>("live-list-page.json").results[0] as Record<string, unknown>;
const searched = recordedJson<{ results: Record<string, unknown>[] }>("live-search.json").results[0] as Record<string, unknown>;
const updated = recordedJson("live-update.json");

/** `2026-09-25T02:00:27-07:00`: how a listing gives a time (seen live). */
function toTheSecond(ms: number): string {
  return `${new Date(ms - 7 * 3_600_000).toISOString().slice(0, 19)}-07:00`;
}

/** `2026-09-25T02:00:27.172000-07:00`: how an update gives it. */
function toTheMicrosecond(ms: number): string {
  return `${new Date(ms - 7 * 3_600_000).toISOString().slice(0, 23)}000-07:00`;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const all = new Set([...left, ...right]).size;
  return all === 0 ? 0 : shared / all;
}

const ENTITY_FIELDS: ReadonlySet<string> = new Set(["user_id", "agent_id", "app_id", "run_id"]);

export interface FakePlatform {
  readonly memories: PlatformMemory[];
  handle(sent: Sent): Response;
  /** Run Mem0's Supersede now over what it holds. */
  consolidate(): void;
  /** Process every queued add. */
  settle(): void;
  /** Store a memory directly, as another writer (or version 1) would have. */
  seed(memory: Partial<PlatformMemory> & { memory: string }): PlatformMemory;
}

export function fakeMem0Platform(options: { readonly queueing?: boolean } = {}): FakePlatform {
  const memories: PlatformMemory[] = [];
  const queue: { body: Record<string, unknown> }[] = [];
  let clock = Date.parse("2026-09-25T09:00:00.000Z");
  let serial = 0;
  const nextId = () => `00000000-0000-4000-8000-${String((serial += 1)).padStart(12, "0")}`;
  const tick = () => (clock += 1);

  const seed: FakePlatform["seed"] = (memory) => {
    const at = memory.at ?? tick();
    const stored: PlatformMemory = {
      id: nextId(),
      user_id: null,
      agent_id: null,
      app_id: null,
      metadata: null,
      replaced_by: null,
      immutable: false,
      merged: false,
      linked: [],
      updatedAt: at,
      ...memory,
      at,
    };
    memories.push(stored);
    return stored;
  };

  const matches = (memory: PlatformMemory, condition: Condition): boolean =>
    Object.entries(condition).every(([field, wanted]) => {
      if (field === "AND") return (wanted as Condition[]).every((inner) => matches(memory, inner));
      if (field === "OR") return (wanted as Condition[]).some((inner) => matches(memory, inner));
      if (field === "metadata") return Object.entries(wanted as Condition).every(([key, value]) => memory.metadata?.[key] === value);
      const actual = (memory as unknown as Record<string, unknown>)[field];
      if (wanted === "*") return actual !== null && actual !== undefined;
      if (wanted && typeof wanted === "object") {
        const operators = wanted as Condition;
        assert.deepEqual(Object.keys(operators), ["in"], `this fake reads only the in operator, not ${JSON.stringify(operators)}`);
        return (operators.in as unknown[]).includes(actual);
      }
      return actual === wanted;
    });

  const namesEntity = (condition: unknown): boolean =>
    Boolean(condition) &&
    typeof condition === "object" &&
    Object.entries(condition as Condition).some(
      ([field, value]) => ENTITY_FIELDS.has(field) || (Array.isArray(value) && value.some(namesEntity)),
    );

  const selected = (body: Record<string, unknown>) =>
    memories.filter((memory) => (!memory.merged || body.include_merged === true) && matches(memory, body.filters as Condition));

  const asListed = (memory: PlatformMemory) => ({
    ...listed,
    id: memory.id,
    memory: memory.memory,
    user_id: memory.user_id,
    agent_id: memory.agent_id,
    app_id: memory.app_id,
    metadata: memory.metadata,
    created_at: toTheSecond(memory.at),
    updated_at: toTheSecond(memory.updatedAt),
    replaced_by: memory.replaced_by,
  });

  const store = (body: Record<string, unknown>) =>
    ((body.messages ?? []) as { content: string }[]).map((message) => {
      const scope = (memory: PlatformMemory) =>
        memory.user_id === body.user_id && memory.agent_id === body.agent_id && memory.app_id === body.app_id;
      const held = memories.find((memory) => scope(memory) && memory.memory === message.content);
      const memory =
        held ??
        seed({
          memory: message.content,
          user_id: body.user_id as string,
          agent_id: body.agent_id as string,
          app_id: body.app_id as string,
          metadata: body.metadata as Record<string, unknown>,
          immutable: body.immutable === true,
        });
      return { id: memory.id, data: { memory: memory.memory }, event: "ADD" };
    });

  const handle = (sent: Sent): Response => {
    const body = (sent.body ?? {}) as Record<string, unknown>;
    const path = sent.url.pathname;
    if (sent.method === "POST" && path === "/v3/memories/") {
      if (!namesEntity(body.filters)) return json({ error: "filters must include at least one entity id" }, 400);
      const page = Number(sent.url.searchParams.get("page") ?? "1");
      const size = Number(sent.url.searchParams.get("page_size") ?? "100");
      if (size > 200) return json({ error: "page_size must be at most 200" }, 400);
      const second = (memory: PlatformMemory) => Math.floor(memory.at / 1000);
      const all = selected(body).sort((a, b) => second(b) - second(a) || a.memory.localeCompare(b.memory));
      const next = page * size < all.length ? `https://api.mem0.ai/v3/memories/?page=${page + 1}&page_size=${size}` : null;
      return json({ count: all.length, next, previous: null, results: all.slice((page - 1) * size, page * size).map(asListed) });
    }
    if (sent.method === "POST" && path === "/v3/memories/add/") {
      assert.equal(body.infer, false, "the store only ever adds with infer: false");
      if (options.queueing) {
        queue.push({ body });
        return json({ event_id: nextId(), status: "PENDING" });
      }
      return json({ message: "Memories stored successfully", status: "SUCCEEDED", event_id: nextId(), results: store(body) });
    }
    if (sent.method === "POST" && path === "/v3/memories/search/") {
      const query = typeof body.query === "string" ? body.query : "";
      const topK = Number(body.top_k ?? 10);
      const threshold = Number(body.threshold ?? 0.1);
      if (query.length === 0 || !namesEntity(body.filters)) return json({ error: "query and filters are required" }, 400);
      if (!(topK >= 1 && topK <= 1000)) return json({ error: "top_k must be between 1 and 1000" }, 400);
      const ranked = selected(body)
        .map((memory) => ({ memory, score: Math.round((0.05 + 0.9 * overlap(query, memory.memory)) * 10_000) / 10_000 }))
        .filter((scored) => scored.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      const results: Record<string, unknown>[] = [];
      for (const { memory, score } of ranked) {
        results.push({ ...searched, id: memory.id, memory: memory.memory, user_id: memory.user_id, agent_id: memory.agent_id, app_id: memory.app_id, metadata: memory.metadata, score });
      }
      return json({ results });
    }
    const one = /^\/v1\/memories\/([^/]+)\/$/u.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1] ?? "");
      const memory = memories.find((candidate) => candidate.id === id);
      if (!memory) return json({ error: "Memory not found!" }, 404);
      if (sent.method === "PUT") {
        if (typeof body.text === "string") memory.memory = body.text;
        if (body.metadata !== undefined) memory.metadata = body.metadata as Record<string, unknown>;
        memory.updatedAt = tick();
        return json({ ...updated, id, memory: memory.memory, user_id: memory.user_id, agent_id: memory.agent_id, app_id: memory.app_id, metadata: memory.metadata, created_at: toTheMicrosecond(memory.at), updated_at: toTheMicrosecond(memory.updatedAt) });
      }
      if (sent.method === "DELETE") {
        const linked = sent.url.searchParams.get("delete_linked") === "true";
        const doomed = new Set([id]);
        if (linked) {
          for (let grew = true; grew; ) {
            grew = false;
            for (const other of memories) {
              const taken = (other.replaced_by && doomed.has(other.replaced_by)) || memories.some((holder) => doomed.has(holder.id) && holder.linked.includes(other.id));
              if (taken && !doomed.has(other.id)) {
                doomed.add(other.id);
                grew = true;
              }
            }
          }
        }
        for (let at = memories.length - 1; at >= 0; at -= 1) if (doomed.has((memories[at] as PlatformMemory).id)) memories.splice(at, 1);
        return json({ message: "Memory deleted successfully!", ...(linked ? { cascade_count: doomed.size - 1 } : {}) });
      }
    }
    if (sent.method === "GET" && path === "/v1/ping/") {
      return json({ status: "ok", org_id: "org-example-1", project_id: "proj-example-1", user_email: "someone@example.com" });
    }
    return new Response("no such route in this fake", { status: 418 });
  };

  return {
    memories,
    handle,
    seed,
    consolidate() {
      for (const older of memories) {
        if (older.immutable || older.replaced_by) continue;
        const newer = memories.findLast(
          (candidate) =>
            candidate !== older &&
            candidate.at > older.at &&
            candidate.user_id === older.user_id &&
            candidate.agent_id === older.agent_id &&
            candidate.app_id === older.app_id &&
            overlap(candidate.memory, older.memory) >= 0.5,
        );
        if (newer) older.replaced_by = newer.id;
      }
    },
    settle() {
      for (const { body } of queue.splice(0)) store(body);
    },
  };
}
