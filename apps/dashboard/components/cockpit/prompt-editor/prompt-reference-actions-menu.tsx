"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useEnterExit } from "@/lib/use-enter-exit";

export function PromptReferenceActionsMenu({
  open,
  position,
  trigger,
  primaryLabel,
  onPrimary,
  onClose,
}: {
  open: boolean;
  position: { left: number; top: number } | null;
  trigger: HTMLButtonElement | null;
  primaryLabel: string;
  onPrimary: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const { mounted, state } = useEnterExit(open, 140);
  const menuRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef(position);
  if (position) positionRef.current = position;

  useEffect(() => {
    if (!open) return;
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || trigger?.contains(target)) return;
      onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose(true);
    };
    const closeForLayoutChange = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", closeForLayoutChange);
    document.addEventListener("scroll", closeForLayoutChange, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", closeForLayoutChange);
      document.removeEventListener("scroll", closeForLayoutChange, true);
    };
  }, [onClose, open, trigger]);

  if (!mounted || !positionRef.current) return null;
  const itemClass =
    "flex min-h-10 w-full cursor-pointer items-center rounded-[3px] px-3 text-left font-mono text-[10px] text-neutral-700 transition-colors duration-150 hover:bg-off-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner-200 disabled:cursor-default disabled:opacity-50";

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-state={state}
      style={positionRef.current}
      className={`fixed z-[140] w-[184px] origin-top-right rounded-md border border-neutral-200 bg-panel p-1.5 shadow-[0_16px_40px_-12px_rgba(24,27,32,0.35)] transition-[opacity,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:transform-none ${
        state === "open" ? "scale-100 opacity-100" : "scale-[0.97] opacity-0"
      }`}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={onPrimary}>
        {primaryLabel}
      </button>
    </div>,
    document.body,
  );
}
