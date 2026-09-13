"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useEnterExit } from "@/lib/use-enter-exit";
import { Button } from "@/components/ui";
import { MOTION_BASE_MS } from "@/components/ui/index";

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
  const { mounted, state } = useEnterExit(open, MOTION_BASE_MS);
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
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-state={state}
      style={positionRef.current}
      className={`fixed z-[140] w-[184px] origin-top-right rounded-sm border border-neutral-200 bg-panel p-1.5 shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] transition-[opacity,transform] duration-[var(--motion-base)] ease-standard motion-reduce:transition-none motion-reduce:transform-none ${
        state === "open" ? "scale-100 opacity-100" : "scale-[0.97] opacity-0"
      }`}
    >
      <Button variant="ghost" size="sm" type="button" role="menuitem" className="min-h-10 w-full justify-start" onClick={onPrimary}>
        {primaryLabel}
      </Button>
    </div>,
    document.body,
  );
}
