"use client";

import type { ReactNode } from "react";

export interface RouteTab<T extends string = string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface RouteTabsProps<T extends string = string> {
  tabs: readonly RouteTab<T>[];
  active: T;
  onChange: (id: T) => void;
  "aria-label": string;
  className?: string;
}

export function RouteTabs<T extends string>({
  tabs,
  active,
  onChange,
  "aria-label": ariaLabel,
  className,
}: RouteTabsProps<T>) {
  return (
    <nav
      aria-label={ariaLabel}
      className={[
        "flex flex-wrap gap-1 border-b border-neutral-200",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            disabled={tab.disabled}
            aria-current={selected ? "page" : undefined}
            onClick={() => onChange(tab.id)}
            className={[
              "inline-flex h-[30px] appearance-none items-center justify-center border-x-0 border-t-0 border-b-2 bg-transparent px-3",
              "font-mono text-[11px] font-semibold leading-none text-neutral-700",
              "transition-[color,background-color,border-color,transform] duration-[var(--motion-fast)] ease-standard",
              "hover:bg-app-bg hover:text-neutral-900 active:scale-[0.98]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
              "disabled:cursor-default disabled:opacity-40 disabled:active:scale-100",
              selected ? "border-b-mariner text-coal" : "border-b-transparent",
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
