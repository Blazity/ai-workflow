/**
 * An adapter somebody holds keeps working for as long as they hold it.
 *
 * The people this is about never see an adapter: a run downloading a ticket's
 * twenty attachments one after another, a poll pass that reads the board,
 * waits on a model and then moves a ticket, a resume that answers a question
 * and then confirms it. Each resolves the tracker once and makes its calls
 * over the next minutes. When the context expired 30 s after resolution, every
 * later call failed at once with an error that read exactly like Jira timing
 * out, and a POST was never retried: attachments silently went missing and a
 * ticket stayed where it was.
 *
 * Everything below is the real path (the resolver, the context, the Jira
 * adapter, Node's fetch against a loopback server). Only the database read is
 * replaced, with the answer a deployment configured through its environment
 * gives. Time is the one thing faked: `AbortSignal.timeout` is driven by a
 * clock the test moves, because that is the clock the bug ran on and Vitest's
 * fake timers do not reach it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories/integrations.js", () => ({
  // No stored connection: the tracker is configured through the environment.
  readConnectedIntegrationConnections: async () => new Map(),
}));

const { resolveActiveIssueTracker } = await import("./issue-tracker-runtime.js");
const { resolveUsableIntegrations } = await import("../../services/integrations/runtime.js");

const TOKEN = "atl-token-5c0ffee5-9d1b";

/** Every `AbortSignal.timeout` made during a test, aborted when the clock passes it. */
const clock = {
  now: 0,
  timers: [] as Array<{ due: number; controller: AbortController }>,
  advance(ms: number): void {
    this.now += ms;
    for (const timer of this.timers) {
      if (timer.due <= this.now && !timer.controller.signal.aborted) {
        timer.controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      }
    }
  },
};

interface Server {
  readonly url: string;
  readonly hits: string[];
  /** Answer every held request, and every later one at once. */
  release(body: string): void;
  close(): Promise<void>;
}

const servers: Server[] = [];

async function serve(mode: "hold" | "never"): Promise<Server> {
  const hits: string[] = [];
  const held: http.ServerResponse[] = [];
  let released: string | null = null;
  const server = http.createServer((req, res) => {
    hits.push(req.method ?? "");
    if (mode === "never") return;
    if (released !== null) res.end(released);
    else held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const handle: Server = {
    url: `http://127.0.0.1:${port}/attachment/mockup.png`,
    hits,
    release(body) {
      released = body;
      for (const res of held.splice(0)) if (!res.destroyed) res.end(body);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(handle);
  return handle;
}

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

/** Fails if the promise has not settled within real time, instead of hanging the suite. */
async function settled<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function heldTracker() {
  const tracker = await resolveActiveIssueTracker();
  if (!tracker.ok) throw new Error(tracker.reason);
  const download = tracker.adapter.downloadAttachment;
  if (!download) throw new Error("the tracker cannot download attachments");
  return (url: string, options?: { timeoutMs?: number }) =>
    download.call(tracker.adapter, url, options);
}

beforeEach(() => {
  vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net");
  vi.stubEnv("JIRA_API_TOKEN", TOKEN);
  vi.stubEnv("JIRA_PROJECT_KEY", "AIW");
  clock.now = 0;
  clock.timers = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    clock.timers.push({ due: clock.now + ms, controller });
    return controller.signal;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("a run holding the tracker", () => {
  it("still reaches Jira minutes after it resolved it", async () => {
    // The attachment loop: download one, the next one a while later. The
    // mistake that turns this red is a lifetime started at resolution, for
    // example `lifetime: AbortSignal.timeout(30_000)` in the tracker runtime.
    const server = await serve("hold");
    server.release("PNG");
    const download = await heldTracker();

    clock.advance(31_000);
    const bytes = await settled(download(server.url));

    expect(bytes.toString()).toBe("PNG");
    expect(server.hits).toEqual(["GET"]);
  });

  it("gives up on an attachment at the operator's deadline, and does not retry past it", async () => {
    // ATTACHMENT_DOWNLOAD_TIMEOUT_MS used to be dropped on the way into fetch,
    // so the setting did nothing and a stuck download cost three 30 s tries.
    const server = await serve("never");
    const download = await heldTracker();

    const pending = download(server.url, { timeoutMs: 2_000 });
    await until(() => server.hits.length === 1);
    clock.advance(2_000);

    await expect(settled(pending)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(server.hits).toEqual(["GET"]);
  });

  it("lets a download run as long as the operator allowed, past the default 30 s", async () => {
    // The other half of the same setting: an operator with large attachments
    // raises it, and the per-attempt default must not cut the download at 30 s
    // and start it again from the first byte.
    const server = await serve("hold");
    const download = await heldTracker();

    const pending = download(server.url, { timeoutMs: 60_000 });
    await until(() => server.hits.length === 1);
    clock.advance(35_000);
    server.release("PNG");

    expect((await settled(pending)).toString()).toBe("PNG");
    expect(server.hits).toEqual(["GET"]);
  });
});

describe("what core copies out of an integration", () => {
  it("can take the connection's token out of a provider's words", async () => {
    // Core's own redactor for text that comes back from an adapter by a route
    // other than `ctx` (a memory refusal's detail, a thrown message). It is
    // built from the connection it was resolved with, not handed to the
    // integration.
    const resolved = await resolveUsableIntegrations({
      filter: (manifest) => manifest.id === "jira",
    });
    if (!resolved.readable) throw new Error(resolved.reason);
    const [jira] = resolved.usable;

    expect(jira?.redaction.text(`401 for Authorization: Bearer ${TOKEN}`)).toBe(
      "401 for Authorization: Bearer [redacted]",
    );
    const thrown = jira?.redaction.error(
      new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`),
    );
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown?.message).toBe('Headers.append: "Bearer [redacted]" is an invalid header value.');
  });
});
