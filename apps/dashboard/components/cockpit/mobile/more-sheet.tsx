// apps/dashboard/components/cockpit/mobile/more-sheet.tsx
"use client";

import { MobileSheet } from "./mobile-sheet";
import { cockpitNavItems, isMobileMoreNavItem } from "@/components/cockpit/chrome";
import { Button } from "@/components/ui/button";

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
    isMobileMoreNavItem(item.id),
  );

  return (
    <MobileSheet open={open} onClose={onClose} title="More" heightClass="max-h-[60vh]">
      <div className="flex flex-col py-1">
        {more.map((m) => {
          const on = active === m.id;
          const NavIcon = m.icon;
          return (
            <Button
              key={m.id}
              onClick={() => { onNav(m.id); onClose(); }}
              aria-current={on ? "page" : undefined}
              variant="ghost"
              className={`h-auto w-full justify-start rounded-none px-[18px] py-3.5 font-body text-[15px] normal-case tracking-normal ${
                on ? "bg-mariner-100 text-mariner font-semibold" : "text-neutral-900"
              }`}
            >
              <NavIcon size={16} aria-hidden="true" className={on ? "text-mariner" : "text-neutral-700"} />
              {m.label}
            </Button>
          );
        })}
      </div>
    </MobileSheet>
  );
}
