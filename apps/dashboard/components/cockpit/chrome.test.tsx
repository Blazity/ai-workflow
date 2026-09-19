// The sidebar, at the widths and in the states people actually meet it: an
// expanded column, the collapsed rail, a group somebody folded away, and an
// integration's area that has no entry of its own because nobody connected it.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { CkSidebar } from "./chrome";
import type { CockpitIntegration } from "@/lib/cockpit/navigation";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const demo: CockpitIntegration = { id: "demo", name: "Demo", pages: [], usable: true };
const gitlab: CockpitIntegration = { id: "gitlab", name: "GitLab", pages: [], usable: true };

function render(
  t: TestContext,
  props: Partial<React.ComponentProps<typeof CkSidebar>> = {},
): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <CkSidebar active="overview" onNav={() => {}} integrations={[demo]} {...props} />,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

/** Every navigation entry, in the order the column draws them. */
function entries(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.type === "a" && typeof node.props.href === "string")
    .map((node) => String(node.props["aria-label"] ?? ""));
}

/** The group headings, which are the only buttons that fold something and are
 *  not the rail's own collapse toggle (that one carries an aria-label). */
function groupHeaders(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    (node) =>
      node.type === "button" &&
      node.props["aria-expanded"] !== undefined &&
      node.props["aria-label"] === undefined,
  );
}

test("the product's groups come first, then a separator, then Integrations", (t) => {
  const root = render(t, { integrations: [demo, gitlab] });
  const drawn = entries(root);
  const separators = root.findAll((node) => node.props.role === "separator");
  assert.equal(separators.length, 1, "one line divides what we build from what was connected");

  assert.deepEqual(drawn, [
    "Overview",
    "Workflow runs",
    "Approvals",
    "Prompts",
    "Memory",
    "Arthur evals",
    "Cost & usage",
    "Workflow editor",
    "Harness profiles",
    "Repositories",
    "Settings",
    "All integrations",
    "Demo",
    "GitLab",
  ]);
});

test("an integration nobody connected has no entry", (t) => {
  const root = render(t, { integrations: [{ ...demo, usable: false }, gitlab] });
  assert.deepEqual(entries(root).slice(-2), ["All integrations", "GitLab"]);
});

test("opening a disconnected integration lights the section it belongs to", (t) => {
  // Its own entry is not there, and lighting nothing would leave somebody
  // inside an area with no idea which part of the product they are in.
  const root = render(t, {
    active: "integration:demo",
    integrations: [{ ...demo, usable: false }],
  });
  const lit = root
    .findAll((node) => node.type === "a" && node.props["aria-current"] === "page")
    .map((node) => String(node.props["aria-label"]));
  assert.deepEqual(lit, ["All integrations"]);
});

test("the collapsed rail names every entry it can only draw as a mark", (t) => {
  const root = render(t, { collapsed: true, integrations: [demo, gitlab] });
  const rail = root.findAll((node) => node.type === "a" && typeof node.props.href === "string");
  for (const item of rail) {
    assert.ok(item.props.title, `an entry in the rail with no tooltip: ${item.props["aria-label"]}`);
    assert.equal(item.props.title, item.props["aria-label"]);
  }
  // A monogram rather than a letter, so GitHub and GitLab are not both G.
  const marks = new Set(
    rail
      .flatMap((node) => node.findAll(() => true))
      .flatMap((node) => node.children.filter((child) => typeof child === "string")),
  );
  assert.ok(marks.has("DE"), "Demo is drawn as DE");
  assert.ok(marks.has("GL"), "GitLab is drawn as GL");
  // No headings in the rail: there is no room and nothing to read them by.
  assert.equal(groupHeaders(root).length, 0);
});

test("only the entries scroll, and the column says when they do", (t) => {
  // The measured fact this exists for: five integrations with every group open
  // needs 859 px, which fits 1080 and does not fit a 1280x800 laptop. It has to
  // scroll there rather than push Settings off the bottom, and macOS hides an
  // overlay scrollbar nobody has touched, so the edge has to be drawn.
  const root = render(t, { integrations: [demo, gitlab] });
  const scrollers = root.findAll((node) => node.props["data-cockpit-nav-scroll"] !== undefined);
  assert.equal(scrollers.length, 1, "one scroll region, not the whole column");
  const classes = String(scrollers[0]!.props.className ?? "");
  assert.match(classes, /\boverflow-y-auto\b/u);
  assert.match(classes, /\bmin-h-0\b/u, "without it a flex child never scrolls, it grows");
  assert.match(classes, /\bck-scroll-cue\b/u, "a scrollable column with no edge is a hidden fold");
  // The logo and the collapse toggle stay put: a scrolled sidebar that loses
  // its own collapse control is a sidebar you cannot get out of.
  assert.equal(scrollers[0]!.findAll((node) => node.type === "button").length, 4);
});

test("folding a group hides its entries and keeps its heading", (t) => {
  const open = render(t, { collapsedGroups: [] });
  assert.ok(entries(open).includes("Workflow runs"));

  const folded = render(t, { collapsedGroups: ["obs"] });
  const drawn = entries(folded);
  assert.ok(!drawn.includes("Workflow runs"), "a folded group shows none of its entries");
  assert.ok(drawn.includes("Settings"), "and folds nothing else");
  const headers = groupHeaders(folded);
  assert.equal(headers.length, 4, "three core groups and Integrations, all still headed");
  assert.equal(
    headers.filter((header) => header.props["aria-expanded"] === false).length,
    1,
    "exactly the folded one says it is folded",
  );
});

test("the Integrations section folds like any other", (t) => {
  const root = render(t, { collapsedGroups: ["integrations"], integrations: [demo] });
  const drawn = entries(root);
  assert.ok(!drawn.includes("Demo"));
  assert.ok(!drawn.includes("All integrations"));
  assert.ok(drawn.includes("Settings"));
});

test("an entry is a real link, and a plain click stays inside the cockpit's guard", (t) => {
  const asked: string[] = [];
  const root = render(t, { integrations: [demo], onNav: (id) => asked.push(id) });
  const demoEntry = root.find(
    (node) => node.type === "a" && node.props["aria-label"] === "Demo",
  );
  assert.equal(demoEntry.props.href, "/integrations/demo");

  let prevented = 0;
  act(() => {
    demoEntry.props.onClick({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented += 1;
      },
    });
  });
  assert.deepEqual(asked, ["integration:demo"]);
  assert.equal(prevented, 1, "a plain click is handled here, so the unsaved-work guard runs");

  // A cmd-click belongs to the browser: it opens a tab, and swallowing it would
  // make the sidebar the one place in the product where that stopped working.
  act(() => {
    demoEntry.props.onClick({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented += 1;
      },
    });
  });
  assert.deepEqual(asked, ["integration:demo"], "a modified click is not a cockpit navigation");
  assert.equal(prevented, 1);
});
