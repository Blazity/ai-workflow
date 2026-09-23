// apps/dashboard/components/cockpit/screens/workflow-editor.navigation.test.tsx
//
// The workflow editor inside the real cockpit shell: what happens to an unsaved
// graph when the person leaves, and what the address bar says about which
// workflow is open. Both were found on production (QA P1 round 2): a sidebar
// click or the browser's Back threw an unsaved edit away without a word, and a
// refresh after switching workflows opened a different one.
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
  RunBlockStatusesResponse,
  WorkflowBlockContract,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionMeta,
  WorkflowEditorOptions,
} from "@shared/contracts";

import { CockpitShell } from "@/app/(cockpit)/cockpit-shell";
import { resetUnsavedSettings } from "@/lib/settings/unsaved";
import { WorkflowEditorScreen } from "./workflow-editor";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link schedules its prefetch through an idle callback that reads `self`.
(globalThis as { self?: unknown }).self = globalThis;

// ── Environment: what the shell and the editor read of the browser ─────────

let confirmAnswer = true;
const confirmPrompts: string[] = [];
const history = {
  state: { __NA: true } as unknown,
  pushed: [] as Array<string | URL | null | undefined>,
  pushState(data: unknown, _unused: string, url?: string | URL | null) {
    this.pushed.push(url);
    this.state = data;
  },
};
const locationStub = { href: "http://localhost/editor?definition=7" };
const popstateListeners = new Set<(event: Event) => void>();

(globalThis as unknown as { document: unknown }).document = {
  visibilityState: "visible",
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { style: {}, appendChild: () => {}, removeChild: () => {} },
  documentElement: { style: {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
};
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    addEventListener: (event: string, cb: (event: Event) => void) => {
      if (event === "popstate") popstateListeners.add(cb);
    },
    removeEventListener: (event: string, cb: (event: Event) => void) => {
      if (event === "popstate") popstateListeners.delete(cb);
    },
    dispatchEvent: () => true,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
      clear() {},
      key: () => null,
      length: 0,
    },
    history,
    location: locationStub,
    confirm: (message: string) => {
      confirmPrompts.push(message);
      return confirmAnswer;
    },
  },
});

// ── Fixtures: two deployed v2 workflows ─────────────────────────────────────

const seed = {
  schemaVersion: 2 as const,
  nodes: [
    {
      id: "trigger",
      type: "trigger_ticket_ai" as const,
      x: 0,
      y: 0,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [],
};
const triggerContract = {
  type: "trigger_ticket_ai",
  presentation: {
    group: "trigger",
    label: "Ticket",
    description: "Ticket trigger",
    color: "#123456",
    softColor: "#eef0f2",
    glyph: "T",
  },
  defaults: {},
  ports: ["next"],
  allowsFailurePort: false,
  inputs: {},
  additionalInputs: [],
  output: {
    schema: { type: "unknown" },
    bindingSchema: { type: "unknown" },
    statusVariants: ["ok"],
  },
  availability: { available: true, unavailableReason: null },
} satisfies WorkflowBlockContract;

function detail(id: number, name: string): WorkflowDefinitionDetailResponse {
  const version = {
    definitionId: id,
    version: 3,
    createdAt: "2026-09-10T00:00:00.000Z",
    createdById: "admin",
    createdByLabel: "Admin",
    restoredFromVersion: null,
    schema: "v2" as const,
    definition: seed,
  };
  return {
    meta: {
      id,
      name,
      enabled: false,
      deployedSchema: "v2",
      triggerTypes: [],
      currentVersion: 3,
      draftRevision: 1,
      layoutRevision: 1,
      deployedVersion: 3,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    } as unknown as WorkflowDefinitionMeta,
    draft: seed,
    layout: { nodes: { trigger: { x: 0, y: 0 } }, edges: {} },
    deployed: version,
    current: version,
    versions: [version],
  } as unknown as WorkflowDefinitionDetailResponse;
}

const QA_WORKFLOW = detail(52, "[QA] arthur availability");
const DEFAULT_WORKFLOW = detail(14, "Default ticket workflow");

// ── Harness ─────────────────────────────────────────────────────────────────

interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/** Answers every read the editor makes, a turn later, and counts what is out. */
function installFetch(): void {
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    mine.inFlight += 1;
    mine.started += 1;
    const answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(Number(process.env.FIXTURE_SLOW_MS ?? 0), 0)));
      if (url.endsWith("/api/workflow-definitions/14")) return Response.json(DEFAULT_WORKFLOW);
      if (url.endsWith("/api/workflow-definitions/52")) return Response.json(QA_WORKFLOW);
      if (url.includes("/validate")) {
        return Response.json({ valid: true, issues: [], nodeContracts: {}, availableValuesByNode: {} });
      }
      if (url.includes("/catalog")) return Response.json({ nodeContracts: {}, catalogByNode: {} });
      return Response.json({ profiles: [], repositories: [] });
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  });
}

async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Waits for the editor's chain of reads to go quiet: nothing in flight, and a
 *  turn that started nothing new. Bounded by wall clock, never by a count. */
async function settle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (reads.inFlight === 0) {
      const started = reads.started;
      await turn();
      if (reads.inFlight === 0 && reads.started === started) return;
    }
    if (Date.now() >= deadline) assert.fail(`the editor was still loading after ${timeoutMs} ms`);
  }
}

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map(textOf).join("");
}

function button(root: ReactTestInstance, label: RegExp): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button").find((node) => label.test(textOf(node)));
  assert.ok(found, `button not found: ${label}`);
  return found;
}

interface Mounted {
  root: ReactTestInstance;
  pushes: string[];
  replacements: string[];
  /** Hands the editor what the server renders for the address it now has. */
  serverRenders: (detail: WorkflowDefinitionDetailResponse) => Promise<void>;
}

async function mountEditor(
  t: TestContext,
  initial: WorkflowDefinitionDetailResponse = QA_WORKFLOW,
): Promise<Mounted> {
  confirmAnswer = true;
  confirmPrompts.length = 0;
  history.pushed.length = 0;
  locationStub.href = `http://localhost/editor?definition=${initial.meta.id}`;
  resetUnsavedSettings();
  installFetch();
  const pushes: string[] = [];
  const replacements: string[] = [];
  const router = {
    refresh: () => {},
    push: (href: string) => pushes.push(href),
    replace: (href: string) => replacements.push(href),
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  const session = {
    organizationName: "Org",
    actorLabel: "admin@blazity.com",
    role: "owner",
    canManageUsers: true,
    canEditChecks: true,
    canEditWorkflows: true,
    canDispatchWorkflows: true,
  };
  const tree = (detailResponse: WorkflowDefinitionDetailResponse) => (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/editor">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <CockpitShell session={session as never}>
            <WorkflowEditorScreen
              definitions={[DEFAULT_WORKFLOW.meta, QA_WORKFLOW.meta]}
              templates={[]}
              initialDetail={detailResponse}
              defaultDefinition={seed}
              options={{ blockRegistry: { trigger_ticket_ai: triggerContract } } as unknown as WorkflowEditorOptions}
              liveBlocks={{ generatedAt: "2026-09-10T00:00:00.000Z", run: null } satisfies RunBlockStatusesResponse}
              canEdit
              canDispatch={false}
              actorLabel="admin@blazity.com"
            />
          </CockpitShell>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(initial));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    mock.restoreAll();
    resetUnsavedSettings();
  });
  await settle();
  return {
    root: renderer.root,
    pushes,
    replacements,
    serverRenders: async (next) => {
      await act(async () => renderer.update(tree(next)));
      await settle();
    },
  };
}

/** Changes the run duration limit, the edit QA made on definition 53. */
async function editDuration(root: ReactTestInstance): Promise<void> {
  const duration = root.findAllByType("input").find((input) => input.props.type === "number");
  assert.ok(duration, "the execution limits bar offers a duration field");
  await act(async () => {
    duration.props.onChange({ target: { value: "5" } });
  });
  assert.match(textOf(root), /Unsaved changes/);
}

function navigateTo(root: ReactTestInstance, id: string): void {
  const sidebar = root.findAll(
    (node) => typeof node.type === "function" && (node.type as { name?: string }).name === "CkSidebar",
  )[0];
  assert.ok(sidebar, "expected the desktop sidebar");
  act(() => {
    sidebar.props.onNav(id);
  });
}

function pressBrowserBack(): { reachedRouter: boolean } {
  locationStub.href = "http://localhost/runs";
  let stopped = false;
  const event = { stopImmediatePropagation: () => { stopped = true; } } as unknown as Event;
  act(() => {
    for (const listener of popstateListeners) if (!stopped) listener(event);
  });
  return { reachedRouter: !stopped };
}

// ── Leaving with an unsaved graph ───────────────────────────────────────────

// Red when: the editor guards only the document's own unload and never tells
// the cockpit it holds unsaved work, so the shell's navigation and its Back
// guard let the edit go without asking.
test("a sidebar link away from an unsaved workflow asks first, and no keeps the edit", async (t) => {
  const { root, pushes } = await mountEditor(t);
  await editDuration(root);

  confirmAnswer = false;
  navigateTo(root, "runs");
  assert.deepEqual(confirmPrompts, ["Discard unsaved changes?"]);
  assert.deepEqual(pushes, [], "the navigation would have thrown the edit away");
  assert.match(textOf(root), /Unsaved changes/);

  confirmAnswer = true;
  navigateTo(root, "runs");
  assert.deepEqual(pushes, ["/runs"]);
});

test("the browser's Back from an unsaved workflow asks, and no stays on the editor", async (t) => {
  const { root } = await mountEditor(t);
  await editDuration(root);

  confirmAnswer = false;
  const back = pressBrowserBack();
  assert.deepEqual(confirmPrompts, ["Discard unsaved changes?"]);
  assert.equal(back.reachedRouter, false);
  assert.deepEqual(history.pushed, ["http://localhost/editor?definition=52"]);
});

test("a workflow with nothing unsaved is left without a question", async (t) => {
  const { root, pushes } = await mountEditor(t);
  navigateTo(root, "runs");
  assert.deepEqual(confirmPrompts, []);
  assert.deepEqual(pushes, ["/runs"]);
  assert.equal(pressBrowserBack().reachedRouter, true);
  assert.deepEqual(confirmPrompts, []);
});

test("an edit undone is nothing to ask about", async (t) => {
  const { root, pushes } = await mountEditor(t);
  await editDuration(root);
  await act(async () => {
    button(root, /^Undo$/).props.onClick();
  });
  navigateTo(root, "runs");
  assert.deepEqual(confirmPrompts, []);
  assert.deepEqual(pushes, ["/runs"]);
});

// ── The address names the open workflow ─────────────────────────────────────

// Red when: switching workflows leaves the address as it was, so a refresh, a
// shared link or the reload "Draft changed; reload before saving" asks for
// opens whichever workflow the old address named.
test("switching workflows puts the open one in the address", async (t) => {
  const { root, replacements, serverRenders } = await mountEditor(t);
  assert.deepEqual(replacements, [], "the address already names the workflow it opened");

  act(() => {
    button(root, /\[QA\] arthur availability\s*2 ▾/).props.onClick();
  });
  await act(async () => {
    button(root, /^Default ticket workflow/).props.onClick();
  });
  await settle();
  assert.match(textOf(root), /Default ticket workflow/);
  assert.deepEqual(replacements, ["/editor?definition=14"]);

  // The server renders the new address; the editor keeps what it has and asks
  // for nothing more.
  await serverRenders(DEFAULT_WORKFLOW);
  assert.deepEqual(replacements, ["/editor?definition=14"]);
});

test("an address that stops naming the open workflow is put back", async (t) => {
  // Re-selecting the editor in the sidebar navigates to a bare /editor, whose
  // server render is the default workflow, while the screen keeps the one open.
  const { root, replacements, serverRenders } = await mountEditor(t);
  await editDuration(root);
  await serverRenders(DEFAULT_WORKFLOW);
  assert.deepEqual(replacements, ["/editor?definition=52"]);
  assert.match(textOf(root), /\[QA\] arthur availability/);
  assert.match(textOf(root), /Unsaved changes/, "the edit is still there");
});
