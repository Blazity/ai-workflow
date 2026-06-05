// apps/dashboard/components/cockpit/mobile/more-sheet.tsx
"use client";

import { MobileSheet } from "./mobile-sheet";

const MORE = [
  { id: "prompts", label: "Prompts",     glyph: "❡" },
  { id: "evals",   label: "Arthur evals", glyph: "✓" },
  { id: "cost",    label: "Cost & usage", glyph: "$" },
] as const;

export function MoreSheet({
  open,
  onClose,
  active,
  onNav,
}: {
  open: boolean;
  onClose: () => void;
  active: string;
  onNav: (id: string) => void;
}) {
  return (
    <MobileSheet open={open} onClose={onClose} title="More" heightClass="max-h-[60vh]">
      <div className="flex flex-col py-1">
        {MORE.map((m) => {
          const on = active === m.id;
          return (
            <button
              key={m.id}
              onClick={() => { onNav(m.id); onClose(); }}
              className={`appearance-none text-left border-none cursor-pointer flex items-center gap-3 px-[18px] py-3.5 font-body text-[15px] ${
                on ? "bg-[#ECECFD] text-mariner font-semibold" : "bg-transparent text-neutral-900"
              }`}
            >
              <span className={`font-mono text-lg leading-none ${on ? "text-mariner" : "text-neutral-700"}`}>{m.glyph}</span>
              {m.label}
            </button>
          );
        })}
      </div>
    </MobileSheet>
  );
}
