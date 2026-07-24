"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type {
  WorkflowDataCatalogEntry,
} from "@shared/contracts";
import {
  findCanonicalPromptTokens,
  PromptTokenNode,
  promptTokenNodeAttributes,
} from "@/components/cockpit/prompt-editor/prompt-token-node";
import {
  textTemplateCompatibility,
  WorkflowDataPicker,
} from "./workflow-data-picker";

interface TiptapJsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: TiptapJsonNode[];
}

export function textTemplateDocument(value: string): TiptapJsonNode {
  return {
    type: "doc",
    content: value.split("\n").map((line) => {
      const content: TiptapJsonNode[] = [];
      let offset = 0;
      for (const token of findCanonicalPromptTokens(line)) {
        if (token.start > offset) {
          content.push({
            type: "text",
            text: line.slice(offset, token.start),
          });
        }
        const attrs = promptTokenNodeAttributes(token.raw);
        if (attrs) {
          content.push({
            type: PromptTokenNode.name,
            attrs,
          });
        } else {
          content.push({ type: "text", text: token.raw });
        }
        offset = token.end;
      }
      if (offset < line.length) {
        content.push({ type: "text", text: line.slice(offset) });
      }
      return {
        type: "paragraph",
        ...(content.length === 0 ? {} : { content }),
      };
    }),
  };
}

export function textTemplateValue(document: TiptapJsonNode): string {
  return (document.content ?? [])
    .map((paragraph) =>
      (paragraph.content ?? [])
        .map((node) => {
          if (node.type === "text") return node.text ?? "";
          if (node.type === PromptTokenNode.name) {
            return String(node.attrs?.token ?? "");
          }
          return "";
        })
        .join(""),
    )
    .join("\n");
}

export function WorkflowTextTemplateEditor({
  value,
  entries,
  disabled,
  refreshing,
  minHeightClass = "min-h-[96px]",
  singleLine = false,
  onChange,
}: {
  value: string;
  entries: readonly WorkflowDataCatalogEntry[];
  disabled?: boolean;
  refreshing?: boolean;
  minHeightClass?: string;
  singleLine?: boolean;
  onChange: (value: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const setting = useRef(false);
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        listItem: false,
        orderedList: false,
        strike: false,
      }),
      PromptTokenNode,
    ],
    [],
  );
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions,
    content: textTemplateDocument(value),
    editorProps: {
      attributes: {
        class: `${minHeightClass} whitespace-pre-wrap px-3 py-2.5 font-body text-[12px] leading-[1.55] text-coal focus:outline-none`,
      },
      handleKeyDown: (_view, event) =>
        singleLine && event.key === "Enter",
    },
    onUpdate: ({ editor: current }) => {
      if (setting.current) return;
      const next = textTemplateValue(current.getJSON() as TiptapJsonNode);
      onChange(singleLine ? next.replaceAll("\n", " ") : next);
    },
  }, [singleLine]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) return;
    const current = textTemplateValue(editor.getJSON() as TiptapJsonNode);
    if (current === value) return;
    setting.current = true;
    editor.commands.setContent(textTemplateDocument(value), {
      emitUpdate: false,
    });
    setting.current = false;
  }, [editor, value]);

  return (
    <div className="overflow-hidden rounded-[3px] border border-neutral-200 bg-panel">
      <div className="flex items-center border-b border-neutral-200 px-1.5 py-1">
        <button
          type="button"
          aria-label="Insert workflow value"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setPickerOpen(true)}
          className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-transparent bg-transparent px-2 font-mono text-[10px] text-mariner hover:bg-off-white disabled:opacity-40"
        >
          <span className="text-[13px]" aria-hidden>
            +
          </span>
          Value
        </button>
        {refreshing && (
          <span className="ml-auto pr-2 font-body text-[10px] text-mariner">
            Refreshing values…
          </span>
        )}
      </div>
      <EditorContent editor={editor} />
      <WorkflowDataPicker
        open={pickerOpen}
        entries={entries}
        compatibility={textTemplateCompatibility}
        refreshing={refreshing}
        onClose={() => setPickerOpen(false)}
        onSelect={(entry) => {
          const token = `{{data:${entry.reference}}}`;
          const attrs = promptTokenNodeAttributes(token);
          if (!attrs || !editor) return;
          editor
            .chain()
            .focus()
            .insertContent({
              type: PromptTokenNode.name,
              attrs,
            })
            .run();
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
