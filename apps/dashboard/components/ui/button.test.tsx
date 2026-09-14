import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, getButtonClassName, type ButtonVariant } from "./button";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Button renders every variant and size contract", () => {
  for (const variant of [
    "primary",
    "selected",
    "secondary",
    "ghost",
    "danger",
    "success",
    "danger-soft",
    "text",
  ] as ButtonVariant[]) {
    const html = renderToStaticMarkup(<Button variant={variant} size="sm">Run</Button>);
    assert.match(html, new RegExp(`data-variant="${variant}"`));
    assert.match(html, /data-size="sm"/);
    assert.match(html, /focus-visible:ring-2/);
    if (variant === "text") {
      assert.doesNotMatch(html, /active:scale-\[0\.98\]/);
    } else {
      assert.match(html, /active:scale-\[0\.98\]/);
    }
  }
});

test("Button text variant leaves geometry and typography to the caller", () => {
  const classes = getButtonClassName({ variant: "text", size: "sm", iconOnly: true });
  const tokens = classes.split(/\s+/);

  assert.ok(tokens.includes("inline-flex"));
  assert.ok(tokens.includes("items-center"));
  assert.ok(tokens.includes("gap-1.5"));
  assert.ok(tokens.includes("focus-visible:ring-2"));
  assert.ok(tokens.includes("disabled:opacity-40"));
  assert.equal(
    tokens.some((token) =>
      token === "border" ||
      token.startsWith("bg-") ||
      token.startsWith("p-") ||
      token.startsWith("px-") ||
      token.startsWith("h-") ||
      token.startsWith("size-") ||
      token.startsWith("font-") ||
      token.startsWith("rounded") ||
      token.startsWith("active:scale"),
    ),
    false,
  );

  const html = renderToStaticMarkup(
    <Button variant="text" className="font-mono text-[10px] text-neutral-400 hover:text-mariner">
      Edit
    </Button>,
  );
  assert.match(html, /font-mono text-\[10px\] text-neutral-400 hover:text-mariner/);
});

test("Button semantic variants preserve success and soft danger treatments", () => {
  const success = renderToStaticMarkup(<Button variant="success">Deploy</Button>);
  const dangerSoft = renderToStaticMarkup(<Button variant="danger-soft">1 block has an error</Button>);

  assert.match(success, /border-emerald-600 bg-emerald-600 text-white/);
  assert.match(dangerSoft, /border-red-400 bg-red-50 text-red-700/);
});

test("Button positioning yields to an explicit caller position utility", () => {
  const absolute = getButtonClassName({
    variant: "ghost",
    size: "sm",
    className: "absolute left-0",
  });
  const plain = getButtonClassName({ variant: "ghost", size: "sm" });

  assert.match(absolute, /(?:^|\s)absolute(?:\s|$)/);
  assert.doesNotMatch(absolute, /(?:^|\s)relative(?:\s|$)/);
  assert.match(plain, /(?:^|\s)relative(?:\s|$)/);
});

test("Button selected uses a persistent mariner tint", () => {
  const html = renderToStaticMarkup(<Button variant="selected">Selected</Button>);

  assert.match(html, /border-mariner-200/);
  assert.match(html, /bg-mariner-100/);
  assert.match(html, /text-mariner/);
  assert.match(html, /hover:bg-mariner-100/);
  assert.doesNotMatch(html, /bg-mariner text-white/);
});

test("Button preserves content width while loading and disables actions", () => {
  const html = renderToStaticMarkup(<Button loading leadingIcon={<span>+</span>}>Deploy workflow</Button>);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /opacity-0/);
  assert.match(html, /Deploy workflow/);
});

test("Button renders an anchor when href is supplied", () => {
  const html = renderToStaticMarkup(<Button href="/runs">View runs</Button>);
  assert.match(html, /^<a /);
  assert.match(html, /href="\/runs"/);
});
