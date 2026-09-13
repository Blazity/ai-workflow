"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

export type InputSize = "sm" | "md";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: InputSize;
  monospace?: boolean;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    size = "md",
    monospace = false,
    invalid = false,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  return (
    <input
      {...props}
      ref={ref}
      aria-invalid={isInvalid || undefined}
      data-size={size}
      className={[
        "w-full rounded-[3px] border bg-panel px-2 text-xs text-coal placeholder:text-neutral-400",
        "transition-[color,background-color,border-color,opacity] duration-[var(--motion-fast)] ease-standard",
        "hover:border-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
        "disabled:cursor-default disabled:bg-app-bg disabled:opacity-60",
        size === "sm" ? "h-[26px]" : "h-[30px]",
        monospace ? "font-mono" : "font-body",
        isInvalid ? "border-fail focus-visible:border-fail focus-visible:ring-fail" : "border-neutral-200",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
});
