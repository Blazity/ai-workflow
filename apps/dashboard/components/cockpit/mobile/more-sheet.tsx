// apps/dashboard/components/cockpit/mobile/more-sheet.tsx
"use client";

import { MobileSheet } from "./mobile-sheet";
import { cockpitNavItems } from "@/components/cockpit/chrome";

const MORE_IDS = new Set(["prompts", "evals", "cost", "users"]);

export function MoreSheet({
  open,
  onClose,
  active,
  onNav,
  canManageUsers,
}: {
  open: boolean;
  onClose: () => void;
  active: string;
  onNav: (id: string) => void;
  canManageUsers: boolean;
}) {
  const more = cockpitNavItems({ canManageUsers }).filter((item) =>
    MORE_IDS.has(item.id),
  );

  return (
    <MobileSheet open={open} onClose={onClose} title="More" heightClass="max-h-[60vh]">
      <div className="flex flex-col py-1">
        {more.map((m) => {
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
