import assert from "node:assert/strict";
import test from "node:test";
import {
  markdownForDroppedPrompt,
  PROMPT_DRAG_MIME,
  readPromptDrag,
  writePromptDrag,
} from "./prompt-drag";

function dragEvent() {
  const values = new Map<string, string>();
  return {
    values,
    event: {
      dataTransfer: {
        effectAllowed: "none",
        setData(type: string, value: string) {
          values.set(type, value);
        },
        getData(type: string) {
          return values.get(type) ?? "";
        },
      },
    } as unknown as React.DragEvent,
  };
}

test("pinned prompt drag payload preserves the selected immutable version", () => {
  const { event, values } = dragEvent();
  writePromptDrag(event, {
    kind: "library-reference",
    slug: "implementation",
    label: "Implementation",
    version: 7,
  });

  assert.match(values.get(PROMPT_DRAG_MIME) ?? "", /"version":7/);
  assert.deepEqual(readPromptDrag(event), {
    kind: "library-reference",
    slug: "implementation",
    label: "Implementation",
    version: 7,
  });
});

test("legacy latest drag payload remains readable", () => {
  const { event } = dragEvent();
  writePromptDrag(event, {
    kind: "library-reference",
    slug: "implementation",
    label: "Implementation",
    version: "latest",
  });

  const payload = readPromptDrag(event);
  assert.equal(payload?.kind, "library-reference");
  assert.equal(
    payload?.kind === "library-reference" ? payload.version : null,
    "latest",
  );
});

test("shared drop formatting handles references and sections consistently", () => {
  assert.equal(
    markdownForDroppedPrompt({
      kind: "library-reference",
      slug: "implementation",
      label: "Implementation",
      version: 7,
    }),
    "{{prompt:implementation@7}}",
  );
  assert.equal(
    markdownForDroppedPrompt({
      kind: "library-reference",
      slug: "implementation",
      label: "Implementation",
    }),
    "{{prompt:implementation}}",
  );
  assert.equal(
    markdownForDroppedPrompt({
      kind: "library-section",
      markdown: "## Verify",
      label: "Verify",
    }),
    "## Verify",
  );
  assert.equal(
    markdownForDroppedPrompt({
      kind: "composer-block",
      blockId: "block-1",
      label: "Block",
    }),
    null,
  );
});
