"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";
import type { InputSize } from "./input";

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> {
  size?: InputSize;
  monospace?: boolean;
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    size = "md",
    monospace = false,
    invalid = false,
    rows = 4,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  return (
    <textarea
      {...props}
      ref={ref}
      rows={rows}
      aria-invalid={isInvalid || undefined}
      data-size={size}
      className={[
        "w-full resize-y rounded-[3px] border bg-panel px-2 text-xs leading-relaxed text-coal placeholder:text-neutral-400",
        "transition-[color,background-color,border-color,opacity] duration-[var(--motion-fast)] ease-standard",
        "hover:border-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
        "disabled:cursor-default disabled:bg-app-bg disabled:opacity-60",
        size === "sm" ? "min-h-[72px] py-1" : "min-h-[88px] py-1.5",
        monospace ? "font-mono" : "font-body",
        isInvalid ? "border-fail focus-visible:border-fail focus-visible:ring-fail" : "border-neutral-200",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
});
