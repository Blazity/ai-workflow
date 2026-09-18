import assert from "node:assert/strict";
import test from "node:test";
import {
  containsPlaceholderOutsideTokens,
  parsePromptDataTokens,
} from "./prompt-slots";

const authoredPlaceholder = (text: string) =>
  containsPlaceholderOutsideTokens(text, parsePromptDataTokens(text));

test("a placeholder counts only in text the author wrote around the tokens", () => {
  assert.equal(authoredPlaceholder("Ship {{data:steps.entry.output.ticketKey}}"), false);
  assert.equal(authoredPlaceholder("Ship {{ticket_key}}"), true);
  assert.equal(authoredPlaceholder("Helm: use {{ .Values.image }}"), true);
  assert.equal(authoredPlaceholder("Close }} after {{data:run.id}}"), true);
});

test("braces split by a token are not a placeholder, because resolution never joins them", () => {
  // The value lands between the two braces, so the resolved text never holds
  // "{{" here either; counting it would refuse text that used to pass.
  assert.equal(authoredPlaceholder("{{{data:run.id}}{"), false);
  assert.equal(authoredPlaceholder("}{{data:run.id}}}"), false);
});
