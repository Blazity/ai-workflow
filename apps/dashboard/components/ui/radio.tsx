"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

export interface RadioProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "children" | "type"> {
  label?: ReactNode;
}

export function Radio({ label, className, ...props }: RadioProps) {
  return (
    <label
      className={[
        "flex items-center gap-2 font-body text-[12px] text-neutral-800",
        props.disabled ? "opacity-60" : "cursor-pointer",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        {...props}
        type="radio"
        className={[
          "h-3 w-3 shrink-0 accent-mariner",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
          "disabled:cursor-default",
        ].join(" ")}
      />
      {label}
    </label>
  );
}
