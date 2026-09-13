import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "./field";
import { Input } from "./input";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Field links its label, hint, and error to the control", () => {
  const html = renderToStaticMarkup(
    <Field label="Ticket key" hint="Use the Jira key." error="Ticket not found." required>
      <Input id="ticket-key" />
    </Field>,
  );
  assert.match(html, /for="ticket-key"/);
  assert.match(html, /required=""/);
  assert.match(html, /aria-invalid="true"/);
  const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
  assert.ok(describedBy.includes("hint"));
  assert.ok(describedBy.includes("error"));
  assert.match(html, /role="alert"/);
});
