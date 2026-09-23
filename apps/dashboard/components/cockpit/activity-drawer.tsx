"use client";

import { useEffect } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { Modal } from "@/components/ui/modal";

/**
 * No provider or block writes into an activity feed yet, so there is nothing
 * real to show here. Showing sample events in their place, as an earlier
 * version of this drawer did, is data a person could mistake for their own
 * account's activity. Until a real source exists, this stays an honest empty
 * state instead.
 */
export function CkActivityDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "." && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Activity"
      chrome="none"
      variant="drawer"
      frameClassName="hidden lg:flex"
      className="w-[420px] bg-panel border-l border-neutral-200 flex flex-col animate-ck-slide shadow-[-12px_0_32px_rgba(24,27,32,0.08)]"
    >
        <header className="flex-[0_0_auto] px-[18px] py-4 border-b border-neutral-200 flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] text-neutral-700 tracking-[0.08em] uppercase">Activity</span>
            <span className="font-display font-medium text-base leading-[1.2] text-neutral-900">Activity</span>
          </div>
          <IconButton aria-label="Close activity" variant="text" onClick={onClose} className="border border-neutral-200 bg-panel w-7 h-7 rounded-[3px] cursor-pointer font-mono text-sm text-neutral-700">×</IconButton>
        </header>

        <div className="flex-1 overflow-auto flex items-center justify-center px-[18px] py-10">
          <p className="font-body text-[13px] text-neutral-600 text-center m-0">Nothing here yet.</p>
        </div>

        <footer className="flex-[0_0_auto] px-[18px] py-3 border-t border-neutral-200 flex items-center justify-end font-mono text-[10px] text-neutral-500">
          <span>⌘. to close</span>
        </footer>
    </Modal>
  );
}
