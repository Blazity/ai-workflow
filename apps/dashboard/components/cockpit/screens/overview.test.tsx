import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { Run } from "@/lib/types";
import { AwaitingInputPanel } from "./overview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link schedules its prefetch through an idle callback that reads `self`,
// which node does not define. Without it every render of a row link throws.
(globalThis as { self?: unknown }).self = globalThis;

const BASE_RUN: Run = {
  id: "run_1",
  workflow: "wf_agent",
  workflowName: "Agent",
  status: "awaiting",
  ticket: "AWT-1",
  actor: "ai-bot",
  model: "claude-opus-4-8",
  startedAtMin: 30,
  duration: null,
  tokens: null,
  cost: null,
  spans: null,
  evalScore: null,
  guardrailHits: null,
  ticketTitle: "Ship it",
  prNumber: null,
  ticketUrl: "https://blazity.atlassian.net/browse/AWT-1",
  prUrl: null,
  prs: null,
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

/** Minimal app router: AwaitingInputPanel never navigates through it directly
 *  (the approval CTA is a next/link `<Link>`), but next/link needs the context
 *  to exist at all. */
function stubRouter() {
  return {
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
}

function renderPanel(t: TestContext, rows: Run[]): { root: ReactTestInstance; opened: Run[] } {
  const opened: Run[] = [];
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter() as never}>
        <AwaitingInputPanel rows={rows} onOpenRun={(r) => opened.push(r)} />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
  });
  return { root: renderer.root, opened };
}

test("a clarification row keeps its Answer CTA to the run trace, unchanged", (t) => {
  const row: Run = {
    ...BASE_RUN,
    question: "1. Which environment?",
    suggestedAnswers: ["staging"],
    askedAtMin: 5,
  };
  const { root, opened } = renderPanel(t, [row]);

  const links = root.findAll((n) => n.type === "a").map((n) => String(n.props.href ?? ""));
  assert.deepEqual(links.filter((href) => href === "/approvals"), []);

  const answerButtons = root
    .findAll((n) => n.type === "button")
    .filter((n) => nodeText(n).includes("Answer"));
  assert.equal(answerButtons.length, 1);

  act(() => {
    answerButtons[0].props.onClick();
  });
  assert.deepEqual(opened, [row]);
  assert.match(nodeText(root), /Which environment\?/);
});

test("an approval-parked row gets a Review plan link to /approvals, not the Answer dead end", (t) => {
  const row: Run = {
    ...BASE_RUN,
    awaitingKind: "approval",
    approvalId: "ap_1",
  };
  const { root } = renderPanel(t, [row]);

  const text = nodeText(root);
  assert.match(text, /Review plan/);
  assert.doesNotMatch(text, /Answer →/);

  const approvalLinks = root
    .findAll((n) => n.type === "a")
    .filter((n) => n.props.href === "/approvals");
  assert.equal(approvalLinks.length, 1);

  // The null question must never render as if it were a clarification.
  assert.doesNotMatch(text, /undefined/);
});
