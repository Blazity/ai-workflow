import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import { Window } from "happy-dom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type { RepositoryCatalogEntry } from "@shared/contracts";

mock.module("../../../components/cockpit/prompt-editor/prompt-editor.tsx", {
  exports: {
    PromptEditor: ({
      value,
      onChange,
      disabled,
    }: {
      value: string;
      onChange: (markdown: string) => void;
      disabled?: boolean;
    }) =>
      React.createElement("textarea", {
        value,
        disabled,
        "data-prompt-editor": true,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChange(event.target.value),
      }),
  },
} as unknown as Parameters<typeof mock.module>[1]);

// Loaded after the prompt-editor mock; this suite exercises the repository
// form in a browser DOM, not Tiptap's own editing implementation.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RepositoryEntryScreen } = require("./repository-entry") as typeof import("./repository-entry");

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
  profileVersion: 0,
  checksVersion: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

test("the rules editor blocks save and names an unknown variable inline", async (t) => {
  const browser = new Window({ url: "http://dashboard.test/repositories/7?tab=rules" });
  const installed = {
    React,
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
  };
  const previous = new Map(
    Object.keys(installed).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(installed)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let unmount: (() => void) | undefined;
  t.after(async () => {
    await act(async () => unmount?.());
    await browser.happyDOM.waitUntilComplete();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.close();
  });

  const { createRoot } = await import("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host as unknown as Parameters<typeof createRoot>[0]);
  unmount = () => root.unmount();

  const router = {
    back() {},
    forward() {},
    refresh() {},
    push() {},
    replace() {},
    prefetch: async () => undefined,
  };
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router as never}>
        <PathnameContext.Provider value="/repositories/7">
          <SearchParamsContext.Provider value={new URLSearchParams("tab=rules")}>
            <RepositoryEntryScreen
              repository={REPOSITORY}
              currentProfile={null}
              versions={[]}
              catalog={[REPOSITORY]}
              allowedEnv={[]}
              memory={[]}
              canManage
            />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );
  });

  const editor = host.querySelector("[data-prompt-editor]") as unknown as {
    dispatchEvent: (event: unknown) => boolean;
  } | null;
  assert.ok(editor);
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      browser.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setValue?.call(editor, "Build {{repo_path}}, then notify {{reviewer_name}}.");
    editor.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });

  const alert = host.querySelector("[role=alert]") as unknown as {
    textContent: string | null;
  } | null;
  assert.equal(
    alert?.textContent,
    "Unknown repository rules variable: {{reviewer_name}}. Allowed variables: ticket_key, ticket_url, branch_name, repo_path, repo_default_branch.",
  );
  const save = [...host.querySelectorAll("button")]
    .map((button) => button as unknown as { textContent: string | null; disabled: boolean })
    .find((button) => button.textContent?.trim() === "Save changes");
  assert.equal(save?.disabled, true);
  assert.equal(host.querySelector("[aria-label=Rules]")?.getAttribute("aria-invalid"), "true");
});
