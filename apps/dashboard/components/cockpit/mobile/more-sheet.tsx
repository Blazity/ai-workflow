// apps/dashboard/components/cockpit/mobile/more-sheet.tsx
"use client";

import { MobileSheet } from "./mobile-sheet";
import { cockpitNavItems, isMobileMoreNavItem } from "@/components/cockpit/chrome";
import { NavItem } from "@/components/ui/nav-item";

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
            <NavItem
              key={m.id}
              onClick={() => { onNav(m.id); onClose(); }}
              label={m.label}
              icon={<NavIcon size={16} />}
              active={on}
              className="w-full rounded-none px-[18px] py-3.5"
            />
          );
        })}
      </div>
    </MobileSheet>
  );
}
