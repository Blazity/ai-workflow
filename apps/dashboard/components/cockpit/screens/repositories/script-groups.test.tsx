// apps/dashboard/components/cockpit/screens/repositories/script-groups.test.tsx
//
// The script group editor's own tests, carried over from the Repository scripts
// screen they were written against.
//
// What changed is the host, not the behaviour: the editor now edits ONE
// repository's profile instead of a fleet in one configuration blob, so the
// screen-level tests (version history, the conflict banner, Add repository, the
// batch timeout, what Save puts on the wire) went with the screen, and every
// test about groups, commands, env names, the gate selection and renaming is
// hosted here on a controlled wrapper that holds the entry the way the
// Repositories entry page does.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PrePrCheckConfig, PrePrCheckRepositoryConfig } from "@shared/contracts";
import { RepositoryScriptGroupsEditor, looksLikeInstallCommand } from "./script-groups";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The fixture the screen tests were written against, kept as a configuration
 *  so each test can still name the repository it is about. */
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
};

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

interface Harness {
  root: ReactTestInstance;
  /** The entry as the host holds it: what the Scripts tab would send. */
  entry: () => PrePrCheckRepositoryConfig | null;
  /** The reason Save is disabled, as the editor reports it upward. */
  blocker: () => string | null;
  /** Replaces the entry from outside, the way a save coming back does. */
  set: (next: PrePrCheckRepositoryConfig | null) => void;
}

/**
 * Mounts the editor over one repository, holding its entry the way the entry
 * page does. Nothing is stubbed: this editor makes no requests of its own, the
 * tab it lives in is what saves.
 */
function renderEntry(
  t: TestContext,
  entry: PrePrCheckRepositoryConfig | null,
  options: {
    savedEntry?: PrePrCheckRepositoryConfig | null;
    allowedEnv?: string[];
    canEdit?: boolean;
    /** react-test-renderer's node mock, for the one test that asserts focus. */
    createNodeMock?: (element: { props: Record<string, unknown> }) => unknown;
  } = {},
): Harness {
  const state: { entry: PrePrCheckRepositoryConfig | null; blocker: string | null } = {
    entry,
    blocker: null,
  };
  let setEntry!: (next: PrePrCheckRepositoryConfig | null) => void;
  const repository = {
    provider: (entry?.provider ?? "github") as "github" | "gitlab",
    path: entry?.repoPath ?? "acme/web",
  };

  function Host() {
    const [value, setValue] = React.useState(entry);
    setEntry = setValue;
    state.entry = value;
    return (
      <RepositoryScriptGroupsEditor
        repository={repository}
        entry={value}
        savedEntry={options.savedEntry === undefined ? entry : options.savedEntry}
        allowedEnv={options.allowedEnv}
        disabled={options.canEdit === false}
        onChange={(next) => {
          state.entry = next;
          setValue(next);
        }}
        onBlockerChange={(blocker) => {
          state.blocker = blocker;
        }}
      />
    );
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <Host />,
      options.createNodeMock
        ? {
            createNodeMock: (element) =>
              options.createNodeMock!(element as { props: Record<string, unknown> }),
          }
        : undefined,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  const harness: Harness = {
    root: renderer.root,
    entry: () => state.entry,
    blocker: () => state.blocker,
    set: (next) => act(() => setEntry(next)),
  };
  // The last editor mounted is the one the Save-bar shims below speak for, so
  // a test may reach for the editor directly and still read the Save bar.
  current = harness;
  t.after(() => {
    current = null;
  });
  return harness;
}

/** The repository named in a configuration fixture. */
function repoOf(config: PrePrCheckConfig, repoPath?: string): PrePrCheckRepositoryConfig {
  const repo =
    repoPath === undefined
      ? config.repositories[0]
      : config.repositories.find((candidate) => candidate.repoPath === repoPath);
  assert.ok(repo, `expected ${repoPath ?? "a repository"} in the fixture`);
  return structuredClone(repo);
}

/** Renders one repository out of a configuration fixture. The signature the
 *  screen tests used, minus the fleet. */
function renderConfig(
  t: TestContext,
  config: PrePrCheckConfig,
  repoPath?: string,
): ReactTestInstance {
  return renderEntry(t, repoOf(config, repoPath)).root;
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

function repoCard(root: ReactTestInstance, repoPath: string): ReactTestInstance {
  const card = root.findAll(
    (node) => typeof node.type === "function" && (node.type as { name?: string }).name === "RepoCard",
  )[0];
  assert.ok(card, `expected the repository card for ${repoPath}`);
  assert.equal(card.props.repo.repoPath, repoPath);
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

/** Inside one repository's entry there is no repository accordion to open: the
 *  card is the tab. Kept as an assertion so the tests still say which
 *  repository they are about. */
function expandRepo(root: ReactTestInstance, repoPath: string): void {
  repoCard(root, repoPath);
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

// ── What Save used to be ────────────────────────────────────────────────────
//
// The editor saves nothing: the Repositories entry page holds the entry, the
// reason and the Save bar, and sends one PUT to the profile route. The tests
// below were written against a screen that owned all of that, and what they
// actually assert is what the editor hands upward, so these three shims say so
// rather than re-deriving it in forty places: the "submitted config" is the
// entry as the editor last reported it, and the Save button's disabled state is
// the blocker it last reported.

let current: Harness | null = null;

/** Identity: the fixture is the configuration now, with no version envelope
 *  around it. Kept so the tests still read the way they were written. */
function initialOf(config: PrePrCheckConfig): PrePrCheckConfig {
  return config;
}

function renderScreen(
  t: TestContext,
  _respond?: unknown,
  config: PrePrCheckConfig = CONFIG,
  options: { allowedEnv?: string[]; repoPath?: string } = {},
): { root: ReactTestInstance; calls: never[] } {
  current = renderEntry(t, repoOf(config, options.repoPath), { allowedEnv: options.allowedEnv });
  return { root: current.root, calls: [] };
}

/**
 * The Save bar's message, as `repository-entry.tsx` renders it from the blocker
 * the editor reports: `Save is disabled: {blocker}.`
 *
 * The repository path is gone from it because the path is now the page: one
 * screen used to speak for a whole fleet and had to say which repository it
 * meant.
 */
function saveBarText(): string {
  assert.ok(current, "renderScreen was not used");
  const blocker = current.blocker();
  return blocker === null ? "" : `Save is disabled: ${blocker}.`;
}

/** The Save control, as the entry page renders it: disabled exactly when the
 *  editor reports a blocker. */
function saveButton(
  _root: ReactTestInstance,
): { props: { disabled: boolean; onClick: () => void } } {
  assert.ok(current, "renderScreen was not used");
  // Clicking is a no-op: the editor holds the entry and the entry page sends
  // it. The assertion that follows a click in these tests is about what would
  // be sent, which is exactly what submittedConfig reads.
  return { props: { disabled: current.blocker() !== null, onClick: () => {} } };
}

/** What the Scripts tab would send, in the shape the old assertions read. */
function submittedConfig(_calls: readonly never[]): PrePrCheckConfig {
  assert.ok(current, "renderScreen was not used");
  const entry = current.entry();
  assert.ok(entry, "expected the editor to hold a scripts entry");
  return { repositories: [entry] };
}

function repoCards(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    (node) => typeof node.type === "function" && (node.type as { name?: string }).name === "RepoCard",
  );
}


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
  assert.match(saveBarText(), /Save is disabled: gate groups selection is empty\./);

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
  const { root, calls } = renderScreen(t, undefined, CONFIG, { repoPath: "acme/legacy" });
  expandRepo(root, "acme/legacy");

  act(() => {
    button(root, "Convert to groups").props.onClick();
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });

  const legacy = submittedConfig(calls).repositories[0];
  // Not `commands: undefined`: the entry page diffs the draft against the saved
  // profile field by field, and a key left behind holding undefined reads as a
  // change nobody made.
  assert.equal("commands" in legacy, false);
  assert.deepEqual(legacy.groups, { checks: { commands: ["make check"] } });
  // The entry still names itself, because the engine reads the provider and
  // path out of it even though the route addresses the repository by id.
  assert.equal(legacy.provider, "gitlab");
  assert.equal(legacy.repoPath, "acme/legacy");
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
  assert.match(saveBarText(), /Save is disabled: group "checks": empty command\./);
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
  assert.match(saveBarText(), /Save is disabled: group "checks":/);
});

test("the env editor is absent for a legacy repository and appears after converting to groups", (t) => {
  const { root } = renderScreen(t, undefined, CONFIG, { repoPath: "acme/legacy" });
  expandRepo(root, "acme/legacy");

  // The legacy flat-commands shape is server-side .strict() with no env key,
  // so saving env names on it 400s; the section stays hidden until conversion.
  assert.equal(repoCards(root).length, 1);
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
    saveBarText(),
    /Save is disabled: group name "checks" duplicates an existing group\./,
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
    saveBarText(),
    /Save is disabled: cycle in extends: checks -> lint -> checks\./,
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
    saveBarText(),
    /Save is disabled: cycle in extends: lint -> verify -> lint\./,
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

  assert.match(saveBarText(), /Save is disabled: cycle in extends: c -> b -> c\./);
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
    saveBarText(),
    /Save is disabled: group name "2fa" is invalid \(lowercase letters, digits and dashes, starting with a letter, at most 40 characters\)\./,
  );

  // A legal name still has to be applied: it commits on blur, not per keystroke.
  act(() => {
    groupNameInputs(root)[1].props.onChange({ target: { value: "two-fa" } });
  });
  assert.match(
    saveBarText(),
    /Save is disabled: group name "two-fa" is not applied yet; press Enter or click outside the field\./,
  );
  act(() => {
    groupNameInputs(root)[1].props.onBlur({});
  });
  assert.ok(root.findByProps({ name: "two-fa" }));
  assert.deepEqual(
    groupNameInputs(root).map((input) => input.props.value),
    ["lint", "two-fa"],
  );
  assert.doesNotMatch(saveBarText(), /Save is disabled/);
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
    saveBarText(),
    /Save is disabled: group "lint": extends unknown group "typo"\./,
  );
});

test('the legacy repository section header no longer reads the stale "Checks" label', (t) => {
  const { root } = renderScreen(t, undefined, CONFIG, { repoPath: "acme/legacy" });
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
    saveBarText(),
    /Save is disabled: group name "lint" duplicates an existing group\./,
  );

  // Closing the card takes the only field that could fix the draft off screen,
  // so the draft goes with it rather than leaving Save blocked on a name
  // nothing on the page still shows.
  expandGroup(root, "checks");
  assert.doesNotMatch(saveBarText(), /Save is disabled/);
  assert.ok(root.findByProps({ name: "checks" }), "the committed name is untouched");
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

test("an open group card follows its group when a save comes back with the keys reordered", (t) => {
  const web = repoOf(CONFIG, "acme/web");
  const harness = renderEntry(t, web);
  const root = harness.root;
  expandRepo(root, "acme/web");
  expandGroup(root, "lint");

  // What a save coming back does: the entry is replaced with the stored one,
  // whose key order is whatever the response carries. jsonb does not hand back
  // the order that went up, and a restore can bypass the canonical ordering
  // entirely.
  harness.set({
    ...web,
    groups: { lint: web.groups!.lint, checks: web.groups!.checks },
  });

  // Keyed by index, the open card would now be whichever group landed first.
  assert.ok(
    root.findByProps({ name: "lint" }).findAll((n) => n.type === "input")[0],
    "the card that was open is still the one that is open",
  );
  assert.equal(root.findByProps({ name: "checks" }).findAll((n) => n.type === "input").length, 0);
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
  const { root } = renderScreen(t, undefined, CONFIG, { repoPath: "acme/legacy" });
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
  const { root, calls } = renderScreen(t, undefined, initialOf(ENV_CONFIG), {
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

// ── A repository with no scripts yet ────────────────────────────────────────

test("a repository with no scripts yet is born empty, with a hint instead of an error", (t) => {
  // No entry at all is a legitimate profile, the way a repository absent from
  // the old global configuration was: adding one is a click, not a repository
  // picker, because the repository is already the page.
  const harness = renderEntry(t, null);
  const { root } = harness;
  assert.match(nodeText(root), /No script groups\./);
  assert.equal(harness.blocker(), null, "a repository nobody configured is not a mistake");

  act(() => {
    button(root, "Add script groups").props.onClick();
  });

  const card = () => repoCard(root, "acme/web");
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
  const { root, calls } = renderScreen(t);
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
  // Save's own disabled state now belongs to the entry page, which arms it on a
  // dirty draft; what this editor owes is an entry the cancel left alone.
  assert.deepEqual(
    submittedConfig(calls).repositories[0],
    repoOf(CONFIG),
    "cancelling changed nothing to save",
  );
});

// ── Manual entry and the repository catalog ─────────────────────────────────

// ── History ─────────────────────────────────────────────────────────────────

// ── Legacy entries and the per-command timeout ──────────────────────────────

test("a legacy card says which group it runs as and stays honest about converting", (t) => {
  const { root } = renderScreen(t, undefined, CONFIG, { repoPath: "acme/legacy" });
  const legacy = () => repoCard(root, "acme/legacy");

  // The group name is what a workflow block has to spell to reach these
  // commands, so the card says it rather than leaving it to be guessed.
  assert.match(nodeText(legacy()), /the engine runs it as the single group "checks"\./);

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
  const { root } = renderScreen(t, undefined, initialOf(ENV_CONFIG), {
    allowedEnv: ["NPM_TOKEN"],
  });

  // OLD_TOKEN is stored and off the list: blocking Save on it would trap an
  // operator in an editor that cannot even save the edit removing it.
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
    saveBarText(),
    /Save is disabled: env var OTHER_TOKEN is not allowlisted on this worker; the save will be rejected\./,
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
  const { root } = renderEntry(t, repoOf(TWO_COMMAND_CONFIG), {
    createNodeMock: (element) => ({
      focus: () => focused.push(String(element.props["aria-label"])),
    }),
  });
  expandGroup(root, "checks");

  act(() => {
    root.findByProps({ "aria-label": "Move command 1 down" }).props.onClick();
  });
  assert.deepEqual(focused, ["Move command 2 down"], "focus follows the row, not the position");
});

// ── The Save blocker as a way back ──────────────────────────────────────────

// ── Preview feedback ────────────────────────────────────────────────────────

// ── Discard ─────────────────────────────────────────────────────────────────
