"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AVAILABLE_VARIABLES } from "@/lib/prompt-library/variables";
import { useEnterExit } from "@/lib/use-enter-exit";

interface Placement {
  left: number;
  width: number;
  maxHeight: number;
  /** Distance from viewport top (drop-down) — set when opening below the anchor. */
  top?: number;
  /** Distance from viewport bottom (drop-up) — set when opening above the anchor. */
  bottom?: number;
  up: boolean;
}

/**
 * Floating variable picker: a portal popover anchored to a trigger element. It
 * overlays content (never pushes layout), scrolls internally, flips above the
 * anchor when there isn't room below, and animates in/out. Picking a variable
 * calls `onPick(token)`; the parent decides whether to close.
 */
export function VariablePickerPopover<T extends HTMLElement>({
  open,
  anchorRef,
  onPick,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<T | null>;
  onPick: (token: string) => void;
  onClose: () => void;
}) {
  const { mounted, state } = useEnterExit(open, 160);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  // Position under (or above) the anchor, clamped to the viewport. Recompute on
  // open and while the page scrolls/resizes so the popover tracks the trigger.
  useLayoutEffect(() => {
    if (!mounted) return;
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.round(Math.max(240, Math.min(r.width, 340)));
      const left = Math.round(Math.min(Math.max(8, r.left), window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - r.bottom - 12;
      const spaceAbove = r.top - 12;
      const up = spaceBelow < 200 && spaceAbove > spaceBelow;
      const maxHeight = Math.round(Math.max(140, Math.min(280, up ? spaceAbove : spaceBelow)));
      setPos(
        up
          ? { left, width, maxHeight, bottom: Math.round(window.innerHeight - r.top + 6), up }
          : { left, width, maxHeight, top: Math.round(r.bottom + 6), up },
      );
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [mounted, anchorRef]);

  // Dismiss on outside pointer-down and on Escape. Escape uses capture +
  // stopImmediatePropagation so it closes this popover first without also
  // dismissing a parent modal it may be nested inside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
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
  }, [open, anchorRef, onClose]);

  if (!mounted || !pos) return null;

  return createPortal(
    <div
      ref={popRef}
      role="listbox"
      aria-label="Insert variable"
      data-state={state}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
      className={`fixed z-[110] flex flex-col overflow-y-auto rounded-md border border-neutral-200 bg-panel shadow-[0_16px_40px_-12px_rgba(24,27,32,0.35)] transition-[opacity,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:transform-none ${
        pos.up ? "origin-bottom" : "origin-top"
      } ${
        state === "open"
          ? "opacity-100 translate-y-0 scale-100"
          : `opacity-0 scale-[0.98] ${pos.up ? "translate-y-1" : "-translate-y-1"}`
      }`}
    >
      {AVAILABLE_VARIABLES.map((spec) => (
        <button
          key={spec.name}
          type="button"
          role="option"
          aria-selected={false}
          // Keep focus in the editor/textarea so inserting doesn't blur the caret.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(`{{${spec.name}}}`)}
          className="block w-full appearance-none cursor-pointer border-b border-neutral-200 bg-panel px-2.5 py-2 text-left transition-colors duration-150 last:border-b-0 hover:bg-off-white"
        >
          <div className="font-mono text-[11px] text-neutral-900">{spec.name}</div>
          <div className="text-[10px] leading-[1.4] text-neutral-500">{spec.description}</div>
        </button>
      ))}
    </div>,
    document.body,
  );
}
