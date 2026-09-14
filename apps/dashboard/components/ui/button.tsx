"use client";

import type React from "react";

export type ButtonVariant =
  | "primary"
  | "selected"
  | "secondary"
  | "ghost"
  | "danger"
  | "success"
  | "danger-soft";
export type ButtonSize = "sm" | "md";

interface ButtonSharedProps {
  children: React.ReactNode;
  className?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
}

type ButtonAsButtonProps = ButtonSharedProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    href?: undefined;
  };

type ButtonAsLinkProps = ButtonSharedProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href"> & {
    href: string;
    disabled?: boolean;
  };

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

const variantClasses: Record<ButtonVariant, string> = {
  primary: "border-mariner bg-mariner text-white hover:opacity-90",
  selected:
    "border-mariner-200 bg-mariner-100 text-mariner hover:border-mariner-200 hover:bg-mariner-100 hover:text-mariner",
  secondary:
    "border-neutral-300 bg-panel text-coal hover:border-neutral-400 hover:bg-app-bg",
  ghost:
    "border-transparent bg-transparent text-neutral-700 hover:bg-app-bg hover:text-coal",
  danger: "border-fail bg-fail text-white hover:bg-fail-fg",
  success: "border-emerald-600 bg-emerald-600 text-white hover:opacity-90",
  "danger-soft": "rounded-full border-red-400 bg-red-50 text-red-700",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-[26px] px-2 text-[10px]",
  md: "h-[30px] px-3 text-[11px]",
};

const callerPositionUtility = /(?:^|:)(?:absolute|fixed|sticky)$/;

export function getButtonClassName({
  variant,
  size,
  className,
  iconOnly = false,
}: {
  variant: ButtonVariant;
  size: ButtonSize;
  className?: string;
  iconOnly?: boolean;
}) {
  const hasCallerPosition = className
    ?.split(/\s+/)
    .some((token) => callerPositionUtility.test(token));

  return [
    hasCallerPosition ? undefined : "relative",
    "inline-flex shrink-0 appearance-none items-center justify-center gap-1.5 rounded-[3px] border font-mono font-semibold leading-none no-underline",
    "transition-[color,background-color,border-color,opacity,transform] duration-[var(--motion-fast)] ease-standard",
    "active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
    "disabled:cursor-default disabled:opacity-40 disabled:active:scale-100 aria-disabled:pointer-events-none aria-disabled:opacity-40",
    variantClasses[variant],
    iconOnly ? (size === "sm" ? "size-[26px] p-0" : "size-[30px] p-0") : sizeClasses[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function ButtonSpinner() {
  return (
    <span
      aria-hidden="true"
      className="absolute size-3 rounded-full border-2 border-current border-r-transparent animate-ck-spinner"
    />
  );
}

export function Button({
  children,
  className,
  variant = "primary",
  size = "md",
  loading = false,
  leadingIcon,
  ...props
}: ButtonProps) {
  const content = (
    <>
      {loading ? <ButtonSpinner /> : null}
      <span className={loading ? "inline-flex items-center gap-1.5 opacity-0" : "inline-flex items-center gap-1.5"}>
        {leadingIcon ? <span aria-hidden="true" className="inline-flex shrink-0">{leadingIcon}</span> : null}
        {children}
      </span>
    </>
  );
  const classes = getButtonClassName({ variant, size, className });

  if ("href" in props && props.href !== undefined) {
    const { disabled, href, onClick, ...anchorProps } = props as ButtonAsLinkProps;
    const unavailable = Boolean(disabled || loading);
    return (
      <a
        {...anchorProps}
        href={href}
        aria-busy={loading || undefined}
        aria-disabled={unavailable || undefined}
        className={classes}
        onClick={(event) => {
          if (unavailable) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        tabIndex={unavailable ? -1 : anchorProps.tabIndex}
        data-size={size}
        data-variant={variant}
      >
        {content}
      </a>
    );
  }

  const buttonProps = props as ButtonAsButtonProps;
  return (
    <button
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      aria-busy={loading || undefined}
      className={classes}
      disabled={buttonProps.disabled || loading}
      data-size={size}
      data-variant={variant}
    >
      {content}
    </button>
  );
}
