import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PrePrCheckConfig, PrePrChecksResponse, PrePrCheckConfigVersion } from "@shared/contracts";
import { RepositoryScriptsScreen, looksLikeInstallCommand } from "./repository-scripts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      setup: ["make bootstrap"],
      env: ["MY_TOKEN"],
      groups: {
        checks: { commands: ["pnpm test"], restoreTree: false },
        lint: { commands: ["pnpm lint"] },
      },
      gateGroups: ["checks"],
      commandTimeoutMinutes: 10,
    },
    {
      provider: "gitlab",
      repoPath: "acme/legacy",
      commands: ["make check"],
    },
  ],
  batchTimeoutMinutes: 45,
};

function versionOf(config: PrePrCheckConfig, version: number): PrePrCheckConfigVersion {
  return {
    version,
    config,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdById: "u1",
    createdByLabel: "Filip",
    restoredFromVersion: null,
  };
}

function initialOf(config: PrePrCheckConfig): PrePrChecksResponse {
  return { current: versionOf(config, 1), versions: [versionOf(config, 1)] };
}

const INITIAL: PrePrChecksResponse = initialOf(CONFIG);

/** One repository, two groups, no gateGroups: the "every group runs at the
 *  gate" default the shared CONFIG fixture does not cover. */
const DEFAULT_GATE_CONFIG: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      groups: { checks: { commands: ["pnpm test"] }, lint: { commands: ["pnpm lint"] } },
    },
  ],
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

function buttons(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root
    .findAll((node) => node.type === "button")
    .filter((node) => nodeText(node).includes(text));
}

function button(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = buttons(root, text);
  assert.equal(matches.length, 1, `expected exactly one button containing "${text}"`);
  return matches[0];
}

function saveButton(root: ReactTestInstance): ReactTestInstance {
  return root.findAll((node) => node.type === "button" && nodeText(node).includes("Save changes"))[0];
}

type FetchCall = { url: string; init: RequestInit | undefined };

/** Renders the screen with a stubbed global fetch so Save is observable
 *  without a browser. `respond` builds the PUT response from the submitted
 *  body, defaulting to an echo that stores exactly what was submitted (the
 *  worker's own "stores verbatim" contract). */
function renderScreen(
  t: TestContext,
  respond: (body: unknown) => Response = (body) => {
    const config = (body as { config: PrePrCheckConfig }).config;
    return Response.json({ version: versionOf(config, 2) });
  },
  initial: PrePrChecksResponse = INITIAL,
): { root: ReactTestInstance; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(init?.body ? JSON.parse(String(init.body)) : undefined);
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={initial} canEdit />);
  });
  t.after(() => {
    act(() => renderer.unmount());
  });
  return { root: renderer.root, calls };
}

/** Renders the screen over an arbitrary starting config, for the group shapes
 *  the shared CONFIG fixture does not cover. No fetch stub: these assert on
 *  what renders, not on Save's wire payload. */
function renderConfig(t: TestContext, config: PrePrCheckConfig): ReactTestInstance {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={initialOf(config)} canEdit />);
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

/** The name field of every group card, in render order. Only an expanded card
 *  has one, so callers open every card they are about to compare. */
function groupNameInputs(root: ReactTestInstance): ReactTestInstance[] {
  return root
    .findAll(
      (node) =>
        typeof node.type === "function" && (node.type as { name?: string }).name === "GroupCard",
    )
    .map((card) => card.findAll((node) => node.type === "input")[0]);
}

function repoCards(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    (node) => typeof node.type === "function" && (node.type as { name?: string }).name === "RepoCard",
  );
}

function repoCard(root: ReactTestInstance, repoPath: string): ReactTestInstance {
  const card = repoCards(root).find((c) => c.props.repo.repoPath === repoPath);
  assert.ok(card, `expected a repository card for ${repoPath}`);
  return card;
}

/** The one header button that opens or closes a card or a secondary section. */
function toggleOf(node: ReactTestInstance): ReactTestInstance {
  const header = node.findAll(
    (n) => n.type === "button" && n.props["aria-expanded"] !== undefined,
  )[0];
  assert.ok(header, "expected a collapse toggle");
  return header;
}

/** Repository cards, group cards and the three secondary sections all start
 *  collapsed (a lone repository aside), so a test that reaches inside one
 *  opens it first. */
function expandRepo(root: ReactTestInstance, repoPath: string): void {
  act(() => {
    toggleOf(repoCard(root, repoPath)).props.onClick();
  });
}

function expandGroup(root: ReactTestInstance, name: string): void {
  act(() => {
    toggleOf(root.findByProps({ name })).props.onClick();
  });
}

function expandSection(root: ReactTestInstance, label: string): void {
  const header = root
    .findAll((n) => n.type === "button" && n.props["aria-expanded"] !== undefined)
    .find((n) => nodeText(n).includes(label));
  assert.ok(header, `expected a secondary section header containing "${label}"`);
  act(() => {
    header.props.onClick();
  });
}

/** The one write the screen made. Reads are filtered out rather than counted:
 *  the screen also GETs the repository catalog on mount, and a test about what
 *  Save puts on the wire has no business breaking when a read is added. */
function writes(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.init?.method !== undefined && call.init.method !== "GET");
}

function submittedConfig(calls: FetchCall[]): PrePrCheckConfig {
  const written = writes(calls);
  assert.equal(written.length, 1);
  assert.equal(written[0].url, "/api/pre-pr-checks");
  assert.equal(written[0].init?.method, "PUT");
  return (JSON.parse(String(written[0].init?.body)) as { config: PrePrCheckConfig }).config;
}

test("editing one top-level field sends the whole fetched config back, not a rebuilt subset", async (t) => {
  const { root, calls } = renderScreen(t);

  // The only field this edit touches is the top-level batch timeout.
  const batchTimeoutInput = root.findAll(
    (node) => node.type === "input" && node.props.type === "number" && node.props.value === 45,
  )[0];
  assert.ok(batchTimeoutInput, "expected the batch timeout field seeded with 45");
  act(() => {
    batchTimeoutInput.props.onChange({ target: { value: "60" } });
  });

  assert.equal(saveButton(root).props.disabled, false);
  await act(async () => {
    saveButton(root).props.onClick();
  });

  const sent = submittedConfig(calls);
  assert.equal(sent.batchTimeoutMinutes, 60);
  // Everything untouched, including the fields the old screen used to drop
  // (batchTimeoutMinutes itself) or could not represent (groups, env,
  // gateGroups, restoreTree, per-repo timeout, the legacy repo's commands).
  assert.deepEqual(sent.repositories, CONFIG.repositories);
});

test("editing a nested field leaves every sibling field, including batchTimeoutMinutes, untouched", async (t) => {
  const { root, calls } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandSection(root, "Setup (1 command)");

  const setupInput = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap",
  )[0];
  act(() => {
    setupInput.props.onChange({ target: { value: "make bootstrap-fast" } });
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });

  const sent = submittedConfig(calls);
  assert.equal(sent.batchTimeoutMinutes, 45);
  assert.equal(sent.repositories[0].setup?.[0], "make bootstrap-fast");
  // The rest of the first repository, and the whole legacy second repository,
  // must survive the round trip byte for byte.
  assert.deepEqual(sent.repositories[0].groups, CONFIG.repositories[0].groups);
  assert.deepEqual(sent.repositories[0].env, CONFIG.repositories[0].env);
  assert.deepEqual(sent.repositories[0].gateGroups, CONFIG.repositories[0].gateGroups);
  assert.equal(sent.repositories[0].commandTimeoutMinutes, 10);
  assert.deepEqual(sent.repositories[1], CONFIG.repositories[1]);
});

test("unticking the last gate group stays explicit and blocks Save instead of flipping the mode", async (t) => {
  const { root, calls } = renderScreen(t);
  expandRepo(root, "acme/web");

  const gateChecksBox = () => root.findByProps({ "aria-label": "Gate on group checks" });
  act(() => {
    gateChecksBox().props.onChange({ target: { checked: false } });
  });

  // Falling back to "every group" here used to hide the list and silently gate
  // on everything, which is the opposite of what unticking a box asks for.
  assert.equal(root.findByProps({ "aria-label": "Only the groups I select" }).props.checked, true);
  assert.equal(gateChecksBox().props.checked, false);
  assert.match(nodeText(root), /Save is disabled: acme\/web: gate groups selection is empty\./);

  // The radio is the only way back to the default, and it is what keeps an
  // empty array off the wire: the server refuses one.
  act(() => {
    root.findByProps({ "aria-label": "Every group (default)" }).props.onChange({
      target: { checked: true },
    });
  });
  await act(async () => {
    saveButton(root).props.onClick();
  });
  assert.equal("gateGroups" in submittedConfig(calls).repositories[0], false);
});

test("converting a legacy repository to groups preserves its commands and still round-trips", async (t) => {
  const { root, calls } = renderScreen(t);
  expandRepo(root, "acme/legacy");

  act(() => {
    button(root, "Convert to groups").props.onClick();
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });

  const sent = submittedConfig(calls);
  const legacy = sent.repositories[1];
  assert.equal("commands" in legacy, false);
  assert.deepEqual(legacy.groups, { checks: { commands: ["make check"] } });
  // The other repository and the top-level timeout are untouched by a
  // conversion that only rewrites the second one.
  assert.deepEqual(sent.repositories[0], CONFIG.repositories[0]);
  assert.equal(sent.batchTimeoutMinutes, 45);
});

test("a blank command in a group disables Save and names the blocker instead of failing silently", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");

  // Both groups and the legacy repository share the "Add command" editor;
  // any one of them adding a blank line must invalidate the whole config.
  // The first match is the "checks" group's own Add command button.
  act(() => {
    buttons(root, "Add command")[0].props.onClick();
  });

  assert.equal(saveButton(root).props.disabled, true);
  // The offending row gets its own inline message, and the disabled Save
  // button gets a one-line summary naming the first blocker: neither a grey
  // button nor a silent gate, an operator can act on what they see.
  assert.match(nodeText(root), /Empty command\. Fill it in or remove this row before saving\./);
  assert.match(nodeText(root), /Save is disabled: acme\/web: group "checks": empty command\./);
});

test("a group with no commands and no extends disables Save with its own inline message", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  expandGroup(root, "lint");

  // Give "checks" a fallback path by extending "lint", then strip its own
  // command so it depends entirely on that extends target.
  act(() => {
    root.findByProps({ "aria-label": "Extend lint" }).props.onChange({ target: { checked: true } });
  });
  act(() => {
    root
      .findByProps({ name: "checks" })
      .findAll((node) => node.type === "button" && node.props["aria-label"] === "Remove command")[0]
      .props.onClick();
  });

  // deleteGroup strips the removed group's name out of every sibling's
  // extends list, so deleting "lint" out from under "checks" leaves it with
  // neither commands nor an extends target: exactly the reachable path the
  // review flagged (a blank config nobody's Save button explains).
  // Two clicks: removing a group is confirmed inline (see the removal-confirm
  // test below), so arming and confirming are separate.
  act(() => {
    root
      .findByProps({ name: "lint" })
      .findAll((node) => node.type === "button" && nodeText(node).includes("Remove group"))[0]
      .props.onClick();
  });
  act(() => {
    root
      .findByProps({ name: "lint" })
      .findAll((node) => node.type === "button" && nodeText(node).includes("Confirm remove group"))[0]
      .props.onClick();
  });

  assert.equal(saveButton(root).props.disabled, true);
  assert.match(
    nodeText(root),
    /This group has no commands and does not extend another group, so it will not run\./,
  );
  assert.match(nodeText(root), /Save is disabled: acme\/web: group "checks":/);
});

test("a server rejection on save is surfaced and the config keeps the attempted edit", async (t) => {
  const { root, calls } = renderScreen(t, () =>
    Response.json({ error: "env var name must be SCREAMING_SNAKE_CASE" }, { status: 400 }),
  );
  expandRepo(root, "acme/web");
  expandSection(root, "Setup (1 command)");

  const setupInput = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap",
  )[0];
  act(() => {
    setupInput.props.onChange({ target: { value: "make bootstrap-fast" } });
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });

  assert.equal(writes(calls).length, 1);
  assert.match(nodeText(root), /env var name must be SCREAMING_SNAKE_CASE/);
  const setupInputAfter = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap-fast",
  )[0];
  assert.ok(setupInputAfter, "the failed save must not revert the in-progress edit");
});

test("a network failure on save is surfaced and the config keeps the attempted edit", async (t) => {
  // fetch rejecting (offline, DNS, CORS) rather than resolving with a
  // Response: the save()/restore() try blocks have no Response to read an
  // error out of, so this exercises the catch path renderScreen's stub
  // cannot reach.
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={INITIAL} canEdit />);
  });
  t.after(() => act(() => renderer.unmount()));
  const root = renderer.root;
  expandRepo(root, "acme/web");
  expandSection(root, "Setup (1 command)");

  const setupInput = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap",
  )[0];
  act(() => {
    setupInput.props.onChange({ target: { value: "make bootstrap-fast" } });
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });

  assert.match(
    nodeText(root),
    /Could not reach the server\. Check your connection and try again\./,
  );
  const setupInputAfter = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap-fast",
  )[0];
  assert.ok(setupInputAfter, "a network failure on save must not revert the in-progress edit");
});

test("a network failure on restore is surfaced instead of showing nothing", async (t) => {
  const olderConfig: PrePrCheckConfig = { ...CONFIG, batchTimeoutMinutes: 30 };
  const initial: PrePrChecksResponse = {
    current: versionOf(CONFIG, 2),
    versions: [versionOf(CONFIG, 2), versionOf(olderConfig, 1)],
  };
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={initial} canEdit />);
  });
  t.after(() => act(() => renderer.unmount()));
  const root = renderer.root;

  // Fresh from `initial`, config equals savedConfig, so restore is not
  // gated behind the dirty-discard confirm and goes straight to the
  // network call this test means to fail.
  act(() => {
    root
      .findAll((node) => node.type === "button" && nodeText(node).trim() === "Restore")[0]
      .props.onClick();
  });
  await act(async () => {
    root
      .findAll((node) => node.type === "button" && nodeText(node).includes("Confirm restore"))[0]
      .props.onClick();
  });

  assert.match(
    nodeText(root),
    /Could not reach the server\. Check your connection and try again\./,
  );
});

test("the env editor is absent for a legacy repository and appears after converting to groups", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/legacy");

  // The legacy flat-commands shape is server-side .strict() with no env key,
  // so saving env names on it 400s; the section stays hidden until conversion.
  assert.equal(repoCards(root).length, 2);
  const legacyCard = repoCard(root, "acme/legacy");

  assert.doesNotMatch(nodeText(legacyCard), /Env vars/);
  assert.match(
    nodeText(legacyCard),
    /Older format, still fully supported\. Convert to add env vars, extends and per-group gating\. Conversion cannot be undone here, only through History\./,
  );

  act(() => {
    button(root, "Convert to groups").props.onClick();
  });

  assert.match(nodeText(legacyCard), /Env vars \(none\)/);
  expandSection(root, "Env vars (none)");
  assert.equal(
    legacyCard.findAll(
      (node) => node.type === "button" && nodeText(node).includes("Add env var name"),
    ).length,
    1,
  );
});

test("Add repository surfaces a GitLab 401 by name and still offers manual entry, not a dead end", async (t) => {
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    if (String(url) === "/api/repositories") {
      return Response.json({
        repositories: [],
        providers: [{ provider: "gitlab", status: "error", error: "401 Unauthorized" }],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={INITIAL} canEdit />);
  });
  t.after(() => act(() => renderer.unmount()));
  const root = renderer.root;

  await act(async () => {
    button(root, "+ Add repository").props.onClick();
  });
  await act(async () => {});

  assert.match(
    nodeText(root),
    /gitlab: 401 Unauthorized\. Enter a gitlab repository manually below\./,
  );
  assert.match(
    nodeText(root),
    /No repositories available from a connected provider\. Enter one manually below\./,
  );

  // Manual entry stays reachable regardless of the provider error, rather
  // than only appearing when the whole request throws.
  const manualInput = root.findAll(
    (node) => node.type === "input" && node.props.placeholder === "owner/repo",
  )[0];
  act(() => {
    manualInput.props.onChange({ target: { value: "acme/manual" } });
  });
  const addManual = root
    .findAll((node) => node.type === "button")
    .find((node) => nodeText(node).trim() === "Add");
  assert.ok(addManual, "expected the manual-entry Add button");
  act(() => {
    addManual!.props.onClick();
  });

  assert.match(nodeText(root), /acme\/manual/);
});

test("deleting the only gated group warns before the click, matching GateGroupsEditor's after-the-fact notice", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  expandGroup(root, "lint");

  const checksCard = root.findByProps({ name: "checks" });
  const lintCard = root.findByProps({ name: "lint" });

  // CONFIG gates on ["checks"] alone, so only the "checks" card is the one
  // whose removal would silently flip the gate to "all groups".
  assert.match(
    nodeText(checksCard),
    /This is the only group the gate selection names\. Removing it will leave nothing selected\. Now gating on all groups\./,
  );
  assert.doesNotMatch(nodeText(lintCard), /Now gating on all groups\./);
});

test("a group name colliding with a sibling keeps every keystroke and shows a hint instead of freezing", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");

  const checksCard = root.findByProps({ name: "checks" });
  const nameInput = checksCard.findAll((node) => node.type === "input")[0];

  act(() => {
    nameInput.props.onChange({ target: { value: "lint" } });
  });

  // The draft buffer must show exactly what was typed, not silently ignore
  // the keystroke because "lint" is already taken by a sibling group.
  assert.equal(nameInput.props.value, "lint");
  assert.match(nodeText(checksCard), /A group named "lint" already exists\./);
  // The collision was never committed: "checks" still exists as its own group.
  assert.ok(root.findByProps({ name: "checks" }));
});

test("renaming a group to a name that only collides with Object.prototype succeeds", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");

  const checksCard = root.findByProps({ name: "checks" });
  const nameInput = checksCard.findAll((node) => node.type === "input")[0];

  act(() => {
    nameInput.props.onChange({ target: { value: "constructor" } });
  });

  // `in` walks the prototype chain and would have treated "constructor" as
  // permanently taken; Object.hasOwn checks only the group's own keys.
  assert.equal(nameInput.props.value, "constructor");
  assert.doesNotMatch(nodeText(checksCard), /already exists/);

  act(() => {
    nameInput.props.onBlur({});
  });
  assert.ok(
    root.findByProps({ name: "constructor" }),
    "the rename must commit instead of being treated as a prototype-key collision",
  );
});

test("a colliding rename draft blocks Save with a named blocker, and the committed name stays unchanged on the wire", async (t) => {
  const { root, calls } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "lint");
  expandSection(root, "Setup (1 command)");

  // Retype "lint" toward "checks", which already exists on this repo, then
  // edit something unrelated: N1 was that the draft never reached
  // firstConfigIssue, so an unrelated edit left Save enabled with "lint"
  // still committed but the field reading "checks" - the not_run trap.
  const lintCard = root.findByProps({ name: "lint" });
  const lintNameInput = lintCard.findAll((node) => node.type === "input")[0];
  act(() => {
    lintNameInput.props.onChange({ target: { value: "checks" } });
  });
  const setupInput = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap",
  )[0];
  act(() => {
    setupInput.props.onChange({ target: { value: "make bootstrap-fast" } });
  });

  assert.equal(saveButton(root).props.disabled, true);
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: group name "checks" duplicates an existing group\./,
  );

  // Bypass the disabled button the way a stray click race could: save()
  // itself must never have been fooled either, so the wire payload still
  // carries "lint" as its own key rather than a collapsed or renamed one.
  await act(async () => {
    saveButton(root).props.onClick();
  });
  const sent = submittedConfig(calls);
  assert.deepEqual(Object.keys(sent.repositories[0].groups ?? {}).sort(), ["checks", "lint"]);
});

test("the batch timeout field caps entry at 180 minutes and explains why the cap matters", (t) => {
  const { root } = renderScreen(t);

  const batchTimeoutInput = root.findAll(
    (node) => node.type === "input" && node.props.type === "number" && node.props.value === 45,
  )[0];
  assert.equal(batchTimeoutInput.props.max, 180);

  act(() => {
    batchTimeoutInput.props.onChange({ target: { value: "500" } });
  });

  const clampedInput = root.findAll(
    (node) => node.type === "input" && node.props.type === "number" && node.props.value === 180,
  )[0];
  assert.ok(clampedInput, "expected the batch timeout to clamp to the 180-minute server cap");

  assert.match(
    nodeText(root),
    /Not deducted from the run's duration budget; it does extend how long the run holds a dispatch slot\./,
  );
});

test("the install warning reads shell structure instead of matching anywhere in the line", () => {
  // Commands that really do provision a toolchain, including the shapes the
  // heuristic has to walk into: a second segment after `&&`, and a leading
  // environment assignment.
  for (const command of [
    "yarn install",
    "pnpm install --frozen-lockfile",
    "npm ci",
    "npm install -g pnpm@9 --silent && pnpm install --frozen-lockfile --prefer-offline",
    "pip install -r requirements.txt",
    "uv sync --frozen",
    "cd genai-engine && uv sync --frozen --group dev",
    "CI=1 yarn install",
    "sudo apt-get install foo",
    "env CI=1 yarn install",
    // A prose apostrophe used to pair with nothing and swallow the rest of
    // the line, hiding the real install two segments later.
    "echo it's fine && npm install",
    "echo Don't forget && yarn install",
    "npm i",
    "apt install ripgrep",
    "sudo apt install ripgrep",
    "pip3 install -r requirements.txt",
    "python -m pip install -U pip",
    "python3 -m pip install -r requirements.txt",
    "corepack enable",
    "corepack prepare pnpm@9 --activate",
    "corepack install",
    "nvm install 20",
    "pnpm --filter worker install",
    "pnpm --filter worker i",
    // Bare yarn with no subcommand installs.
    "yarn",
    "make install",
  ]) {
    assert.equal(looksLikeInstallCommand(command), true, `expected "${command}" to warn`);
  }

  // The first entry is the production false positive this fix is for: the
  // install phrase lives inside a quoted message, not in a command position.
  for (const command of [
    'echo "yarn install was not run; dependencies are not installed"; exit 0',
    "echo 'run npm ci first'",
    "yarn test",
    "pnpm --filter worker test",
    "uv run pytest tests/",
    'grep -q "pip install" README.md',
    "echo don't install this",
  ]) {
    assert.equal(looksLikeInstallCommand(command), false, `expected "${command}" not to warn`);
  }
});

test("two groups extending each other block Save with the cycle spelled out", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  expandGroup(root, "lint");

  // The server rejects an extends cycle with a 400; before this the editor
  // let the user click Save to find that out.
  act(() => {
    root.findByProps({ "aria-label": "Extend lint" }).props.onChange({ target: { checked: true } });
  });
  act(() => {
    root
      .findByProps({ "aria-label": "Extend checks" })
      .props.onChange({ target: { checked: true } });
  });

  assert.equal(saveButton(root).props.disabled, true);
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: cycle in extends: checks -> lint -> checks\./,
  );

  // Breaking the cycle in either direction has to clear the blocker.
  act(() => {
    root
      .findByProps({ "aria-label": "Extend checks" })
      .props.onChange({ target: { checked: false } });
  });
  assert.equal(saveButton(root).props.disabled, false);
});

test("group cards follow the config's key order, which arrives canonical from the server", (t) => {
  // The worker rebuilds `groups` with canonical key order when it reads the
  // config back, so the payload carries the order and the editor renders it
  // as given. Re-sorting here would be worse than useless: cards are keyed by
  // index and every keystroke commits a rename, so a name crossing a sort
  // boundary mid-typing would slide a sibling into the focused slot and the
  // next keystroke would rename that sibling instead.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: {
          alpha: { commands: ["pnpm alpha"] },
          mid: { commands: ["pnpm mid"] },
          zeta: { commands: ["pnpm zeta"] },
        },
      },
    ],
  });
  for (const name of ["alpha", "mid", "zeta"]) expandGroup(root, name);
  assert.deepEqual(
    groupNameInputs(root).map((input) => input.props.value),
    ["alpha", "mid", "zeta"],
  );

  // Renaming the first group to a name that sorts last must leave the card
  // exactly where it is, so the field under the cursor keeps belonging to the
  // group being renamed.
  act(() => {
    groupNameInputs(root)[0].props.onChange({ target: { value: "zzz" } });
  });
  assert.deepEqual(
    groupNameInputs(root).map((input) => input.props.value),
    ["zzz", "mid", "zeta"],
  );
});

test("the cycle blocker names the rotation starting where the back edge closes", (t) => {
  // The detector starts its walk at the alphabetically first root, and the
  // rotation it reports opens where the back edge closes. Here those coincide
  // on "lint"; the three-group test below is the case where they do not.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: {
          lint: { commands: ["pnpm lint"], extends: ["verify"] },
          verify: { commands: ["pnpm verify"], extends: ["lint"] },
        },
      },
    ],
  });

  assert.equal(saveButton(root).props.disabled, true);
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: cycle in extends: lint -> verify -> lint\./,
  );
});

test("a cycle is called out on the cards it runs through, not only above Save", (t) => {
  // The walk opens on "a" because it sorts first, but the back edge closes on
  // "c", so the rotation a user reads is c -> b -> c and "a" is not on it
  // even though the walk reached the cycle through it.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: {
          a: { commands: ["pnpm a"], extends: ["c"] },
          b: { commands: ["pnpm b"], extends: ["c"] },
          c: { commands: ["pnpm c"], extends: ["b"] },
        },
      },
    ],
  });

  assert.match(nodeText(root), /Save is disabled: acme\/web: cycle in extends: c -> b -> c\./);
  for (const name of ["b", "c"]) {
    assert.match(
      nodeText(root.findByProps({ name })),
      /Part of an extends cycle: c -> b -> c\./,
      `expected group "${name}" to name the cycle it is on`,
    );
  }
  assert.doesNotMatch(nodeText(root.findByProps({ name: "a" })), /Part of an extends cycle/);
});

test("an invalid rename draft is held back instead of becoming a group key", (t) => {
  // "2" is array-index-like, and Object.keys hoists such a key to the front,
  // so committing it would slide the sibling card into the focused slot and
  // the next keystroke would rename that sibling instead.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: {
          lint: { commands: ["pnpm lint"] },
          test: { commands: ["pnpm test"] },
        },
      },
    ],
  });
  for (const name of ["lint", "test"]) expandGroup(root, name);
  assert.deepEqual(
    groupNameInputs(root).map((input) => input.props.value),
    ["lint", "test"],
  );

  act(() => {
    groupNameInputs(root)[1].props.onChange({ target: { value: "2" } });
  });
  act(() => {
    groupNameInputs(root)[1].props.onChange({ target: { value: "2fa" } });
  });

  // Every keystroke stayed visible in its own slot, no card moved, and the
  // config still holds the group under its committed name.
  assert.deepEqual(
    groupNameInputs(root).map((input) => input.props.value),
    ["lint", "2fa"],
  );
  assert.ok(root.findByProps({ name: "test" }), "the invalid draft must not have committed");
  assert.equal(saveButton(root).props.disabled, true);
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: group name "2fa" is invalid \(lowercase letters, digits and dashes, starting with a letter, at most 40 characters\)\./,
  );

  // A legal name still has to be applied: it commits on blur, not per keystroke.
  act(() => {
    groupNameInputs(root)[1].props.onChange({ target: { value: "two-fa" } });
  });
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: group name "two-fa" is not applied yet; press Enter or click outside the field\./,
  );
  act(() => {
    groupNameInputs(root)[1].props.onBlur({});
  });
  assert.ok(root.findByProps({ name: "two-fa" }));
  assert.deepEqual(
    groupNameInputs(root).map((input) => input.props.value),
    ["lint", "two-fa"],
  );
  assert.doesNotMatch(nodeText(root), /Save is disabled/);
});

test("an extends reference to a group that does not exist is reported, not shown as clean", (t) => {
  // The checkboxes only ever offer siblings, so the editor cannot author this,
  // but a config written through the API can and the worker rejects it.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: { lint: { commands: ["pnpm lint"], extends: ["typo"] } },
      },
    ],
  });

  assert.equal(saveButton(root).props.disabled, true);
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: group "lint": extends unknown group "typo"\./,
  );
});

test("the Save blocker is a live region the disabled button points at", (t) => {
  // A disabled button takes no focus and announces nothing, so the reason has
  // to reach assistive tech on its own.
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  act(() => {
    buttons(root, "Add command")[0].props.onClick();
  });

  const describedBy = saveButton(root).props["aria-describedby"];
  assert.ok(describedBy, "expected Save to reference the blocker while it is disabled");
  const blocker = root.findByProps({ id: describedBy, role: "status" });
  assert.match(nodeText(blocker), /Save is disabled: acme\/web: group "checks": empty command\./);
});

test('the legacy repository section header no longer reads the stale "Checks" label', (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/legacy");

  const legacyCard = repoCard(root, "acme/legacy");
  assert.match(nodeText(legacyCard), /Commands \(legacy\)/);
  assert.doesNotMatch(nodeText(legacyCard), /\bChecks\b/);
});


test("the gate radio pair keeps an absent gateGroups absent on the wire", async (t) => {
  const { root, calls } = renderScreen(t, undefined, initialOf(DEFAULT_GATE_CONFIG));
  // A lone repository opens by itself, so the gate section is already on screen.
  const everyGroup = () => root.findByProps({ "aria-label": "Every group (default)" });
  const onlySelected = () => root.findByProps({ "aria-label": "Only the groups I select" });

  assert.equal(everyGroup().props.checked, true);
  assert.equal(onlySelected().props.checked, false);
  assert.equal(
    root.findAll((n) => n.props["aria-label"] === "Gate on group checks").length,
    0,
    "the checkbox list belongs to the explicit selection only",
  );

  // Switching to an explicit selection starts from everything, so the gate
  // runs exactly what it ran a moment ago.
  act(() => {
    onlySelected().props.onChange({ target: { checked: true } });
  });
  assert.equal(root.findByProps({ "aria-label": "Gate on group checks" }).props.checked, true);
  assert.equal(root.findByProps({ "aria-label": "Gate on group lint" }).props.checked, true);

  // And back: gateGroups has to be absent again, not an array of every name,
  // because absent is what the worker reads as "run them all".
  act(() => {
    everyGroup().props.onChange({ target: { checked: true } });
  });
  assert.equal(everyGroup().props.checked, true);
  await act(async () => {
    saveButton(root).props.onClick();
  });
  assert.equal("gateGroups" in submittedConfig(calls).repositories[0], false);
});

test("the gate section says what happens to the groups a selection leaves out", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");

  // CONFIG gates on ["checks"] alone, so the standing line is the one thing
  // that explains what "lint" is doing there at all.
  assert.match(
    nodeText(root),
    /Groups you do not select will not run at the gate at all\. They run only when a workflow block names them\./,
  );

  act(() => {
    root.findByProps({ "aria-label": "Every group (default)" }).props.onChange({
      target: { checked: true },
    });
  });
  assert.doesNotMatch(nodeText(root), /Groups you do not select will not run at the gate/);
  assert.match(nodeText(root), /Now gating on all groups\./);
});

test("every group card says whether the publication gate runs it", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");

  // Collapsed cards carry the chip too: which groups the gate skips is the
  // question the summary rows exist to answer.
  assert.match(nodeText(root.findByProps({ name: "checks" })), /runs at gate/);
  assert.match(nodeText(root.findByProps({ name: "lint" })), /not at gate/);

  act(() => {
    root.findByProps({ "aria-label": "Every group (default)" }).props.onChange({
      target: { checked: true },
    });
  });
  assert.match(nodeText(root.findByProps({ name: "lint" })), /runs at gate/);

  expandGroup(root, "lint");
  assert.match(nodeText(root.findByProps({ name: "lint" })), /runs at gate/);
});

test("a group added under an explicit gate selection joins it, opens, and can be undone", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");

  act(() => {
    button(root, "+ Add group").props.onClick();
  });

  // Without this the new group would be outside the selection, which means it
  // never runs at the gate at all: a group that quietly checks nothing.
  const added = () => root.findByProps({ name: "group-3" });
  assert.equal(root.findByProps({ "aria-label": "Gate on group group-3" }).props.checked, true);
  assert.match(nodeText(added()), /runs at gate/);
  assert.match(nodeText(root), /Added to the gate selection: group-3/);
  // A group you just added is the one you are about to fill in.
  assert.ok(
    added().findAll((n) => n.type === "input" && n.props.value === "group-3")[0],
    "a newly added group card starts expanded",
  );

  act(() => {
    button(root, "undo").props.onClick();
  });
  assert.equal(root.findByProps({ "aria-label": "Gate on group group-3" }).props.checked, false);
  assert.match(nodeText(added()), /not at gate/);
  assert.doesNotMatch(nodeText(root), /Added to the gate selection/);
});

test("a group added while the gate runs every group is left out of the selection", (t) => {
  const { root, calls } = renderScreen(t, undefined, initialOf(DEFAULT_GATE_CONFIG));

  act(() => {
    button(root, "+ Add group").props.onClick();
  });

  // Nothing to auto-add to: the default already covers the new group, and
  // writing a selection here would take every other group out of the gate.
  assert.doesNotMatch(nodeText(root), /Added to the gate selection/);
  assert.equal(root.findByProps({ "aria-label": "Every group (default)" }).props.checked, true);
  assert.match(nodeText(root.findByProps({ name: "group-3" })), /runs at gate/);

  act(() => {
    saveButton(root).props.onClick();
  });
  assert.equal("gateGroups" in submittedConfig(calls).repositories[0], false);
});

test("one repository is open at a time and a collapsed one still names its first blocker", (t) => {
  const { root } = renderScreen(t);

  // Two repositories, so neither opens by itself.
  assert.equal(repoCard(root, "acme/web").findAll((n) => n.type === "input").length, 0);

  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  act(() => {
    buttons(root, "Add command")[0].props.onClick();
  });
  expandRepo(root, "acme/legacy");

  const web = repoCard(root, "acme/web");
  assert.equal(
    web.findAll((n) => n.props["aria-expanded"] === true).length,
    0,
    "opening the second repository closes the first",
  );
  // Collapsing must never be a way to lose an error.
  assert.match(nodeText(web), /group "checks": empty command/);
  assert.match(nodeText(web), /2 groups · gate: checks · setup 1 · env 1/);
});

test("a lone configured repository starts expanded and can still be closed", (t) => {
  const root = renderConfig(t, DEFAULT_GATE_CONFIG);
  assert.match(nodeText(root), /Script groups/);

  act(() => {
    toggleOf(repoCard(root, "acme/web")).props.onClick();
  });
  assert.doesNotMatch(nodeText(root), /Script groups/);
  assert.match(nodeText(root), /2 groups · gate: all groups/);
});

test("a collapsed group card keeps its own error on the summary row", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  act(() => {
    buttons(root, "Add command")[0].props.onClick();
  });
  // Close it again: the row, not the card body, is now the only place the
  // blank command can be seen from.
  expandGroup(root, "checks");

  assert.match(nodeText(root.findByProps({ name: "checks" })), /checks · 2 commands · extends: \(none\)/);
  assert.match(nodeText(root.findByProps({ name: "checks" })), /Empty command\./);
});

test("the secondary sections carry their counts and keep a closed error visible", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");

  const web = () => repoCard(root, "acme/web");
  assert.match(nodeText(web()), /Setup \(1 command\)/);
  assert.match(nodeText(web()), /Env vars \(1\)/);
  assert.match(nodeText(web()), /Per-command timeout \(10 min\)/);

  expandSection(root, "Setup (1 command)");
  const setupInput = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap",
  )[0];
  act(() => {
    setupInput.props.onChange({ target: { value: "" } });
  });
  // Closing the section again must not take the reason Save is disabled with it.
  expandSection(root, "Setup (1 command)");
  assert.match(nodeText(web()), /empty setup command/);
});

test("the rename warning shows only while the name is actually being edited", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  const warning = /Workflow blocks that name this group will not follow a rename or removal/;
  const checks = () => root.findByProps({ name: "checks" });

  // Nine group cards repeating this sentence is what the complaint was about.
  assert.doesNotMatch(nodeText(checks()), warning);

  const nameInput = checks().findAll((node) => node.type === "input")[0];
  act(() => {
    nameInput.props.onFocus({});
  });
  assert.match(nodeText(checks()), warning);

  act(() => {
    nameInput.props.onBlur({});
  });
  assert.doesNotMatch(nodeText(checks()), warning);

  // A draft the config has not taken is an edit in progress even unfocused.
  act(() => {
    nameInput.props.onChange({ target: { value: "lint" } });
  });
  assert.match(nodeText(checks()), warning);
});

test("the restore tree explanation shows while the box is off and stays reachable while it is on", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  expandGroup(root, "lint");
  const note = /On, the tracked files this group's commands modified are restored afterward\./;

  // "checks" has restoreTree: false, the state worth explaining.
  assert.match(nodeText(root.findByProps({ name: "checks" })), note);

  const lint = () => root.findByProps({ name: "lint" });
  assert.doesNotMatch(nodeText(lint()), note);

  // A title tooltip cannot be reached by keyboard, by touch, or by a screen
  // reader, so the sentence hangs off a real button instead.
  const info = lint().findAll(
    (n) => n.type === "button" && n.props["aria-controls"] !== undefined,
  )[0];
  assert.ok(info, "expected a focusable control that reveals the sentence");
  assert.equal(info.props["aria-expanded"], false);
  act(() => {
    info.props.onClick();
  });
  assert.match(nodeText(lint()), note);
  assert.ok(
    lint().findAll((n) => n.props.id === info.props["aria-controls"])[0],
    "the button must point at the paragraph it reveals",
  );

  const label = lint().findAll((n) => n.type === "label" && typeof n.props.title === "string")[0];
  assert.ok(label, "the tooltip may stay, as long as it is not the only carrier");
  assert.match(label.props.title, note);
});

test("closing a group card discards a rename draft instead of blocking Save from behind it", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");

  const nameInput = root.findByProps({ name: "checks" }).findAll((n) => n.type === "input")[0];
  act(() => {
    nameInput.props.onChange({ target: { value: "lint" } });
  });
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: group name "lint" duplicates an existing group\./,
  );

  // Closing the card takes the only field that could fix the draft off screen,
  // so the draft goes with it rather than leaving Save blocked on a name
  // nothing on the page still shows.
  expandGroup(root, "checks");
  assert.doesNotMatch(nodeText(root), /Save is disabled/);
  assert.ok(root.findByProps({ name: "checks" }), "the committed name is untouched");
});

test("the same path under two providers gets two independent native radio groups", (t) => {
  // AddRepository dedupes on provider AND path, so this pair is a configuration
  // a user can really reach. Naming both radio groups after the path alone
  // would make the browser treat all four inputs as one group, and picking a
  // gate mode on one card would silently unpick the other's.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: { checks: { commands: ["pnpm test"] } },
      },
      {
        provider: "gitlab",
        repoPath: "acme/web",
        groups: { checks: { commands: ["pnpm test"] } },
      },
    ],
  });

  // One repository is open at a time, so each name is read from its own card.
  expandRepo(root, "acme/web");
  const githubRadioName = root.findByProps({ "aria-label": "Every group (default)" }).props.name;
  act(() => {
    toggleOf(repoCards(root)[1]).props.onClick();
  });
  const gitlabRadioName = root.findByProps({ "aria-label": "Every group (default)" }).props.name;

  assert.ok(githubRadioName, "expected the gate radios to be in a named native group");
  assert.notEqual(githubRadioName, gitlabRadioName);
});

test("a rename commits on blur and on Enter, never on a keystroke, and Escape reverts it", async (t) => {
  const { root, calls } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "lint");
  const field = () => root.findByProps({ name: "lint" }).findAll((n) => n.type === "input")[0];

  // Typing "test" used to commit "t", "te" and "tes" for real on the way, so a
  // final name that collided left the group named after a prefix.
  for (const value of ["t", "te", "tes", "test"]) {
    act(() => {
      field().props.onChange({ target: { value } });
    });
    assert.ok(root.findByProps({ name: "lint" }), `"${value}" must not have been committed`);
  }
  assert.equal(field().props.value, "test");

  act(() => {
    field().props.onKeyDown({ key: "Escape" });
  });
  assert.equal(field().props.value, "lint", "Escape puts the committed name back");

  const beforeEnter = field();
  act(() => {
    beforeEnter.props.onChange({ target: { value: "test" } });
  });
  act(() => {
    beforeEnter.props.onKeyDown({ key: "Enter" });
  });
  assert.ok(root.findByProps({ name: "test" }), "Enter applies the rename");

  const beforeBlur = root.findByProps({ name: "test" }).findAll((n) => n.type === "input")[0];
  act(() => {
    beforeBlur.props.onChange({ target: { value: "verify" } });
  });
  act(() => {
    beforeBlur.props.onBlur({});
  });
  assert.ok(root.findByProps({ name: "verify" }), "blur applies the rename");

  await act(async () => {
    saveButton(root).props.onClick();
  });
  const sent = submittedConfig(calls);
  assert.deepEqual(Object.keys(sent.repositories[0].groups ?? {}), ["checks", "verify"]);
  assert.deepEqual(sent.repositories[0].gateGroups, ["checks"]);
});

test("collapsing mid-rename keeps the committed name, prefixes and all, on the wire", async (t) => {
  const { root, calls } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "lint");

  const field = root.findByProps({ name: "lint" }).findAll((n) => n.type === "input")[0];
  for (const value of ["t", "te", "tes"]) {
    act(() => {
      field.props.onChange({ target: { value } });
    });
  }

  // Closing the repository is the path that used to turn a half-typed name
  // into the group's real name: the intermediate commit had already landed and
  // the discarded draft was only the tail of it.
  expandRepo(root, "acme/web");

  await act(async () => {
    saveButton(root).props.onClick();
  });
  const sent = submittedConfig(calls);
  assert.deepEqual(Object.keys(sent.repositories[0].groups ?? {}), ["checks", "lint"]);
  assert.deepEqual(sent.repositories[0].gateGroups, ["checks"]);
});

test("an open group card follows its group when a save comes back with the keys reordered", async (t) => {
  const { root } = renderScreen(t, (body) => {
    const config = (body as { config: PrePrCheckConfig }).config;
    const [web, legacy] = config.repositories;
    // The stored order is whatever the response carries: jsonb does not hand
    // back the order that went up, and a restore can bypass the server's
    // canonical ordering entirely.
    const reordered = { lint: web.groups!.lint, checks: web.groups!.checks };
    return Response.json({
      version: versionOf(
        { ...config, repositories: [{ ...web, groups: reordered }, legacy] },
        2,
      ),
    });
  });
  expandRepo(root, "acme/web");
  expandGroup(root, "lint");

  await act(async () => {
    saveButton(root).props.onClick();
  });

  // Keyed by index, the open card would now be whichever group landed first.
  assert.ok(
    root.findByProps({ name: "lint" }).findAll((n) => n.type === "input")[0],
    "the card that was open is still the one that is open",
  );
  assert.equal(root.findByProps({ name: "checks" }).findAll((n) => n.type === "input").length, 0);
});

test("reopening a repository brings back the cards and sections that were open", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "lint");
  expandSection(root, "Setup (1 command)");

  expandRepo(root, "acme/web");
  expandRepo(root, "acme/web");

  assert.ok(
    root.findByProps({ name: "lint" }).findAll((n) => n.type === "input")[0],
    "the open group card comes back",
  );
  assert.ok(
    root.findAll((n) => n.type === "input" && n.props.value === "make bootstrap")[0],
    "the open secondary section comes back",
  );
});

test("removing a repository leaves the one that is open open", (t) => {
  const root = renderConfig(t, {
    repositories: [
      { provider: "github", repoPath: "acme/one", groups: { checks: { commands: ["a"] } } },
      { provider: "github", repoPath: "acme/two", groups: { checks: { commands: ["b"] } } },
      { provider: "github", repoPath: "acme/three", groups: { checks: { commands: ["c"] } } },
    ],
  });
  expandRepo(root, "acme/two");

  const removeThird = () =>
    repoCard(root, "acme/three").findAll(
      (n) => n.type === "button" && nodeText(n).trim() === "Remove",
    )[0];
  act(() => {
    removeThird().props.onClick();
  });
  act(() => {
    repoCard(root, "acme/three")
      .findAll((n) => n.type === "button" && nodeText(n).trim() === "Confirm remove")[0]
      .props.onClick();
  });

  assert.equal(repoCards(root).length, 2, "the confirmed removal took the repository out");
  assert.equal(
    repoCard(root, "acme/two").findAll((n) => n.props["aria-expanded"] === true).length > 0,
    true,
    "removing a different repository must not collapse the one being worked in",
  );
});

test("two auto-added groups are both listed and undoable, and the note survives a collapse", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");

  act(() => {
    button(root, "+ Add group").props.onClick();
  });
  act(() => {
    button(root, "+ Add group").props.onClick();
  });
  assert.match(nodeText(root), /Added to the gate selection: group-3 undo, group-4 undo/);
  assert.equal(buttons(root, "undo").length, 2);

  // The note is screen-level state: closing the repository must not lose it
  // while the gate selection keeps both groups.
  expandRepo(root, "acme/web");
  expandRepo(root, "acme/web");
  assert.match(nodeText(root), /Added to the gate selection: group-3 undo, group-4 undo/);

  act(() => {
    buttons(root, "undo")[0].props.onClick();
  });
  assert.equal(root.findByProps({ "aria-label": "Gate on group group-3" }).props.checked, false);
  assert.equal(root.findByProps({ "aria-label": "Gate on group group-4" }).props.checked, true);
  assert.match(nodeText(root), /Added to the gate selection: group-4 undo/);
  assert.equal(buttons(root, "undo").length, 1);

  // Unticking the other one by hand retires it from the note as well.
  act(() => {
    root.findByProps({ "aria-label": "Gate on group group-4" }).props.onChange({
      target: { checked: false },
    });
  });
  assert.doesNotMatch(nodeText(root), /Added to the gate selection/);
});

// ── Run-order previews ──────────────────────────────────────────────────────

const EXTENDS_CONFIG: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        checks: { commands: ["pnpm test"], extends: ["lint"] },
        lint: { commands: ["pnpm lint"] },
      },
    },
  ],
};

test("a group's preview lists its whole expansion in order, attributed to the declaring group", (t) => {
  // The extended group's commands run FIRST, which is the one thing the card's
  // own command list cannot show and the reason the preview exists.
  const root = renderConfig(t, EXTENDS_CONFIG);
  expandGroup(root, "checks");
  expandSection(root, "Preview run order");

  const card = root.findByProps({ name: "checks" });
  assert.match(nodeText(card), /1\. pnpm lint \[lint\]/);
  assert.match(nodeText(card), /2\. pnpm test \[checks\]/);
});

test("a cyclic draft renders the cycle in the preview instead of taking the card down", (t) => {
  // expandGroupCommands throws on a cycle rather than overflowing the stack,
  // and the editor previews drafts nobody has validated yet.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: {
          a: { commands: ["pnpm a"], extends: ["b"] },
          b: { commands: ["pnpm b"], extends: ["a"] },
        },
      },
    ],
  });
  expandGroup(root, "a");
  expandSection(root, "Preview run order");

  assert.match(nodeText(root.findByProps({ name: "a" })), /cycle in extends: a -> b -> a/);
});

test("the gate plan previews the selection, not every group the repository has", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandSection(root, "Preview gate plan");

  const card = repoCard(root, "acme/web");
  assert.match(nodeText(card), /1\. pnpm test \[checks\]/);
  assert.doesNotMatch(
    nodeText(card),
    /pnpm lint/,
    "the gate selection names only checks, so lint must not be in the plan",
  );
});

test("a legacy repository previews the way the engine normalizes it, as one group", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/legacy");
  expandSection(root, "Preview gate plan");

  assert.match(nodeText(repoCard(root, "acme/legacy")), /1\. make check \[checks\]/);
});

// ── Env allowlist ───────────────────────────────────────────────────────────

const ENV_CONFIG: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      env: ["OLD_TOKEN"],
      groups: { checks: { commands: ["pnpm test"] } },
    },
  ],
};

test("the env section offers what the deployment forwards and flags a saved name it does not", async (t) => {
  const { root, calls } = renderScreen(t, undefined, {
    ...initialOf(ENV_CONFIG),
    allowedEnv: ["NPM_TOKEN"],
  });

  // The allowlist can shrink under a saved config, so the warning has to be
  // reachable from the collapsed section, without saving anything first.
  assert.match(
    nodeText(repoCard(root, "acme/web")),
    /"OLD_TOKEN" is not forwarded by this deployment\./,
  );

  expandSection(root, "Env vars (1)");
  assert.match(
    nodeText(root),
    /Not forwarded by this deployment\. Every run for this repository will fail before any command runs\. Add it to PRE_PR_CHECKS_ALLOWED_ENV and redeploy the worker\./,
  );

  act(() => {
    root.findByProps({ "aria-label": "Add env var name NPM_TOKEN" }).props.onClick();
  });
  await act(async () => {
    saveButton(root).props.onClick();
  });
  assert.deepEqual(submittedConfig(calls).repositories[0].env, ["OLD_TOKEN", "NPM_TOKEN"]);
});

test("a worker that did not report an allowlist gets no chips and no accusations", (t) => {
  // Absent is not empty: an older worker answers without the field, and
  // rendering that as "nothing is forwarded" would condemn every env name.
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandSection(root, "Env vars (1)");

  assert.doesNotMatch(nodeText(root), /Forwarded by this deployment/);
  assert.doesNotMatch(nodeText(root), /Not forwarded by this deployment/);
});

// ── Sticky save bar ─────────────────────────────────────────────────────────

function batchTimeoutField(root: ReactTestInstance, value: number): ReactTestInstance {
  const field = root.findAll(
    (node) => node.type === "input" && node.props.type === "number" && node.props.value === value,
  )[0];
  assert.ok(field, `expected the batch timeout field holding ${value}`);
  return field;
}

test("the save bar appears with unsaved changes and discards them in two steps", (t) => {
  const { root } = renderScreen(t);
  assert.doesNotMatch(nodeText(root), /Unsaved changes/);

  act(() => {
    batchTimeoutField(root, 45).props.onChange({ target: { value: "60" } });
  });
  assert.match(nodeText(root), /Unsaved changes/);
  assert.match(
    nodeText(root),
    /Applies to every run that reaches the gate after saving, including runs already in progress\. Recorded gate results are keyed to this configuration and will be re-run\./,
  );

  // One click arms, the second reverts: same shape as Confirm restore.
  act(() => {
    button(root, "Discard").props.onClick();
  });
  assert.match(nodeText(root), /Unsaved changes/, "arming must not have discarded anything yet");
  act(() => {
    button(root, "Confirm discard").props.onClick();
  });

  assert.doesNotMatch(nodeText(root), /Unsaved changes/);
  assert.ok(batchTimeoutField(root, 45), "the last loaded value is back");
});

test("the save bar's blocker opens the repository it names", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");
  act(() => {
    buttons(root, "Add command")[0].props.onClick();
  });
  // Work moves on to another repository, and the offending one collapses.
  expandRepo(root, "acme/legacy");
  assert.equal(
    repoCard(root, "acme/web").findAll((n) => n.props["aria-expanded"] === true).length,
    0,
  );

  act(() => {
    button(root, "Show me").props.onClick();
  });
  assert.ok(
    repoCard(root, "acme/web").findAll((n) => n.props["aria-expanded"] === true).length > 0,
    "the blocker is a way back to the problem, not only a description of it",
  );
});

// ── A new repository entry ──────────────────────────────────────────────────

/** Opens the picker (whose catalog fetch fails under the default stub, which is
 *  exactly the manual-entry path) and adds one repository by hand. */
function addRepositoryByHand(root: ReactTestInstance, repoPath: string): void {
  act(() => {
    button(root, "+ Add repository").props.onClick();
  });
  const manual = root.findAll(
    (node) => node.type === "input" && node.props.placeholder === "owner/repo",
  )[0];
  act(() => {
    manual.props.onChange({ target: { value: repoPath } });
  });
  const add = root.findAll((node) => node.type === "button").find((n) => nodeText(n).trim() === "Add");
  assert.ok(add, "expected the manual-entry Add button");
  act(() => {
    add.props.onClick();
  });
}

test("a repository added by hand is born empty, with a hint instead of an error", (t) => {
  const { root } = renderScreen(t);
  addRepositoryByHand(root, "acme/new");

  const card = () => repoCard(root, "acme/new");
  assert.match(nodeText(card()), /No commands yet\./);
  assert.match(nodeText(card()), /Add at least one command to save\./);
  assert.doesNotMatch(nodeText(card()), /Empty command\./);
  assert.doesNotMatch(
    nodeText(card()),
    /This group has no commands and does not extend another group/,
  );
  assert.equal(saveButton(root).props.disabled, true, "Save is still blocked, just not shouting");

  // Adding the first row is not a mistake either; typing a command is what
  // ends the grace period.
  act(() => {
    button(root, "Add the first command").props.onClick();
  });
  assert.doesNotMatch(nodeText(card()), /Empty command\./);

  const commandField = card().findAll(
    (n) => n.type === "input" && n.props.placeholder === "pnpm test",
  )[0];
  act(() => {
    commandField.props.onChange({ target: { value: "pnpm build" } });
  });
  assert.doesNotMatch(nodeText(card()), /Add at least one command to save\./);
  assert.equal(saveButton(root).props.disabled, false);
});

// ── Pasting and reordering commands ─────────────────────────────────────────

test("pasting a block of lines becomes one command row per line", async (t) => {
  const { root, calls } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");

  const field = root
    .findByProps({ name: "checks" })
    .findAll((n) => n.type === "input" && n.props.value === "pnpm test")[0];
  act(() => {
    field.props.onPaste({
      clipboardData: { getData: () => "\npnpm lint\npnpm build\n" },
      preventDefault: () => {},
      // Caret at the end of the row being pasted into, as a browser reports it.
      target: { value: "pnpm test", selectionStart: 9, selectionEnd: 9 },
    });
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });
  // The browser default would have concatenated all three into one row, which
  // is a single command nothing can run.
  assert.deepEqual(submittedConfig(calls).repositories[0].groups?.checks.commands, [
    "pnpm test",
    "pnpm lint",
    "pnpm build",
  ]);
});

test("a command can be moved inside its group, because the order is the run order", async (t) => {
  const { root, calls } = renderScreen(
    t,
    undefined,
    initialOf({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: { checks: { commands: ["pnpm a", "pnpm b"] } },
        },
      ],
    }),
  );
  expandGroup(root, "checks");

  act(() => {
    root.findByProps({ "aria-label": "Move command 1 down" }).props.onClick();
  });
  await act(async () => {
    saveButton(root).props.onClick();
  });
  assert.deepEqual(submittedConfig(calls).repositories[0].groups?.checks.commands, [
    "pnpm b",
    "pnpm a",
  ]);
});

// ── Removal confirmations ───────────────────────────────────────────────────

test("removing a group asks first and says what the removal costs", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandGroup(root, "lint");

  const lint = () => root.findByProps({ name: "lint" });
  act(() => {
    lint().findAll((n) => n.type === "button" && nodeText(n).includes("Remove group"))[0].props.onClick();
  });
  assert.match(
    nodeText(lint()),
    /Workflow blocks that name this group will not follow the removal and will report not_run\./,
  );

  act(() => {
    lint().findAll((n) => n.type === "button" && nodeText(n).trim() === "Cancel")[0].props.onClick();
  });
  assert.ok(root.findByProps({ name: "lint" }), "cancelling keeps the group");
  assert.equal(saveButton(root).props.disabled, true, "cancelling changed nothing to save");
});

test("removing a repository asks first and names what goes with it", (t) => {
  const { root } = renderScreen(t);
  const web = () => repoCard(root, "acme/web");

  act(() => {
    web().findAll((n) => n.type === "button" && nodeText(n).trim() === "Remove")[0].props.onClick();
  });
  assert.match(
    nodeText(web()),
    /Removes this repository along with all its groups, setup commands and env settings\./,
  );

  act(() => {
    web().findAll((n) => n.type === "button" && nodeText(n).trim() === "Cancel")[0].props.onClick();
  });
  assert.equal(repoCards(root).length, 2, "cancelling keeps the repository");
});

// ── Manual entry and the repository catalog ─────────────────────────────────

test("a pasted repository URL is reduced to a path, and a shape nothing can match is refused", (t) => {
  const { root } = renderScreen(t);
  act(() => {
    button(root, "+ Add repository").props.onClick();
  });
  const manual = () =>
    root.findAll((node) => node.type === "input" && node.props.placeholder === "owner/repo")[0];

  act(() => {
    manual().props.onChange({ target: { value: "https://github.com/acme/web/tree/main/apps" } });
  });
  assert.equal(manual().props.value, "acme/web");

  act(() => {
    manual().props.onChange({ target: { value: "acme" } });
  });
  assert.match(nodeText(root), /Enter owner\/repo, or paste the repository URL\./);
  const add = root.findAll((node) => node.type === "button").find((n) => nodeText(n).trim() === "Add");
  assert.equal(add?.props.disabled, true);
});

test("a configured path the catalog does not list is called out on its own card", async (t) => {
  const urls: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    urls.push(String(url));
    assert.equal(String(url), "/api/repositories");
    return Response.json({
      repositories: [
        {
          provider: "github",
          repoPath: "acme/other",
          name: "other",
          owner: "acme",
          defaultBranch: "main",
          private: false,
          archived: false,
        },
      ],
      providers: [
        { provider: "github", status: "ready" },
        // Listed but unusable, so nothing under it may be called missing.
        { provider: "gitlab", status: "error", error: "401 Unauthorized" },
      ],
    });
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={INITIAL} canEdit />);
  });
  t.after(() => act(() => renderer.unmount()));
  const root = renderer.root;

  // No picker, no click: a settled fleet never opens Add repository, and that
  // is exactly the fleet with a repository nobody has renamed the config for.
  await act(async () => {});

  assert.match(
    nodeText(repoCard(root, "acme/web")),
    /Not found in the github catalog\. Scripts for this path will never run\./,
  );
  assert.doesNotMatch(
    nodeText(repoCard(root, "acme/legacy")),
    /Not found in the/,
    "a provider that could not be listed proves nothing about its repositories",
  );

  // Once per mount, and the picker reuses it rather than asking again.
  await act(async () => {
    button(root, "+ Add repository").props.onClick();
  });
  await act(async () => {});
  assert.deepEqual(urls, ["/api/repositories"]);
});

// ── History ─────────────────────────────────────────────────────────────────

test("history marks the newest version and loads an older one as an unsaved edit", (t) => {
  const older = versionOf({ repositories: [] }, 1);
  const newest = versionOf(CONFIG, 2);
  const { root, calls } = renderScreen(t, undefined, {
    current: newest,
    versions: [newest, older],
  });

  const historyRow = (version: number) =>
    root
      .findAll((n) => n.type === "div" && typeof n.props.className === "string")
      .filter((n) => nodeText(n).startsWith(`v${version}`))[0];
  assert.match(nodeText(historyRow(2)), /current/);
  assert.doesNotMatch(nodeText(historyRow(1)), /current/);
  assert.equal(buttons(root, "Restore").length, 1, "the newest version has nothing to restore to");

  act(() => {
    button(root, "Preview").props.onClick();
  });

  assert.match(nodeText(root), /No repository scripts configured\. The gate is disabled\./);
  assert.match(nodeText(root), /Unsaved changes/);
  assert.match(nodeText(root), /loaded from v1/);
  assert.equal(writes(calls).length, 0, "a preview writes nothing on its own");
});

// ── Legacy entries and the per-command timeout ──────────────────────────────

test("a legacy card says which group it runs as and stays honest about converting", (t) => {
  const { root } = renderScreen(t);
  const legacy = () => repoCard(root, "acme/legacy");

  // Visible while collapsed too: the group name is what a workflow block has
  // to spell to reach these commands.
  assert.match(nodeText(legacy()), /runs as group "checks"/);

  expandRepo(root, "acme/legacy");
  assert.match(
    nodeText(legacy()),
    /Older format, still fully supported\. Convert to add env vars, extends and per-group gating\. Conversion cannot be undone here, only through History\./,
  );
});

test("the per-command timeout names the deployment default instead of an empty box", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandSection(root, "Per-command timeout (10 min)");

  assert.match(
    nodeText(root),
    /Leave blank for the default, which is 10 minutes unless this deployment sets PRE_PR_COMMAND_TIMEOUT_MINUTES\./,
  );
  const field = root.findAll(
    (n) => n.type === "input" && n.props.type === "number" && n.props.value === 10,
  )[0];
  assert.equal(field.props.placeholder, "10");
});

test("a group named after a secondary section does not share that section's open flag", (t) => {
  // "setup", "env", "timeout" and "gate-preview" are all legal group names, and
  // the section rows live in the same key space as the group cards.
  const root = renderConfig(t, {
    repositories: [
      {
        provider: "github",
        repoPath: "acme/web",
        groups: { setup: { commands: ["pnpm setup-check"] }, lint: { commands: ["pnpm lint"] } },
      },
    ],
  });

  expandGroup(root, "setup");
  const setupHeader = root
    .findAll((n) => n.type === "button" && n.props["aria-expanded"] !== undefined)
    .find((n) => nodeText(n).includes("Setup (none)"));
  assert.ok(setupHeader, "expected the Setup section header");
  assert.equal(
    setupHeader.props["aria-expanded"],
    false,
    "opening a group called setup also opened the Setup section",
  );
  // The card itself did open: the group and the section are two things now.
  assert.ok(root.findByProps({ name: "setup" }).findAll((n) => n.type === "input")[0]);
});

// ── Off-allowlist env names ─────────────────────────────────────────────────

test("an off-allowlist env name blocks Save only when the saved config does not already carry it", (t) => {
  const { root } = renderScreen(t, undefined, {
    ...initialOf(ENV_CONFIG),
    allowedEnv: ["NPM_TOKEN"],
  });

  // OLD_TOKEN is stored and off the list: blocking Save on it would trap an
  // operator in an editor that cannot even save the edit removing it.
  const emptyBatchField = root.findAll(
    (n) => n.type === "input" && n.props.type === "number" && n.props.value === "",
  )[0];
  act(() => {
    emptyBatchField.props.onChange({ target: { value: "60" } });
  });
  assert.equal(saveButton(root).props.disabled, false);

  expandSection(root, "Env vars (1)");
  act(() => {
    button(root, "Add env var name").props.onClick();
  });
  const blank = root.findAll(
    (n) => n.type === "input" && n.props.placeholder === "MY_TOKEN" && n.props.value === "",
  )[0];
  act(() => {
    blank.props.onChange({ target: { value: "OTHER_TOKEN" } });
  });

  // A name that is not stored yet is a save the PUT will refuse outright, so
  // the button has to stop before the round trip does.
  assert.equal(saveButton(root).props.disabled, true);
  assert.match(
    nodeText(root),
    /Save is disabled: acme\/web: env var OTHER_TOKEN is not allowlisted on this worker; the save will be rejected\./,
  );
  assert.match(
    nodeText(root),
    /Not allowlisted on this worker\. Saving this configuration will be rejected\./,
  );
  // The stored one keeps the softer sentence, about the runs rather than the save.
  assert.match(
    nodeText(root),
    /Not forwarded by this deployment\. Every run for this repository will fail before any command runs\./,
  );
});

// ── Concurrent saves ────────────────────────────────────────────────────────

test("a save refused as stale reports the newer version and keeps the edit", async (t) => {
  const { root, calls } = renderScreen(t, (body) =>
    body === undefined
      ? Response.json({ repositories: [], providers: [] })
      : Response.json({ error: "version_conflict", latestVersion: 7 }, { status: 409 }),
  );
  act(() => {
    batchTimeoutField(root, 45).props.onChange({ target: { value: "60" } });
  });
  await act(async () => {
    saveButton(root).props.onClick();
  });

  const put = writes(calls)[0];
  assert.equal(
    (JSON.parse(String(put.init?.body)) as { baseVersion?: number }).baseVersion,
    1,
    "the version this edit started from has to travel with it, or nothing can detect the race",
  );
  assert.match(
    nodeText(root),
    /Version 7 was saved by someone else while you were editing\. Reload to load it; your changes here stay until you do\./,
  );
  assert.equal(buttons(root, "Reload").length, 1);
  // The point of not clearing: the edit is still worth something, and the
  // person is the only one who can decide what to do with it.
  assert.ok(batchTimeoutField(root, 60), "the refused save must not revert the editor");
  assert.match(nodeText(root), /Unsaved changes/);
});

test("History adopts a newer version arriving from the server", (t) => {
  const first = versionOf(CONFIG, 1);
  let renderer!: ReactTestRenderer;
  (globalThis as { fetch: unknown }).fetch = async () =>
    Response.json({ repositories: [], providers: [] });
  act(() => {
    renderer = create(
      <RepositoryScriptsScreen initial={{ current: first, versions: [first] }} canEdit />,
    );
  });
  t.after(() => act(() => renderer.unmount()));

  const second = versionOf({ repositories: [] }, 2);
  act(() => {
    renderer.update(
      <RepositoryScriptsScreen
        initial={{ current: second, versions: [second, first] }}
        canEdit
      />,
    );
  });

  // Without this the list is frozen at whatever it was when the tab opened, so
  // History quietly stops being history.
  assert.match(nodeText(renderer.root), /v2/);
  assert.match(nodeText(renderer.root), /current/);
});

// ── Browser Back ────────────────────────────────────────────────────────────

/** A window just complete enough for the two guards: the listener registry,
 *  confirm, and the history calls the sentinel makes. */
function stubWindow(t: TestContext) {
  const listeners = new Map<string, Set<() => void>>();
  const calls: string[] = [];
  const state = { answer: true };
  const win = {
    addEventListener: (type: string, cb: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, cb: () => void) => listeners.get(type)?.delete(cb),
    confirm: (message: string) => {
      calls.push(`confirm(${message})`);
      return state.answer;
    },
    history: {
      pushState: () => calls.push("pushState"),
      go: (n: number) => calls.push(`go(${n})`),
    },
  };
  (globalThis as { window?: unknown }).window = win;
  t.after(() => {
    delete (globalThis as { window?: unknown }).window;
  });
  return {
    calls,
    state,
    fire: (type: string) =>
      act(() => {
        for (const cb of [...(listeners.get(type) ?? [])]) cb();
      }),
  };
}

test("browser Back is caught while there are unsaved changes", (t) => {
  // Back fires no unload and no router.push, so neither of the other two
  // guards ever sees it: this is the exit that used to be silent.
  const win = stubWindow(t);
  const { root } = renderScreen(t);
  act(() => {
    batchTimeoutField(root, 45).props.onChange({ target: { value: "60" } });
  });
  assert.deepEqual(win.calls, ["pushState"], "a sentinel entry goes on the stack with the edit");

  win.state.answer = false;
  win.fire("popstate");
  assert.deepEqual(
    win.calls,
    ["pushState", "confirm(Discard unsaved changes?)", "pushState"],
    "declining stays put and re-arms the sentinel for the next Back",
  );

  win.state.answer = true;
  win.fire("popstate");
  assert.deepEqual(win.calls, [
    "pushState",
    "confirm(Discard unsaved changes?)",
    "pushState",
    "confirm(Discard unsaved changes?)",
    "go(-1)",
  ]);
});

// ── Reordering by keyboard ──────────────────────────────────────────────────

const TWO_COMMAND_CONFIG: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      groups: { checks: { commands: ["pnpm a", "pnpm b", "pnpm c"] } },
    },
  ],
};

test("pressing the same move button twice moves the same command two steps", async (t) => {
  const { root, calls } = renderScreen(t, undefined, initialOf(TWO_COMMAND_CONFIG));
  expandGroup(root, "checks");

  // Two presses of one button, which is what a keyboard does with Enter held
  // over the focused control. Row identity is what makes the second press
  // reach the same command rather than whatever slid into that position.
  act(() => {
    root.findByProps({ "aria-label": "Move command 1 down" }).props.onClick();
  });
  assert.match(nodeText(root), /pnpm a moved to position 2 of 3\./);
  act(() => {
    root.findByProps({ "aria-label": "Move command 2 down" }).props.onClick();
  });
  assert.match(nodeText(root), /pnpm a moved to position 3 of 3\./);

  await act(async () => {
    saveButton(root).props.onClick();
  });
  assert.deepEqual(submittedConfig(calls).repositories[0].groups?.checks.commands, [
    "pnpm b",
    "pnpm c",
    "pnpm a",
  ]);
});

test("the moved row's own button keeps the focus", (t) => {
  // Without it the keyboard lands on whatever row took that position, so the
  // second press moves someone else's command.
  const focused: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async () =>
    Response.json({ repositories: [], providers: [] });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <RepositoryScriptsScreen initial={initialOf(TWO_COMMAND_CONFIG)} canEdit />,
      {
        createNodeMock: (element) => ({
          focus: () =>
            focused.push(String((element.props as Record<string, unknown>)["aria-label"])),
        }),
      },
    );
  });
  t.after(() => act(() => renderer.unmount()));
  const root = renderer.root;
  expandGroup(root, "checks");

  act(() => {
    root.findByProps({ "aria-label": "Move command 1 down" }).props.onClick();
  });
  assert.deepEqual(focused, ["Move command 2 down"], "focus follows the row, not the position");
});

// ── The Save blocker as a way back ──────────────────────────────────────────

test("the blocker opens the collapsed section that produced the issue", (t) => {
  const { root } = renderScreen(t);
  expandRepo(root, "acme/web");
  expandSection(root, "Setup (1 command)");
  const setupInput = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap",
  )[0];
  act(() => {
    setupInput.props.onChange({ target: { value: "" } });
  });
  // Both the section and the repository are closed again: the error is only a
  // sentence above Save now.
  expandSection(root, "Setup (1 command)");
  expandRepo(root, "acme/web");

  act(() => {
    button(root, "Show me").props.onClick();
  });

  const web = repoCard(root, "acme/web");
  assert.ok(
    web.findAll((n) => n.type === "input" && n.props.value === "").length > 0,
    "the offending setup field has to be on screen, not behind two closed headers",
  );
});

// ── Preview feedback ────────────────────────────────────────────────────────

test("previewing a version identical to the editor says so instead of doing nothing", (t) => {
  const older = versionOf(CONFIG, 1);
  const newest = versionOf(CONFIG, 2);
  const { root } = renderScreen(t, undefined, { current: newest, versions: [newest, older] });

  act(() => {
    button(root, "Preview").props.onClick();
  });

  assert.match(nodeText(root), /v1 is identical to the current version/);
  assert.doesNotMatch(nodeText(root), /Unsaved changes/, "nothing changed, so nothing is unsaved");
});

// ── Discard ─────────────────────────────────────────────────────────────────

test("discarding clears the rename draft and the failed-save banner with it", async (t) => {
  const { root } = renderScreen(t, (body) =>
    body === undefined
      ? Response.json({ repositories: [], providers: [] })
      : Response.json({ error: "nope" }, { status: 400 }),
  );
  expandRepo(root, "acme/web");
  expandGroup(root, "checks");

  // A real edit to save, a failed save, and a rename typed but never committed.
  act(() => {
    batchTimeoutField(root, 45).props.onChange({ target: { value: "60" } });
  });
  await act(async () => {
    saveButton(root).props.onClick();
  });
  assert.match(nodeText(root), /nope/);
  act(() => {
    groupNameInputs(root)[0].props.onChange({ target: { value: "checks-2" } });
  });
  assert.match(nodeText(root), /is not applied yet/);

  act(() => {
    button(root, "Discard").props.onClick();
  });
  act(() => {
    button(root, "Confirm discard").props.onClick();
  });

  assert.doesNotMatch(nodeText(root), /nope/, "the discarded edit took its error with it");
  assert.doesNotMatch(
    nodeText(root),
    /is not applied yet/,
    "a rename nobody committed cannot outlive the edit it belonged to",
  );
  assert.doesNotMatch(nodeText(root), /Unsaved changes/);
});
