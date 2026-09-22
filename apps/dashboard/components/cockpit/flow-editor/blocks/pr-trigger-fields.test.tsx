import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { integrationsProviding } from "@integrations/registry";
import type { WorkflowParamValue } from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { installTestDom } from "@/components/ui/test-dom";
import { PrProvidersField } from "./pr-trigger-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** What the registry says, read independently of the component under test. */
const SHIPPED = integrationsProviding("vcs");

function node(providers: WorkflowParamValue | undefined): FlowNodeDef {
  return {
    id: "trigger",
    type: "trigger_pr_created",
    params: providers === undefined ? {} : { providers },
  } as unknown as FlowNodeDef;
}

function render(providers: WorkflowParamValue | undefined, canEdit = true) {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const writes: unknown[] = [];
  let root: Root | undefined;
  act(() => {
    root = createRoot(container);
    root.render(
      <PrProvidersField
        node={node(providers)}
        canEdit={canEdit}
        onChange={(path, value) => writes.push([path, value])}
      />,
    );
  });
  const checkbox = (label: string) => {
    const match = Array.from(container.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    const input = match?.querySelector<HTMLInputElement>("input[type=checkbox]");
    assert.ok(input, `no checkbox labelled ${label}`);
    return input;
  };
  const button = (name: string) => {
    const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
    );
    assert.ok(match, `no button named ${name}`);
    return match;
  };
  const cleanup = () => {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  };
  return { container, writes, checkbox, button, cleanup };
}

test("an author picks the trigger's providers from what this build ships, by name", () => {
  // The field used to be a free-text list of ids: an author had to know that
  // GitLab is spelled `gitlab` here, and a typo stored a provider that never
  // matches, so the trigger went quiet with nothing on screen to say why.
  assert.ok(SHIPPED.length >= 2, "the registry ships at least two version control providers");
  const view = render([]);
  try {
    for (const manifest of SHIPPED) {
      assert.equal(view.checkbox(manifest.name).checked, false);
    }
    assert.equal(view.container.querySelector("textarea"), null);
  } finally {
    view.cleanup();
  }
});

test("nothing picked still means every connected provider, and the field says so", () => {
  const view = render(undefined);
  try {
    assert.match(view.container.textContent ?? "", /any connected provider/);
  } finally {
    view.cleanup();
  }
});

test("ticking a provider stores its id, and unticking the last one goes back to every provider", () => {
  const [first] = SHIPPED;
  const view = render([]);
  try {
    act(() => view.checkbox(first!.name).click());
    assert.deepEqual(view.writes.at(-1), ["params.providers", [first!.id]]);
  } finally {
    view.cleanup();
  }

  const picked = render([first!.id]);
  try {
    assert.equal(picked.checkbox(first!.name).checked, true);
    assert.equal(picked.checkbox(first!.name).disabled, false);
    act(() => picked.checkbox(first!.name).click());
    assert.deepEqual(picked.writes.at(-1), ["params.providers", []]);
  } finally {
    picked.cleanup();
  }
});

test("a stored provider this build does not ship stays visible and is removed only on purpose", () => {
  // A definition written on a build with one more provider, or by hand
  // through the API. Dropping the id quietly on the next toggle would change
  // what the trigger admits behind the author's back; hiding it would leave a
  // trigger that never fires with nothing on screen to explain it.
  const [first] = SHIPPED;
  const view = render(["bitbucket"]);
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /bitbucket/);
    assert.match(text, /Unknown provider/);
    assert.match(text, /never fires/);

    act(() => view.checkbox(first!.name).click());
    assert.deepEqual(view.writes.at(-1), ["params.providers", ["bitbucket", first!.id]]);

    act(() => view.button("Remove bitbucket").click());
    assert.deepEqual(view.writes.at(-1), ["params.providers", []]);
  } finally {
    view.cleanup();
  }
});

test("a reader who cannot edit sees the choice and cannot change it", () => {
  const [first] = SHIPPED;
  const view = render([first!.id, "bitbucket"], false);
  try {
    assert.equal(view.checkbox(first!.name).disabled, true);
    assert.equal(view.button("Remove bitbucket").disabled, true);
  } finally {
    view.cleanup();
  }
});
