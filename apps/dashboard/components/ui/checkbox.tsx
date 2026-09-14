"use client";

import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from "react";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "children" | "type"> {
  indeterminate?: boolean;
  label?: ReactNode;
  labelTitle?: string;
}

export function Checkbox({
  indeterminate = false,
  label,
  labelTitle,
  className,
  ...props
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      title={labelTitle}
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
        ref={inputRef}
        type="checkbox"
        aria-checked={indeterminate ? "mixed" : props.checked}
        className={[
          "h-3 w-3 shrink-0 rounded-[2px] accent-mariner",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
          "disabled:cursor-default",
        ].join(" ")}
      />
      {label}
    </label>
  );
}
