"use client";

import type React from "react";
import {
  ButtonSpinner,
  getButtonClassName,
  type ButtonSize,
  type ButtonVariant,
} from "./button";

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  "aria-label": string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  shape?: "square" | "circle";
}

export function IconButton({
  "aria-label": ariaLabel,
  children,
  className,
  variant = "ghost",
  size = "md",
  loading = false,
  shape = "square",
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      className={getButtonClassName({
        variant,
        size,
        className: [shape === "circle" ? "rounded-full" : undefined, className]
          .filter(Boolean)
          .join(" "),
        iconOnly: true,
      })}
      disabled={props.disabled || loading}
      data-size={size}
      data-variant={variant}
      data-shape={shape}
    >
      {loading ? <ButtonSpinner /> : null}
      <span aria-hidden="true" className={loading ? "inline-flex opacity-0" : "inline-flex"}>
        {children}
      </span>
    </button>
  );
}
