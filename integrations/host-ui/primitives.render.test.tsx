// Every primitive, rendered once.
//
// `primitives.test.ts` reads the source, which catches a `className` escape
// hatch or an invented colour and catches nothing about the markup. These
// render each one and assert on the tree, so a heading that stopped being a
// heading, a table that dropped its column alignment, a chip that ignored its
// tone or a notice that stopped announcing itself go red here instead of
// shipping green.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import {
  Card,
  Chip,
  EmptyState,
  ExternalLink,
  KeyValue,
  Notice,
  Page,
  Section,
  Table,
} from "./index";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(element);
  });
  return renderer.root;
}

function text(root: ReactTestInstance): string {
  return root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
}

function classesOf(node: ReactTestInstance): string {
  return String(node.props.className ?? "");
}

test("Page gives a contributed page the cockpit's gutters and one h2", () => {
  const root = render(
    <Page title="Demo overview" description="What it does">
      <span>body</span>
    </Page>,
  );
  const headings = root.findAll((node) => node.type === "h2");
  assert.equal(headings.length, 1, "a page has exactly one page title");
  assert.deepEqual(headings[0]!.children, ["Demo overview"]);
  // 16 px at phone width, 24 px from lg up: the same gutters every cockpit
  // screen uses, which is what makes a contributed page line up with them.
  assert.match(classesOf(root.findByType("div")), /\bpx-4\b.*\blg:px-6\b/u);
  assert.match(text(root), /What it does/u);
  assert.match(text(root), /body/u);
});

test("Page renders no description paragraph when it has none", () => {
  const root = render(<Page title="Demo overview" />);
  assert.equal(root.findAll((node) => node.type === "p").length, 0);
});

test("Section is a section with an h3 under the page's h2", () => {
  const root = render(
    <Section title="Recent" description="Fixed rows">
      <span>rows</span>
    </Section>,
  );
  assert.equal(root.findAll((node) => node.type === "section").length, 1);
  assert.deepEqual(root.findByType("h3").children, ["Recent"]);
  assert.match(text(root), /Fixed rows/u);
});

test("Card draws the panel edge, and its title is not a heading", () => {
  const root = render(<Card title="Account">rows</Card>);
  const panel = root.findByType("div");
  assert.match(classesOf(panel), /border-neutral-200/u);
  assert.match(classesOf(panel), /bg-panel/u);
  // A card title is a label, not an outline level: a page of six cards would
  // otherwise read as six sections to a screen reader.
  assert.equal(root.findAll((node) => /^h[1-6]$/u.test(String(node.type))).length, 0);
  assert.match(text(root), /Account/u);
});

test("KeyValue is a description list, one dt and dd per item", () => {
  const root = render(
    <KeyValue
      items={[
        { label: "Workspace", value: "acme" },
        { label: "Channel", value: <Chip tone="success">general</Chip> },
      ]}
    />,
  );
  assert.equal(root.findAll((node) => node.type === "dl").length, 1);
  assert.deepEqual(
    root.findAll((node) => node.type === "dt").map((node) => node.children[0]),
    ["Workspace", "Channel"],
  );
  assert.equal(root.findAll((node) => node.type === "dd").length, 2);
  // A value may be another primitive, which is how a page shows a status.
  assert.match(text(root), /general/u);
});

test("Chip carries its tone's colours and nothing else changes", () => {
  const success = classesOf(render(<Chip tone="success">Connected</Chip>).findByType("span"));
  const failed = classesOf(render(<Chip tone="failed">Failing</Chip>).findByType("span"));
  const neutral = classesOf(render(<Chip>Unknown</Chip>).findByType("span"));
  assert.match(success, /bg-success-bg/u);
  assert.match(failed, /bg-fail-bg/u);
  assert.match(neutral, /bg-app-bg/u, "the default tone is the quiet one");
  assert.notEqual(success, failed, "two tones must not draw the same chip");
  for (const chip of [success, failed, neutral]) assert.match(chip, /rounded-pill/u);
});

test("a failed Notice is an alert and every other one is a status", () => {
  // The difference is whether a screen reader interrupts. A provider that
  // stopped answering is worth interrupting for; a line of context is not.
  assert.equal(render(<Notice tone="failed">Gone</Notice>).findByType("div").props.role, "alert");
  for (const tone of ["neutral", "success", "warning"] as const) {
    assert.equal(render(<Notice tone={tone}>Fine</Notice>).findByType("div").props.role, "status");
  }
});

test("EmptyState says something rather than being blank", () => {
  const root = render(<EmptyState>Nothing happened today.</EmptyState>);
  assert.match(classesOf(root.findByType("div")), /border-dashed/u);
  assert.match(text(root), /Nothing happened today\./u);
});

test("ExternalLink opens away from the cockpit and hands over no window", () => {
  const anchor = render(<ExternalLink href="https://example.com">Docs</ExternalLink>).findByType("a");
  assert.equal(anchor.props.href, "https://example.com");
  assert.equal(anchor.props.target, "_blank");
  assert.equal(anchor.props.rel, "noreferrer noopener");
});

test("Table draws a header cell per column and a body cell per column and row", () => {
  const root = render(
    <Table
      columns={[
        { key: "at", label: "When" },
        { key: "count", label: "Messages", align: "end" },
      ]}
      rows={[
        { key: "1", cells: { at: "09:14", count: "1" } },
        { key: "2", cells: { at: "08:02", count: "12" } },
      ]}
    />,
  );
  const headers = root.findAll((node) => node.type === "th");
  assert.deepEqual(headers.map((node) => node.children[0]), ["When", "Messages"]);
  assert.equal(headers[0]!.props.scope, "col", "a header cell says which axis it heads");
  assert.equal(root.findAll((node) => node.type === "tr").length, 3, "one header row and two rows");
  assert.equal(root.findAll((node) => node.type === "td").length, 4);
  // Comparable numbers line up on the right, which is the whole reason the
  // column carries an alignment at all.
  assert.match(classesOf(headers[1]!), /text-right/u);
  assert.match(classesOf(headers[0]!), /text-left/u);
  const cells = root.findAll((node) => node.type === "td");
  assert.match(classesOf(cells[1]!), /text-right/u);
  assert.match(classesOf(cells[0]!), /text-left/u);
});

test("an empty Table says so instead of drawing a header over nothing", () => {
  const root = render(
    <Table columns={[{ key: "at", label: "When" }]} rows={[]} empty="No activity yet." />,
  );
  assert.equal(root.findAll((node) => node.type === "table").length, 0);
  assert.match(text(root), /No activity yet\./u);
});
