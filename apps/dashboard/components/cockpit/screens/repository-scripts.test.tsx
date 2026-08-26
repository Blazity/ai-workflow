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

const INITIAL: PrePrChecksResponse = {
  current: versionOf(CONFIG, 1),
  versions: [versionOf(CONFIG, 1)],
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
): { root: ReactTestInstance; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(init?.body ? JSON.parse(String(init.body)) : undefined);
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={INITIAL} canEdit />);
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
  const initial: PrePrChecksResponse = {
    current: versionOf(config, 1),
    versions: [versionOf(config, 1)],
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RepositoryScriptsScreen initial={initial} canEdit />);
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

/** The name field of every group card, in render order. */
function groupNameInputs(root: ReactTestInstance): ReactTestInstance[] {
  return root
    .findAll(
      (node) =>
        typeof node.type === "function" && (node.type as { name?: string }).name === "GroupCard",
    )
    .map((card) => card.findAll((node) => node.type === "input")[0]);
}

function submittedConfig(calls: FetchCall[]): PrePrCheckConfig {
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/pre-pr-checks");
  assert.equal(calls[0].init?.method, "PUT");
  return (JSON.parse(String(calls[0].init?.body)) as { config: PrePrCheckConfig }).config;
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

test("clearing the last gate group omits gateGroups instead of sending an empty array", async (t) => {
  const { root, calls } = renderScreen(t);

  const gateChecksBox = root.findByProps({ "aria-label": "Gate on group checks" });
  act(() => {
    gateChecksBox.props.onChange({ target: { checked: false } });
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });

  const sent = submittedConfig(calls);
  assert.equal("gateGroups" in sent.repositories[0], false);
});

test("converting a legacy repository to groups preserves its commands and still round-trips", async (t) => {
  const { root, calls } = renderScreen(t);

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
  act(() => {
    root
      .findByProps({ name: "lint" })
      .findAll((node) => node.type === "button" && nodeText(node).includes("Remove group"))[0]
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

  const setupInput = root.findAll(
    (node) => node.type === "input" && node.props.value === "make bootstrap",
  )[0];
  act(() => {
    setupInput.props.onChange({ target: { value: "make bootstrap-fast" } });
  });

  await act(async () => {
    saveButton(root).props.onClick();
  });

  assert.equal(calls.length, 1);
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

  // The legacy flat-commands shape is server-side .strict() with no env key,
  // so saving env names on it 400s; the editor stays hidden until conversion.
  const repoCards = root.findAll(
    (node) => typeof node.type === "function" && (node.type as { name?: string }).name === "RepoCard",
  );
  assert.equal(repoCards.length, 2);
  const legacyCard = repoCards[1];

  assert.doesNotMatch(nodeText(legacyCard), /Env vars forwarded/);
  assert.match(
    nodeText(legacyCard),
    /Convert to groups to add environment variables\. The legacy command-list shape does not support them\./,
  );

  act(() => {
    button(root, "Convert to groups").props.onClick();
  });

  assert.match(nodeText(legacyCard), /Env vars forwarded/);
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

  const checksCard = root.findByProps({ name: "checks" });
  const lintCard = root.findByProps({ name: "lint" });

  // CONFIG gates on ["checks"] alone, so only the "checks" card is the one
  // whose removal would silently flip the gate to "all groups".
  assert.match(
    nodeText(checksCard),
    /This is the only group Gate groups selects\. Removing it will leave nothing selected\. Now gating on all groups\./,
  );
  assert.doesNotMatch(nodeText(lintCard), /Now gating on all groups\./);
});

test("a group name colliding with a sibling keeps every keystroke and shows a hint instead of freezing", (t) => {
  const { root } = renderScreen(t);

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

  const checksCard = root.findByProps({ name: "checks" });
  const nameInput = checksCard.findAll((node) => node.type === "input")[0];

  act(() => {
    nameInput.props.onChange({ target: { value: "constructor" } });
  });

  // `in` walks the prototype chain and would have treated "constructor" as
  // permanently taken; Object.hasOwn checks only the group's own keys.
  assert.equal(nameInput.props.value, "constructor");
  assert.doesNotMatch(nodeText(checksCard), /already exists/);
  assert.ok(
    root.findByProps({ name: "constructor" }),
    "the rename must commit instead of being treated as a prototype-key collision",
  );
});

test("a colliding rename draft blocks Save with a named blocker, and the committed name stays unchanged on the wire", async (t) => {
  const { root, calls } = renderScreen(t);

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

  // A legal name commits exactly as before and clears the blocker.
  act(() => {
    groupNameInputs(root)[1].props.onChange({ target: { value: "two-fa" } });
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

  const repoCards = root.findAll(
    (node) => typeof node.type === "function" && (node.type as { name?: string }).name === "RepoCard",
  );
  const legacyCard = repoCards[1];
  assert.match(nodeText(legacyCard), /Commands \(legacy\)/);
  assert.doesNotMatch(nodeText(legacyCard), /\bChecks\b/);
});

