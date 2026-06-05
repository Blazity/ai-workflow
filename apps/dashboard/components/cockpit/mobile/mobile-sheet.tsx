// apps/dashboard/components/cockpit/mobile/mobile-sheet.tsx
"use client";

import { useEffect } from "react";

export function MobileSheet({
  open,
  onClose,
  title,
  children,
  /** Tailwind max-height class for the sheet body; defaults to ~75vh. */
  heightClass = "max-h-[75vh]",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  heightClass?: string;
}) {
  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-[rgba(24,27,32,0.16)] z-[60]"
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed left-0 right-0 bottom-0 z-[61] bg-panel border-t border-neutral-200 rounded-t-[16px] shadow-[0_-6px_24px_rgba(24,27,32,0.12)] flex flex-col ${heightClass} animate-ck-slide-up`}
      >
        <div className="flex-[0_0_auto] pt-2 pb-1 flex justify-center">
          <span className="w-9 h-1 rounded-full bg-neutral-300" aria-hidden />
        </div>
        {title && (
          <div className="flex-[0_0_auto] px-[18px] pb-2.5 pt-1 flex items-center justify-between border-b border-neutral-200">
            <span className="font-mono text-[10px] text-neutral-700 tracking-[0.08em] uppercase">{title}</span>
            <button
              onClick={onClose}
              aria-label="Close"
              className="appearance-none border border-neutral-200 bg-panel w-7 h-7 rounded-[3px] cursor-pointer font-mono text-sm text-neutral-700"
            >×</button>
          </div>
        )}
        <div className="flex-1 overflow-auto overscroll-contain">{children}</div>
      </div>
    </>
  );
}
