// apps/dashboard/components/cockpit/mobile/bottom-tab-bar.tsx
"use client";

const TABS = [
  { id: "overview", label: "Overview", glyph: "◇" },
  { id: "runs",     label: "Runs",     glyph: "≡" },
  { id: "editor",   label: "Editor",   glyph: "▷" },
] as const;

export function BottomTabBar({
  active,
  onNav,
  onOpenMore,
  moreActive,
}: {
  active: string;
  onNav: (id: string) => void;
  onOpenMore: () => void;
  moreActive: boolean;
}) {
  const cell = (on: boolean) =>
    `flex-1 flex flex-col items-center justify-center gap-0.5 py-2 appearance-none bg-transparent border-none cursor-pointer ${
      on ? "text-mariner" : "text-neutral-600"
    }`;
  return (
    <nav className="flex-[0_0_auto] bg-panel border-t border-neutral-200 flex items-stretch pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tHere) => {
        const on = active === tHere.id;
        return (
          <button key={tHere.id} onClick={() => onNav(tHere.id)} aria-label={tHere.label} aria-current={on} className={cell(on)}>
            <span className="font-mono text-lg leading-none">{tHere.glyph}</span>
            <span className="font-mono text-[9px] tracking-[0.02em]">{tHere.label}</span>
          </button>
        );
      })}
      <button onClick={onOpenMore} aria-label="More" aria-current={moreActive} className={cell(moreActive)}>
        <span className="font-mono text-lg leading-none">⋯</span>
        <span className="font-mono text-[9px] tracking-[0.02em]">More</span>
      </button>
    </nav>
  );
}
