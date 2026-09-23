// apps/dashboard/app/(cockpit)/repositories/[id]/repository-data.test.tsx
//
// What the repository page's Memory tab asks the worker for, and what it says
// when the worker's memory provider cannot answer. The listing is the only
// source of which documents exist: a provider keeps documents under names it
// chooses, so a page that names a document itself reads, and offers to erase,
// something the provider never said it holds.
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type {
  MemoryDocumentSummaryDto,
  RepositoryCatalogEntry,
  RepositoryProfileVersion,
} from "@shared/contracts";
import type { DashboardSession } from "@/lib/auth/session";

import { WorkerResponseError } from "../../../../lib/api/worker-errors.ts";

const REPOSITORY: RepositoryCatalogEntry = {
  id: 7,
  provider: "github",
  path: "acme/web",
  displayName: "Web",
  defaultBranch: "main",
  description: "The storefront.",
  rules: "",
  relationships: [],
  enabled: true,
  source: "imported",
  profileVersion: 3,
  checksVersion: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const PROFILE = {
  version: 3,
  description: "The storefront.",
  rules: "",
  relationships: [],
  scriptGroups: null,
  gateGroups: null,
  batchTimeoutMinutes: null,
  checksVersion: 2,
  actorLabel: "Someone",
  reason: "first",
  createdAt: "2026-09-02T00:00:00.000Z",
} as unknown as RepositoryProfileVersion;

const SUBJECT = "repo:github:acme/web";

const SESSION: DashboardSession = {
  organizationName: "Acme",
  actorLabel: "filip",
  role: "owner",
  canManageUsers: true,
  canEditChecks: true,
  canEditWorkflows: true,
  canDispatchWorkflows: true,
};

function listed(subjectKey: string, docPath: string): MemoryDocumentSummaryDto {
  return {
    subjectKey,
    docPath,
    ticketKey: null,
    bytes: 10,
    sourceRunId: "run_1",
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
  };
}

function readPath(subjectKey: string, docPath: string): string {
  return `/api/v1/memory?${new URLSearchParams({ subjectKey, docPath }).toString()}`;
}

function stored(subjectKey: string, docPath: string, content: string) {
  return {
    document: {
      subjectKey,
      docPath,
      bytes: content.length,
      sourceRunId: "run_1",
      updatedAt: "2026-09-20T10:00:00.000Z",
      content,
    },
  };
}

/** What getJSON throws for a refusal, with the body Nitro writes for an h3 error. */
function providerRefused(status: number, reason: string): () => never {
  return () => {
    throw new WorkerResponseError("/api/v1/memory", status, reason, {
      error: true,
      statusCode: status,
      statusMessage: reason,
      message: reason,
    });
  };
}

/** What getJSON answers per path. A function throws, a value resolves, and a
 *  path nobody answered is a 404, which is what the worker says of a pair
 *  that names nothing. */
let answers: Record<string, unknown | (() => never)> = {};
/** Every path the page asked the worker for, in order. */
let asked: string[] = [];

mock.module("../../../../lib/auth/session.ts", {
  exports: { requireSession: async () => SESSION },
} as unknown as Parameters<typeof mock.module>[1]);

mock.module("../../../../lib/api/server.ts", {
  exports: {
    withQuery: (path: string, params: Record<string, string | undefined>) => {
      const sp = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value) sp.set(key, value);
      const query = sp.toString();
      return query ? `${path}?${query}` : path;
    },
    getJSON: async (path: string) => {
      asked.push(path);
      const answer = answers[path];
      if (typeof answer === "function") (answer as () => never)();
      if (answer === undefined) {
        throw new WorkerResponseError(path, 404, "Not Found", {
          error: true,
          statusCode: 404,
          statusMessage: "Not Found",
          message: "Not Found",
        });
      }
      return answer;
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);

// Tiptap needs a DOM this runner does not have; the Memory tab never shows it.
mock.module("../../../../components/cockpit/prompt-editor/prompt-editor.tsx", {
  exports: { PromptEditor: () => null },
} as unknown as Parameters<typeof mock.module>[1]);

// require, not a top-level import: this package transpiles to CommonJS and the
// page has to load AFTER the mocks are registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RepositoryData } = require("./repository-data") as typeof import("./repository-data");

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

/** The answers every render needs besides memory. */
function withRepository(memory: Record<string, unknown | (() => never)>) {
  return {
    "/api/v1/repository-catalog/7": { repository: REPOSITORY, currentProfile: PROFILE },
    "/api/v1/repository-catalog/7/versions": { versions: [PROFILE], hasMore: false },
    "/api/v1/repository-catalog": { repositories: [REPOSITORY] },
    "/api/v1/pre-pr-checks": { allowedEnv: [] },
    ...memory,
  };
}

/** Renders the page as Next would, on its Memory tab: await the server
 *  component, then mount what it returned. */
async function renderMemoryTab(t: TestContext): Promise<string> {
  const element = await RepositoryData({ id: 7 });
  // The screen's unsaved-work guard listens on window; the runner has none.
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    history: { replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={ROUTER as never}>
        <PathnameContext.Provider value="/repositories/7">
          <SearchParamsContext.Provider value={new URLSearchParams("tab=memory")}>
            {element}
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  return nodeText(renderer.root);
}

/** The single-document reads the page made, as `docPath`s under their subject. */
function documentReads(): string[] {
  return asked
    .filter((path) => path.startsWith("/api/v1/memory?"))
    .map((path) => {
      const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      return `${params.get("subjectKey")} ${params.get("docPath")}`;
    });
}

test.beforeEach(() => {
  asked = [];
});

test("reads exactly the documents the listing holds for this repository, by the pair it listed", async (t) => {
  // The provider keeps `conventions` and `facts` for this repository and no
  // `lessons`. Other subjects' documents are in the same listing.
  answers = withRepository({
    "/api/v1/memory": {
      complete: true,
      documents: [
        listed(SUBJECT, "facts"),
        listed("repo:github:acme/api", "lessons"),
        listed(SUBJECT, "conventions"),
        listed("ticket:jira:AIW-1", "ai-workflow/memory/AIW-1.md"),
      ],
    },
    [readPath(SUBJECT, "facts")]: stored(SUBJECT, "facts", "The storefront runs on Next.js."),
    [readPath(SUBJECT, "conventions")]: stored(SUBJECT, "conventions", "Branches start with feat/."),
  });

  const text = await renderMemoryTab(t);

  assert.deepEqual(documentReads(), [`${SUBJECT} conventions`, `${SUBJECT} facts`]);
  assert.match(text, /The storefront runs on Next\.js\./);
  assert.match(text, /Branches start with feat\/\./);
  assert.doesNotMatch(text, /lessons/);
});

test("asks for no document when the listing holds none for this repository", async (t) => {
  answers = withRepository({
    "/api/v1/memory": { complete: true, documents: [listed("repo:github:acme/api", "facts")] },
  });

  const text = await renderMemoryTab(t);

  assert.deepEqual(documentReads(), []);
  assert.match(text, /Nothing recorded yet\./);
});

test("a provider that is away shows memory as not available right now, and what to do", async (t) => {
  answers = withRepository({
    "/api/v1/memory": providerRefused(503, "Recall Engine could not answer: socket hang up"),
  });

  const text = await renderMemoryTab(t);

  assert.match(text, /Memory is not available right now/);
  assert.match(text, /Recall Engine could not answer: socket hang up/);
  assert.match(text, /Reload the page to try again/);
  // Never the empty state: that tells a person the agent forgot this repository.
  assert.doesNotMatch(text, /Nothing recorded yet/);
  assert.deepEqual(documentReads(), []);
  // The rest of the page is still there to edit.
  assert.match(text, /Overview/);
});

test("a provider that cannot list says reloading will not help", async (t) => {
  answers = withRepository({
    "/api/v1/memory": providerRefused(
      501,
      "Recall Engine keeps this deployment's memory and cannot list what it holds, so it cannot be browsed here. Read and erase it where that provider keeps it.",
    ),
  });

  const text = await renderMemoryTab(t);

  assert.match(text, /Memory cannot be browsed here/);
  assert.match(text, /Read and erase it where that provider keeps it\./);
  assert.match(text, /Reloading will not change this/);
  assert.doesNotMatch(text, /Nothing recorded yet/);
});

test("one read the provider could not answer is said on that document, not as erased", async (t) => {
  answers = withRepository({
    "/api/v1/memory": { complete: true, documents: [listed(SUBJECT, "facts")] },
    [readPath(SUBJECT, "facts")]: providerRefused(503, "Built-in memory could not answer: db down"),
  });

  const text = await renderMemoryTab(t);

  assert.match(text, /Could not be read right now: Built-in memory could not answer: db down/);
  assert.doesNotMatch(text, /No longer stored/);
});

test("a listing that may be partial says so, so absence is not read as proof", async (t) => {
  answers = withRepository({
    "/api/v1/memory": { complete: false, documents: [listed("repo:github:acme/api", "facts")] },
  });

  const text = await renderMemoryTab(t);

  assert.match(text, /may be stored without appearing here/);
});
