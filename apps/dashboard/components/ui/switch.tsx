"use client";

import type { KeyboardEvent, ReactNode } from "react";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  children?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  id,
  className,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: SwitchProps) {
  function toggle() {
    if (!disabled) onCheckedChange(!checked);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    toggle();
  }

  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className={[
        // At least 24 px tall however small the track is drawn, so a finger or
        // an unsteady pointer can hit it (WCAG 2.2 target size, minimum).
        "inline-flex min-h-[24px] w-fit self-start appearance-none items-center gap-1.5 border-0 bg-transparent p-0 text-left",
        "font-mono text-[11px] text-neutral-700",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
        "disabled:cursor-default disabled:opacity-40",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5",
          "transition-colors duration-[var(--motion-fast)] ease-standard",
          checked ? "bg-mariner" : "bg-neutral-300",
        ].join(" ")}
      >
        <span
          className={[
            "h-[14px] w-[14px] rounded-full bg-panel",
            "transition-transform duration-[var(--motion-fast)] ease-standard",
            checked ? "translate-x-[14px]" : "translate-x-0",
          ].join(" ")}
        />
      </span>
      {children}
    </button>
  );
}
