"use client";

import type { MouseEvent, ReactNode } from "react";

export interface RouteTab<T extends string = string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
  /**
   * Where the tab leads, when it is a URL rather than a section of this screen.
   *
   * With it the tab is a real anchor: the address bar is right, cmd-click opens
   * a tab and the browser's own back button works, which is what people expect
   * of anything that changes the URL. `onChange` still runs for a plain click,
   * so a cockpit navigation stays inside whatever guard the caller has. Without
   * it the tab stays a button, because a button is the honest control for
   * switching part of one screen.
   */
  href?: string;
}

export interface RouteTabsProps<T extends string = string> {
  tabs: readonly RouteTab<T>[];
  active: T;
  onChange: (id: T) => void;
  "aria-label": string;
  className?: string;
}

/** A modified click belongs to the browser: it opens a tab or a window. */
function browserHandlesClick(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
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
        const classes = [
          "inline-flex h-[30px] appearance-none items-center justify-center border-x-0 border-t-0 border-b-2 bg-transparent px-3",
          "font-mono text-[11px] font-semibold leading-none text-neutral-700 no-underline",
          "transition-[color,background-color,border-color,transform] duration-[var(--motion-fast)] ease-standard",
          "hover:bg-app-bg hover:text-neutral-900 active:scale-[0.98]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
          "disabled:cursor-default disabled:opacity-40 disabled:active:scale-100",
          selected ? "border-b-mariner text-mariner" : "border-b-transparent",
        ].join(" ");

        // A disabled tab stays a button: an anchor cannot be disabled, and one
        // that looks disabled and still navigates is worse than a plain button.
        if (tab.href !== undefined && !tab.disabled) {
          return (
            <a
              key={tab.id}
              href={tab.href}
              aria-current={selected ? "page" : undefined}
              onClick={(event) => {
                if (browserHandlesClick(event)) return;
                event.preventDefault();
                onChange(tab.id);
              }}
              className={classes}
            >
              {tab.label}
            </a>
          );
        }

        return (
          <button
            key={tab.id}
            type="button"
            disabled={tab.disabled}
            aria-current={selected ? "page" : undefined}
            onClick={() => onChange(tab.id)}
            className={classes}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
