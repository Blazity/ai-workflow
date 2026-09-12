// apps/dashboard/components/cockpit/flow-editor/deploy-pin-warning.matrix.test.tsx
//
// The deploy badge had no test of any kind (matrix row U14).
//
// The row is about a keyboard trap that is not one: `deploy-pin-warning.tsx`
// announces a refusal that is about to happen, and it is a static
// `role="status"` with the detail hidden in a `title` attribute. A keyboard or
// screen-reader user who hears the badge has nothing to press on it; the thing
// they must reach is the picker, which is a real `role="dialog"` with
// `aria-modal`, a focus trap and Escape. So the assertion is in two parts: the
// badge says the right thing and offers NOTHING to focus, and the bar it sits
// in puts a real focusable control next to it that opens the dialog.
//
// WHAT THIS RUNNER CANNOT PROVE. There is no DOM here: nothing focuses, nothing
// tabs, no keydown fires. "Focus reaches the modal" is asserted as far as
// static markup can carry it -- an `aria-haspopup="dialog"` button exists, is
// enabled, and the dialog it opens declares `role="dialog"` and
// `aria-modal="true"` -- and no further. Whether Tab actually lands there, and
// whether the trap holds, needs a browser. The badge's half IS fully provable
// here, because "offers nothing to focus" is a statement about the markup.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RepositoryOption, WorkflowRepositoryScope } from "@shared/contracts";
import { pinnedRepositoriesNotEnabledSentence } from "@shared/contracts";

import {
  RepositoryCatalogProvider,
  type RepositoryPickerOption,
} from "./repository-catalog-context";
import { DeployPinWarning } from "./deploy-pin-warning";
import { RepositoryScopeBar } from "./repository-scope-bar";
import { RepositoryScopeModal } from "./repository-scope-modal";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function option(overrides: Partial<RepositoryPickerOption> = {}): RepositoryPickerOption {
  return {
    provider: "github",
    repoPath: "Blazity/ai-workflow",
    name: "ai-workflow",
    owner: "Blazity",
    defaultBranch: "main",
    private: true,
    archived: false,
    enabledInCatalog: true,
    ...overrides,
  } as RepositoryPickerOption;
}

/** A workflow pinned to one repository the activated catalog does not hold. */
const PINNED_ELSEWHERE: WorkflowRepositoryScope = {
  repositories: [{ provider: "github", repoPath: "Blazity/not-in-catalog" }],
};

function renderWarning(
  scope: WorkflowRepositoryScope,
  options: { activated?: boolean; repositories?: RepositoryOption[] } = {},
): string {
  return renderToStaticMarkup(
    <RepositoryCatalogProvider
      initial={{
        status: "ready",
        activated: options.activated ?? true,
        repositories: (options.repositories as RepositoryPickerOption[]) ?? [option()],
      }}
    >
      <DeployPinWarning scope={scope} />
    </RepositoryCatalogProvider>,
  );
}

test("U14: the badge names how many pins are refused and carries the shared sentence", () => {
  const html = renderWarning(PINNED_ELSEWHERE);

  assert.match(html, /role="status"/);
  assert.match(html, /1 pinned repository not enabled in the catalog/);
  // The detail is the ONE sentence, shared with workflows.publish and the
  // deploy confirmation, so the editor and an agent publishing over MCP say the
  // same thing in the same words. Compared against the function rather than a
  // copy of its output, so a wording change moves both or neither.
  const sentence = pinnedRepositoriesNotEnabledSentence(["github:Blazity/not-in-catalog"]);
  assert.ok(
    html.includes(sentence.replace(/&/g, "&amp;").replace(/</g, "&lt;")),
    `the badge's title is not the shared sentence; got ${html}`,
  );
});

test("U14: the badge offers nothing to focus, so the affordance has to be elsewhere", () => {
  const html = renderWarning(PINNED_ELSEWHERE);

  // No button, no link, no tabindex, no onclick handler rendered. This is not a
  // defect to fix here: a status line that swallowed Tab would announce itself
  // twice and lead nowhere. It IS a fact the next person changing this file has
  // to know, because "add a click handler to the badge" is the obvious change
  // and it would leave keyboard users with an unreachable control.
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /tabindex=/i);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("U14: the bar beside it exposes a real focusable control that opens the dialog", () => {
  const html = renderToStaticMarkup(
    <RepositoryCatalogProvider
      initial={{ status: "ready", activated: true, repositories: [option()] }}
    >
      <RepositoryScopeBar
        scope={PINNED_ELSEWHERE}
        canEdit
        onChange={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );

  // A `<button>` (natively focusable, no tabindex needed) that announces what
  // it opens. This is the target the badge is telling somebody to go to.
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, />Configure</);
  // Enabled: a `disabled` ATTRIBUTE, not the `disabled:` Tailwind variant that
  // also appears in the class string of the very same tag.
  assert.doesNotMatch(html, /<button[^>]*aria-haspopup="dialog"[^>]*\sdisabled(=|\s|>)/);
  // Closed, so nothing is trapping focus before anybody asked.
  assert.doesNotMatch(html, /role="dialog"/);
});

test("U14: the dialog it opens declares modal semantics rather than being a styled panel", () => {
  const html = renderToStaticMarkup(
    <RepositoryCatalogProvider
      initial={{ status: "ready", activated: true, repositories: [option()] }}
    >
      <RepositoryScopeModal
        open
        scope={PINNED_ELSEWHERE}
        canEdit
        onApply={() => undefined}
        onCancel={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  // The Escape handler and the Tab trap live in an effect and cannot fire in a
  // static render; what is provable is that the dialog announces itself as
  // modal, which is the contract assistive tech acts on.
});

test("U14: while the bridge is on the badge says nothing, because the refusal has not happened", () => {
  const bridge = renderWarning(PINNED_ELSEWHERE, { activated: false });

  // Deliberate: a deploy button shouting about a refusal that is not in force
  // teaches an operator to ignore it, and the picker row already says the pin
  // is unknown. So the ONLY signal is the activated one.
  assert.equal(bridge, "");
});

test("U14: a pin the catalog enables renders no badge at all", () => {
  const html = renderWarning(
    { repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }] },
    { activated: true },
  );

  assert.equal(html, "");
});
