import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPaletteItems } from "./blocks.ts";

test("new Generic Agent blocks default to no code workspace", () => {
  const generic = buildPaletteItems("claude-model")
    .flatMap((group) => group.items)
    .find((item) => item.type === "generic_agent");

  assert.deepEqual(generic?.params, {
    model: "claude-model",
    workspaceMode: "none",
  });
});
