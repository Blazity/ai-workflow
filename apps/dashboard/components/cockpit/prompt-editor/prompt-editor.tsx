"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { VariableHighlight } from "./variable-highlight";
import { VariablePickerPopover } from "@/components/cockpit/prompt-library/variable-picker-popover";
import { AVAILABLE_VARIABLES } from "@/lib/prompt-library/variables";
import { useEnterExit } from "@/lib/use-enter-exit";

export interface PromptEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  syncRequest?: { id: number; mode: "replace" | "append" } | null;
  disabled?: boolean;
  /** Tailwind min-height for the editing surface (ignored when `fill`). */
  minHeightClass?: string;
  /** Fill the parent's height with an internal scroll (toolbar stays pinned).
   *  Use inside bounded containers like the editor modal. */
  fill?: boolean;
  autoFocus?: boolean;
}

const toolBtn =
  "appearance-none cursor-pointer inline-flex items-center justify-center h-7 min-w-7 px-1.5 rounded-[3px] border border-transparent font-mono text-[11px] text-neutral-600 transition-[background-color,color,transform] duration-150 ease-standard hover:bg-off-white active:scale-[0.96] disabled:opacity-40 disabled:cursor-default";
const toolBtnActive = "bg-mariner-100 text-mariner border-mariner-200";
const toolSep = "mx-0.5 h-4 w-px self-center bg-neutral-200";

type Action = { key: string; label: string; title: string; run: () => void; active: boolean };

function useEditorActions(editor: Editor | null): Action[] {
  if (!editor) return [];
  const c = () => editor.chain().focus();
  return [
    { key: "h1", label: "H1", title: "Heading 1", run: () => c().toggleHeading({ level: 1 }).run(), active: editor.isActive("heading", { level: 1 }) },
    { key: "h2", label: "H2", title: "Heading 2", run: () => c().toggleHeading({ level: 2 }).run(), active: editor.isActive("heading", { level: 2 }) },
    { key: "h3", label: "H3", title: "Heading 3", run: () => c().toggleHeading({ level: 3 }).run(), active: editor.isActive("heading", { level: 3 }) },
    { key: "bold", label: "B", title: "Bold", run: () => c().toggleBold().run(), active: editor.isActive("bold") },
    { key: "bullet", label: "•", title: "Bullet list", run: () => c().toggleBulletList().run(), active: editor.isActive("bulletList") },
    { key: "ordered", label: "1.", title: "Numbered list", run: () => c().toggleOrderedList().run(), active: editor.isActive("orderedList") },
    { key: "code", label: "‹›", title: "Inline code", run: () => c().toggleCode().run(), active: editor.isActive("code") },
  ];
}

/**
 * Right-click context menu, opened at the pointer. Two pages: the block actions
 * plus an "Insert variable" entry that swaps in a scrollable variable list at the
 * SAME position — so variables land where you right-clicked instead of at a
 * (possibly scrolled-away) toolbar anchor. Portalled, animates in/out.
 */
function ContextMenu({
  at,
  actions,
  onInsertVariable,
  onClose,
}: {
  at: { x: number; y: number } | null;
  actions: Action[];
  onInsertVariable: (token: string) => void;
  onClose: () => void;
}) {
  const { mounted, state } = useEnterExit(at !== null, 150);
  const ref = useRef<HTMLDivElement>(null);
  const posRef = useRef(at);
  if (at) posRef.current = at;
  const [page, setPage] = useState<"actions" | "vars">("actions");

  // Each fresh open starts on the actions page.
  useEffect(() => {
    if (at) setPage("actions");
  }, [at]);

  useEffect(() => {
    if (at === null) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, [at, onClose]);

  if (!mounted || !posRef.current) return null;
  const p = posRef.current;
  const left = Math.min(p.x, window.innerWidth - 248);
  const top = Math.min(p.y, window.innerHeight - 340);

  const itemCls =
    "block w-full appearance-none cursor-pointer border-none bg-transparent px-3 py-1.5 text-left font-body text-[12px] text-neutral-700 transition-colors duration-150 hover:bg-off-white hover:text-neutral-900";

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-state={state}
      style={{ left, top }}
      className={`fixed z-[120] min-w-[224px] overflow-hidden rounded-md border border-neutral-200 bg-panel py-1 shadow-[0_16px_40px_-12px_rgba(24,27,32,0.35)] origin-top-left transition-[opacity,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:transform-none ${
        state === "open" ? "opacity-100 scale-100" : "opacity-0 scale-[0.97]"
      }`}
    >
      {page === "actions" ? (
        <>
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                a.run();
                onClose();
              }}
              className={itemCls}
            >
              {a.title}
            </button>
          ))}
          <div className="my-1 h-px bg-neutral-200" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPage("vars")}
            className={`${itemCls} flex items-center justify-between`}
          >
            Insert variable <span className="text-neutral-400">›</span>
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPage("actions")}
            className={`${itemCls} text-mariner`}
          >
            ‹ Back
          </button>
          <div className="my-1 h-px bg-neutral-200" aria-hidden="true" />
          <div className="max-h-[240px] overflow-y-auto">
            {AVAILABLE_VARIABLES.map((spec) => (
              <button
                key={spec.name}
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onInsertVariable(`{{${spec.name}}}`);
                  onClose();
                }}
                className="block w-full appearance-none cursor-pointer border-none bg-transparent px-3 py-1.5 text-left transition-colors duration-150 hover:bg-off-white"
              >
                <div className="font-mono text-[11px] text-neutral-900">{spec.name}</div>
                <div className="text-[10px] leading-[1.4] text-neutral-500">{spec.description}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * WYSIWYG prompt editor (Tiptap). The markdown string stays the source of truth:
 * content loads via the markdown extension and every edit serializes back to
 * markdown through `onChange`. A "Raw" toggle drops to a plain markdown textarea
 * as an escape hatch for code/JSON-heavy prompts where round-trip normalization
 * is unwanted. {{variables}} are highlighted (not nodes) so they round-trip
 * untouched.
 */
export function PromptEditor({ value, onChange, syncRequest, disabled, minHeightClass, fill, autoFocus }: PromptEditorProps) {
  const [raw, setRaw] = useState(false);
  const [varOpen, setVarOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const varAnchorRef = useRef<HTMLButtonElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const rawScrollRef = useRef<HTMLTextAreaElement>(null);
  const handledSyncRequest = useRef<number | null>(null);
  // True while we push content into the editor programmatically, so the resulting
  // transaction does not echo back through onChange and dirty the field.
  const settingRef = useRef(false);

  const surfaceMinH = fill ? "min-h-full" : (minHeightClass ?? "min-h-[220px]");

  const editor = useEditor({
    editable: !disabled,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] } }), Markdown, VariableHighlight],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: { class: `ck-prose ${surfaceMinH} focus:outline-none` },
    },
    onUpdate: ({ editor }) => {
      if (settingRef.current) return;
      onChange(editor.getMarkdown());
    },
  });

  useEffect(() => {
    if (!editor || !autoFocus) return;
    const frame = requestAnimationFrame(() => editor.commands.focus("end"));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, editor]);

  // Keep the editor in sync when `value` changes from the outside (library insert,
  // provider switch, raw-mode edits). Guarded so it never fights user typing:
  // after a user edit, value already equals getMarkdown(), so this is a no-op.
  useEffect(() => {
    if (!editor || raw) return;
    if (value === editor.getMarkdown()) return;
    settingRef.current = true;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    settingRef.current = false;
  }, [value, editor, raw]);

  // Library actions carry their intent explicitly. Do not infer append vs.
  // replace from serialized markdown because Tiptap normalizes that string.
  useEffect(() => {
    if (!syncRequest || handledSyncRequest.current === syncRequest.id) return;
    handledSyncRequest.current = syncRequest.id;
    const frame = requestAnimationFrame(() => {
      const surface = raw ? rawScrollRef.current : editorScrollRef.current;
      if (!surface) return;
      surface.scrollTop = syncRequest.mode === "append" ? surface.scrollHeight : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [syncRequest, raw]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  const actions = useEditorActions(editor);
  const insertVariable = (token: string) => editor?.chain().focus().insertContent(token).run();

  return (
    <div
      className={`flex w-full min-w-0 flex-col overflow-hidden rounded-[3px] border border-neutral-200 bg-panel ${
        fill ? "h-full min-h-0" : ""
      }`}
    >
      {/* Toolbar (pinned). Wraps to a second row in narrow hosts (e.g. the flow
          inspector) so buttons never overlap; stays single-line where it fits. */}
      <div className="flex flex-wrap shrink-0 items-center gap-y-1 gap-x-0.5 border-b border-neutral-200 px-1.5 py-1">
        {!raw &&
          actions.map((a) => (
            <span key={a.key} className="flex items-center">
              {(a.key === "bold" || a.key === "bullet") && <span className={toolSep} aria-hidden="true" />}
              <button
                type="button"
                title={a.title}
                aria-pressed={a.active}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={a.run}
                className={`${toolBtn} ${a.active ? toolBtnActive : ""} ${a.key === "bold" ? "font-bold" : ""}`}
              >
                {a.label}
              </button>
            </span>
          ))}
        {!raw && (
          <button
            ref={varAnchorRef}
            type="button"
            title="Insert variable"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setVarOpen((o) => !o)}
            className={`${toolBtn} ml-0.5 gap-1 px-2 text-mariner`}
          >
            <span className="text-[13px] leading-none">+</span> Variable
          </button>
        )}
        <button
          type="button"
          onClick={() => setRaw((r) => !r)}
          className={`${toolBtn} ml-auto uppercase tracking-[0.04em] ${raw ? toolBtnActive : ""}`}
          title="Toggle raw markdown"
        >
          Raw
        </button>
      </div>

      {/* Surface (scrolls internally when fill) */}
      {raw ? (
        <textarea
          ref={rawScrollRef}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full min-w-0 border-none bg-panel px-3 py-2 font-mono text-[12px] leading-[1.6] text-coal outline-none ${
            fill ? "min-h-0 flex-1 resize-none" : `resize-y ${minHeightClass ?? "min-h-[220px]"}`
          }`}
        />
      ) : (
        <div
          ref={editorScrollRef}
          onContextMenu={(e) => {
            if (disabled) return;
            e.preventDefault();
            setMenuAt({ x: e.clientX, y: e.clientY });
          }}
          className={`px-3 py-2.5 ${fill ? "min-h-0 flex-1 overflow-y-auto" : ""}`}
        >
          <EditorContent editor={editor} />
        </div>
      )}

      <VariablePickerPopover
        open={varOpen}
        anchorRef={varAnchorRef}
        onPick={(token) => {
          insertVariable(token);
          setVarOpen(false);
        }}
        onClose={() => setVarOpen(false)}
      />
      <ContextMenu
        at={menuAt}
        actions={actions}
        onInsertVariable={insertVariable}
        onClose={() => setMenuAt(null)}
      />
    </div>
  );
}
