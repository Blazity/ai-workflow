// apps/dashboard/app/memory-data.test.tsx
//
// What the memory page hands the screen when the worker answers each request
// differently. The listing and the single-document read are separate requests
// against the same provider, so one can succeed while the other does not, and
// the page has to keep those two answers apart all the way to the sentence a
// person reads.
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { DashboardSession } from "@/lib/auth/session";

import { WorkerResponseError } from "../lib/api/worker-response-error.ts";

const SUBJECT_KEY = "ticket:jira:AIW-177";
const DOC_PATH = "ai-workflow/memory/AIW-177.md";

const LISTING = {
  complete: true,
  documents: [
    {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: "AIW-177",
      bytes: 12,
      sourceRunId: "run_1",
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    },
  ],
};

const SESSION: DashboardSession = {
  organizationName: "Acme",
  actorLabel: "filip",
  role: "owner",
  canManageUsers: true,
  canEditChecks: true,
  canEditWorkflows: true,
  canDispatchWorkflows: true,
};

/** What getJSON answers per path prefix. A function throws, a value resolves. */
let answers: Record<string, unknown | (() => never)> = {};

mock.module("../lib/auth/session.ts", {
  exports: { requireSession: async () => SESSION },
} as unknown as Parameters<typeof mock.module>[1]);

mock.module("../lib/api/server.ts", {
  exports: {
    withQuery: (path: string, params: Record<string, string | undefined>) => {
      const sp = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value) sp.set(key, value);
      const query = sp.toString();
      return query ? `${path}?${query}` : path;
    },
    getJSON: async (path: string) => {
      const answer = answers[path];
      if (typeof answer === "function") (answer as () => never)();
      if (answer === undefined) {
        throw new WorkerResponseError(path, 404, "Not Found", {
          error: true,
          statusCode: 404,
          statusMessage: "Memory document not found",
          message: "Memory document not found",
        });
      }
      return answer;
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);

// require, not a top-level import: this package transpiles to CommonJS and the
// page has to load AFTER the mocks are registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MemoryData } = require("./memory-data") as typeof import("./memory-data");

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

function nodeText(node: ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

const ROUTER = {
  refresh: () => {},
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

/** Renders the page exactly as Next would: await the server component, then
 *  mount what it returned. Asserting on the rendered text rather than on the
 *  props it passed is the point, because the props are an internal and the
 *  sentence is what a person acts on. */
async function renderPage(t: TestContext): Promise<string> {
  const element = await MemoryData({ subjectKey: SUBJECT_KEY, docPath: DOC_PATH });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={ROUTER as never}>{element}</AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
  });
  return nodeText(renderer.root);
}

/**
 * What getJSON throws for a refusal: the status, the reason phrase, and the
 * body Nitro writes for an h3 error. The reason phrase defaults to the reason
 * itself, which is what HTTP/1.1 carries when the sentence is plain ASCII.
 */
function providerRefused(status: number, reason: string, statusText = reason): () => never {
  return () => {
    throw new WorkerResponseError("/api/v1/memory", status, statusText, {
      error: true,
      statusCode: status,
      statusMessage: reason,
      message: reason,
    });
  };
}

test("a read the provider could not answer never reaches the page as a deletion", async (t) => {
  answers = {
    "/api/v1/memory": LISTING,
    [`/api/v1/memory?subjectKey=${encodeURIComponent(SUBJECT_KEY)}&docPath=${encodeURIComponent(DOC_PATH)}`]:
      providerRefused(503, "Built-in memory could not answer: db down"),
    "/api/v1/settings": { settings: [] },
  };

  const text = await renderPage(t);

  // The worker answers 503 for exactly this reason: nobody deleted this
  // document. Swallowing it into an absent document tells a person their
  // memory is gone and sends them looking for who took it.
  assert.doesNotMatch(text, /This document is no longer stored/);
  assert.match(text, /could not be read/);
  assert.match(text, /Built-in memory could not answer: db down/);
  // The listing answered, so the table is still the listing.
  assert.doesNotMatch(text, /Memory could not be read/);
});

test("a provider with no enumerable store is not a deletion either", async (t) => {
  answers = {
    "/api/v1/memory": LISTING,
    [`/api/v1/memory?subjectKey=${encodeURIComponent(SUBJECT_KEY)}&docPath=${encodeURIComponent(DOC_PATH)}`]:
      providerRefused(501, "Recall Engine keeps this deployment's memory and cannot list what it holds"),
    "/api/v1/settings": { settings: [] },
  };

  const text = await renderPage(t);

  assert.doesNotMatch(text, /This document is no longer stored/);
  assert.match(text, /cannot list what it holds/);
});

test("a pair that names nothing still reads as a document that is gone", async (t) => {
  // The positive control. Without it the fix above could have been "never say
  // a document is gone", which loses the one answer the 404 is for.
  answers = {
    "/api/v1/memory": LISTING,
    "/api/v1/settings": { settings: [] },
  };

  const text = await renderPage(t);

  assert.match(text, /This document is no longer stored/);
  assert.doesNotMatch(text, /could not be read/);
});

test("the reason is read from the body, where it survives the trip the reason phrase does not", async (t) => {
  // h3 strips everything outside visible ASCII from the reason phrase, and
  // HTTP/2 has no reason phrase at all, so in production the phrase arrives
  // empty or mangled while the body still carries the whole sentence.
  answers = {
    "/api/v1/memory": providerRefused(
      503,
      "Built-in memory could not answer: the store said \u201Cbusy\u201D",
      "",
    ),
    "/api/v1/settings": { settings: [] },
  };

  const text = await renderPage(t);

  assert.match(text, /Built-in memory could not answer: the store said \u201Cbusy\u201D/);
});
