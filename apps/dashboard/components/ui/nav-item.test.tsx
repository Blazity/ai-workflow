import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { BlazityLogo } from "../ui";
import { NavItem } from "./index";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("NavItem marks the active destination", () => {
  const html = renderToString(
    <NavItem label="Workflow runs" active onClick={() => undefined} />,
  );

  assert.match(html, /^<button /);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /bg-mariner-100 text-mariner/);
  assert.match(html, /data-nav-indicator=""/);
  assert.match(html, /font-body text-\[13px\] font-normal/);
});

test("BlazityLogo pins the flame geometry", () => {
  const html = renderToString(<BlazityLogo size={22} showWord={false} />);

  assert.match(html, /viewBox="0 0 246 257"/);
  assert.match(
    html,
    /d="M128\.528 50\.6272C114\.492 42\.8058 104\.235 38\.3392 104\.235 38\.3392L115\.695 65\.5526L0 0L61\.8541 124\.931L33\.3877 112\.562C33\.3877 112\.562 37\.6218 120\.293 42\.6744 131\.843C51\.6579 152\.377 58\.3274 170\.809 65\.2495 190\.696C77\.7597 226\.6 111\.865 256\.683 153\.731 256\.683C204\.671 256\.683 245\.971 215\.464 245\.971 164\.614C245\.971 125\.881 222\.002 92\.7256 188\.058 79\.134C167\.615 70\.9488 147\.759 61\.359 128\.518 50\.6373L128\.528 50\.6272Z"/,
  );
});
