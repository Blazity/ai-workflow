// apps/dashboard/components/cockpit/mobile/mobile-header.tsx
"use client";

import { BlazityLogo } from "@/components/ui";
import { LivePollControl } from "@/components/cockpit/controls";

export function MobileHeader({ title }: { title: string }) {
  return (
    <header className="flex-[0_0_auto] h-12 bg-panel border-b border-neutral-200 flex items-center gap-2 px-4">
      <BlazityLogo size={20} color="#FD6027" wordmarkColor="#181B20" showWord={false} />
      <span className="font-display font-medium text-[15px] text-coal">{title}</span>
      <div className="ml-auto">
        <LivePollControl size="sm" />
      </div>
    </header>
  );
}
