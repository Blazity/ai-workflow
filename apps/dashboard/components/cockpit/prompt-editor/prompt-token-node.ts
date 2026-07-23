import { Node as TiptapNode, PasteRule, mergeAttributes } from "@tiptap/core";
import {
  findCanonicalPromptTokens,
  parseCanonicalPromptToken,
  promptTokenNodeAttributes,
} from "@/lib/prompt-library/canonical-tokens";
export {
  findCanonicalPromptTokens,
  parseCanonicalPromptToken,
  promptTokenNodeAttributes,
} from "@/lib/prompt-library/canonical-tokens";

function promptTokenPasteMatches(text: string) {
  return findCanonicalPromptTokens(text).map((token) => ({
    index: token.start,
    text: token.raw,
    data: promptTokenNodeAttributes(token.raw) ?? undefined,
  }));
}

export const PromptTokenNode = TiptapNode.create({
  name: "promptToken",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      kind: { default: "data" },
      token: { default: "" },
      value: { default: "" },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-prompt-token]",
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const token = element.dataset.promptToken;
          return token ? promptTokenNodeAttributes(token) ?? false : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const token = String(node.attrs.token ?? "");
    const kind = String(node.attrs.kind ?? "data");
    const label = String(node.attrs.label ?? token);
    const glyph = kind === "data" ? "↳" : kind === "prompt" ? "❡" : "◇";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-prompt-token": token,
        "data-prompt-token-kind": kind,
        contenteditable: "false",
        title: token,
        class:
          "mx-0.5 inline-flex max-w-[260px] items-center gap-1 rounded-full border border-mariner-200 bg-mariner-100 px-2 py-0.5 align-baseline font-mono text-[10px] text-mariner",
      }),
      `${glyph} ${label}`,
    ];
  },

  renderText({ node }) {
    return String(node.attrs.token ?? "");
  },

  markdownTokenName: "promptToken",

  markdownTokenizer: {
    name: "promptToken",
    level: "inline",
    start(source: string) {
      return findCanonicalPromptTokens(source)[0]?.start ?? -1;
    },
    tokenize(source: string) {
      const parsed = parseCanonicalPromptToken(source);
      if (!parsed || parsed.start !== 0) return undefined;
      return {
        type: "promptToken",
        raw: parsed.raw,
        attributes: promptTokenNodeAttributes(parsed.raw),
      };
    },
  },

  parseMarkdown(token, helpers) {
    const raw = String(token.raw ?? "");
    const attributes =
      promptTokenNodeAttributes(raw) ??
      (token.attributes as ReturnType<typeof promptTokenNodeAttributes>);
    return attributes
      ? helpers.createNode("promptToken", attributes)
      : helpers.createTextNode(raw);
  },

  renderMarkdown(node) {
    return String(node.attrs?.token ?? "");
  },

  addPasteRules() {
    return [
      new PasteRule({
        find: promptTokenPasteMatches,
        handler: ({ state, range, match, chain }) => {
          const code = state.schema.marks.code;
          if (
            code &&
            (state.doc.rangeHasMark(range.from, range.to, code) ||
              state.doc.resolve(range.from).marks().some((mark) => mark.type === code))
          ) {
            return null;
          }
          const attributes = match.data;
          if (!attributes) return null;
          chain()
            .deleteRange(range)
            .insertContentAt(range.from, {
              type: this.name,
              attrs: attributes,
            })
            .run();
        },
      }),
    ];
  },
});
