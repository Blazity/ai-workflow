import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { AVAILABLE_VARIABLES } from "@/lib/prompt-library/variables";

const KNOWN = new Set(AVAILABLE_VARIABLES.map((v) => v.name));
const VAR_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const PROMPT_REF_RE = /\{\{prompt:[1-9]\d*(?:@(latest|[1-9]\d*))?\}\}/g;

/**
 * Highlights {{variable}} tokens inline via ProseMirror decorations.
 *
 * Variables stay literal text — the markdown serializer does not escape braces
 * (its escape set is ``\ ` * _ [ ] ~``), so `{{name}}` round-trips untouched.
 * Only the appearance is decorated: mariner when the name is a known placeholder,
 * warn otherwise. Tokens inside code marks or code blocks are left alone so JSON
 * examples that happen to contain braces are never styled.
 */
export const VariableHighlight = Extension.create({
  name: "variableHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("variableHighlight"),
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos, parent) => {
              if (!node.isText || !node.text) return;
              if (parent?.type.name === "codeBlock") return;
              if (node.marks.some((m) => m.type.name === "code")) return;
              const re = new RegExp(VAR_RE.source, "g");
              let m: RegExpExecArray | null;
              while ((m = re.exec(node.text)) !== null) {
                const from = pos + m.index;
                decos.push(
                  Decoration.inline(from, from + m[0].length, {
                    class: `ck-var ${KNOWN.has(m[1]) ? "ck-var-known" : "ck-var-unknown"}`,
                  }),
                );
              }
              const promptReferenceRe = new RegExp(PROMPT_REF_RE.source, "g");
              while ((m = promptReferenceRe.exec(node.text)) !== null) {
                const from = pos + m.index;
                decos.push(
                  Decoration.inline(from, from + m[0].length, {
                    class: "ck-var ck-prompt-ref",
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
