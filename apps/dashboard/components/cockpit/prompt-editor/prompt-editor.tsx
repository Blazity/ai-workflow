"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import type { WorkflowAvailableValue } from "@shared/contracts";
import { VariableHighlight } from "./variable-highlight";
import { VariablePickerPopover } from "@/components/cockpit/prompt-library/variable-picker-popover";
import { AVAILABLE_VARIABLES } from "@/lib/prompt-library/variables";
import { useEnterExit } from "@/lib/use-enter-exit";
import {
  PromptTokenNode,
  promptTokenNodeAttributes,
} from "./prompt-token-node";
import { readPromptDrag } from "./prompt-drag";
import { formatPromptReferenceToken } from "@shared/contracts";

export interface PromptEditorSlotOption {
  name: string;
  description?: string | null;
}

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
  /** V2 turns canonical data, pinned prompt, and slot tokens into atomic chips. */
  authoringMode?: "v1" | "v2";
  /** Worker-owned values guaranteed to be available at the consuming block. */
  availableValues?: readonly WorkflowAvailableValue[];
  slots?: readonly PromptEditorSlotOption[];
  /** Compact prose fields keep formatting actions out of the toolbar. */
  compact?: boolean;
  /** Prevent line breaks for single-line fields such as a pull request title. */
  singleLine?: boolean;
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
  insertLabel,
  insertOptions,
  onInsert,
  onClose,
}: {
  at: { x: number; y: number } | null;
  actions: Action[];
  insertLabel: string;
  insertOptions: readonly PromptInsertOption[];
  onInsert: (token: string) => void;
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
            {insertLabel} <span className="text-neutral-400">›</span>
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
            {insertOptions.map((option) => (
              <button
                key={option.token}
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onInsert(option.token);
                  onClose();
                }}
                className="block w-full appearance-none cursor-pointer border-none bg-transparent px-3 py-1.5 text-left transition-colors duration-150 hover:bg-off-white"
              >
                <div className="font-mono text-[11px] text-neutral-900">{option.label}</div>
                {option.description && (
                  <div className="text-[10px] leading-[1.4] text-neutral-500">
                    {option.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

interface PromptInsertOption {
  token: string;
  label: string;
  description: string | null;
}

function CanonicalTokenPicker({
  open,
  anchorRef,
  options,
  ariaLabel,
  onPick,
  onClose,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  options: readonly PromptInsertOption[];
  ariaLabel: string;
  onPick: (token: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !anchorRef.current?.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [anchorRef, onClose, open]);

  if (!open || !anchorRef.current) return null;
  const rect = anchorRef.current.getBoundingClientRect();
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label={ariaLabel}
      style={{
        left: Math.min(rect.left, window.innerWidth - 328),
        top: Math.min(rect.bottom + 6, window.innerHeight - 320),
      }}
      className="fixed z-[120] max-h-[300px] w-[320px] overflow-y-auto rounded-md border border-neutral-200 bg-panel py-1 shadow-[0_16px_40px_-12px_rgba(24,27,32,0.35)]"
    >
      {options.length === 0 ? (
        <div className="px-3 py-4 font-body text-[11px] text-neutral-500">
          No values or slots are available here.
        </div>
      ) : (
        options.map((option) => (
          <button
            key={option.token}
            type="button"
            role="option"
            aria-selected="false"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onPick(option.token);
              onClose();
            }}
            className="block w-full border-none bg-transparent px-3 py-2 text-left hover:bg-off-white"
          >
            <span className="block truncate font-mono text-[11px] text-neutral-900">
              {option.label}
            </span>
            {option.description && (
              <span className="block text-[10px] leading-[1.4] text-neutral-500">
                {option.description}
              </span>
            )}
          </button>
        ))
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
export function PromptEditor({
  value,
  onChange,
  syncRequest,
  disabled,
  minHeightClass,
  fill,
  autoFocus,
  authoringMode = "v1",
  availableValues = [],
  slots = [],
  compact = false,
  singleLine = false,
}: PromptEditorProps) {
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

  const surfaceMinH = fill
    ? "min-h-full"
    : (minHeightClass ?? (compact ? "min-h-[42px]" : "min-h-[220px]"));
  const canonical = authoringMode === "v2";
  const canonicalInsertLabel =
    slots.length > 0 ? "workflow value or prompt slot" : "workflow value";
  const insertOptions = useMemo<PromptInsertOption[]>(
    () =>
      canonical
        ? [
            ...availableValues.map((available) => ({
              token: `{{data:${available.reference}}}`,
              label: available.label,
              description: available.description,
            })),
            ...slots.map((slot) => ({
              token: `{{slot:${slot.name}}}`,
              label: `Slot · ${slot.name}`,
              description: slot.description ?? null,
            })),
          ]
        : AVAILABLE_VARIABLES.map((variable) => ({
            token: `{{${variable.name}}}`,
            label: variable.name,
            description: variable.description,
          })),
    [availableValues, canonical, slots],
  );
  const extensions = useMemo(
    () => [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Markdown,
      ...(canonical ? [PromptTokenNode] : [VariableHighlight]),
    ],
    [canonical],
  );

  const editor = useEditor({
    editable: !disabled,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions,
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: { class: `ck-prose ${surfaceMinH} focus:outline-none` },
      handleKeyDown: (_view, event) =>
        singleLine && event.key === "Enter",
    },
    onUpdate: ({ editor }) => {
      if (settingRef.current) return;
      const markdown = editor.getMarkdown();
      onChange(
        singleLine ? markdown.replace(/\s*\n+\s*/g, " ") : markdown,
      );
    },
  }, [canonical, singleLine]);

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
  const insertVariable = (token: string) => {
    if (!editor) return;
    if (canonical) {
      const attributes = promptTokenNodeAttributes(token);
      if (attributes) {
        editor
          .chain()
          .focus()
          .insertContent({ type: PromptTokenNode.name, attrs: attributes })
          .run();
        return;
      }
    }
    editor.chain().focus().insertContent(token).run();
  };

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
          !compact &&
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
            title={
              canonical ? `Insert ${canonicalInsertLabel}` : "Insert variable"
            }
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setVarOpen((o) => !o)}
            className={`${toolBtn} ml-0.5 gap-1 px-2 text-mariner`}
          >
            <span className="text-[13px] leading-none">+</span>{" "}
            {canonical ? "Value" : "Variable"}
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
          rows={singleLine ? 1 : undefined}
          onChange={(e) =>
            onChange(
              singleLine
                ? e.target.value.replace(/\s*\n+\s*/g, " ")
                : e.target.value,
            )
          }
          className={`w-full min-w-0 border-none bg-panel px-3 py-2 font-mono text-[12px] leading-[1.6] text-coal outline-none ${
            fill
              ? "min-h-0 flex-1 resize-none"
              : singleLine
                ? "resize-none"
                : `resize-y ${minHeightClass ?? "min-h-[220px]"}`
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
          onDrop={(event) => {
            const payload = readPromptDrag(event);
            if (!payload || disabled || !editor) return;
            event.preventDefault();
            const markdown =
              payload.kind === "library-reference"
                ? formatPromptReferenceToken({
                    slug: payload.slug,
                    version: payload.version ?? "latest",
                  })
                : payload.kind === "library-section"
                  ? payload.markdown
                  : null;
            if (markdown === null) return;
            editor
              .chain()
              .focus()
              .insertContent(markdown, { contentType: "markdown" })
              .run();
          }}
          className={`px-3 py-2.5 ${fill ? "min-h-0 flex-1 overflow-y-auto" : ""}`}
        >
          <EditorContent editor={editor} />
        </div>
      )}

      {canonical ? (
        <CanonicalTokenPicker
          open={varOpen}
          anchorRef={varAnchorRef}
          options={insertOptions}
          ariaLabel={`Insert ${canonicalInsertLabel}`}
          onPick={insertVariable}
          onClose={() => setVarOpen(false)}
        />
      ) : (
        <VariablePickerPopover
          open={varOpen}
          anchorRef={varAnchorRef}
          onPick={(token) => {
            insertVariable(token);
            setVarOpen(false);
          }}
          onClose={() => setVarOpen(false)}
        />
      )}
      <ContextMenu
        at={menuAt}
        actions={actions}
        insertLabel={canonical ? "Insert value" : "Insert variable"}
        insertOptions={insertOptions}
        onInsert={insertVariable}
        onClose={() => setMenuAt(null)}
      />
    </div>
  );
}
