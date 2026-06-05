// apps/dashboard/components/cockpit/mobile/mobile-header.tsx
"use client";

import { BlazityLogo } from "@/components/ui";

export function MobileHeader({ title }: { title: string }) {
  return (
    <header className="flex-[0_0_auto] h-12 bg-panel border-b border-neutral-200 flex items-center gap-2 px-4">
      <BlazityLogo size={20} color="#FD6027" wordmarkColor="#181B20" showWord={false} />
      <span className="font-display font-medium text-[15px] text-coal">{title}</span>
      <span className="ml-auto font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">/ AI Workflow</span>
    </header>
  );
}
