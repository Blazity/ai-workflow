import type { AnyExtension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

import { PromptTokenNode } from "./prompt-token-node";
import { VariableHighlight } from "./variable-highlight";

/**
 * The schema the prompt editor edits with.
 *
 * Its own module so the round-trip check can be run against the same list the
 * editor mounts, without loading the React component. A check built from a
 * second, hand-kept list would answer for a document the editor never sees, and
 * would drift the first time a node is added here.
 */
export function promptEditorExtensions(options: {
  canonical: boolean;
  variableNames: readonly string[];
}): AnyExtension[] {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    Markdown,
    ...(options.canonical
      ? [PromptTokenNode]
      : [VariableHighlight.configure({ known: options.variableNames })]),
  ];
}
