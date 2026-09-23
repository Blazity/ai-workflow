"use client";

import type React from "react";

interface NavItemSharedProps {
  label: string;
  /** A word after the label for an entry that is not simply there to open (Off). */
  badge?: string;
  icon?: React.ReactNode;
  active?: boolean;
  collapsed?: boolean;
  stacked?: boolean;
  className?: string;
}

type NavItemButtonProps = NavItemSharedProps &
  Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-current" | "children" | "className"
  > & {
    href?: undefined;
  };

type NavItemLinkProps = NavItemSharedProps &
  Omit<
    React.AnchorHTMLAttributes<HTMLAnchorElement>,
    "aria-current" | "children" | "className" | "href"
  > & {
    href: string;
  };

export type NavItemProps = NavItemButtonProps | NavItemLinkProps;

export function NavItem({
  label,
  badge,
  icon,
  active = false,
  collapsed = false,
  stacked = false,
  className,
  "aria-label": ariaLabel,
  ...props
}: NavItemProps) {
  const classes = [
    "relative flex min-w-0 appearance-none items-center gap-[10px] rounded-[3px] border-0 px-3 py-[9px] text-left",
    "font-body text-[13px] leading-[1.25] no-underline",
    "transition-[color,background-color,transform] duration-[var(--motion-fast)] ease-standard",
    "active:scale-[0.98]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1",
    active
      ? "bg-mariner-100 text-mariner font-semibold"
      : "bg-transparent text-neutral-800 font-medium hover:bg-app-bg",
    collapsed ? "justify-center px-0" : null,
    stacked ? "flex-col gap-0.5 text-center" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const spokenLabel = badge ? `${label}, ${badge}` : label;
  const content = (
    <>
      {icon ? (
        <span
          aria-hidden="true"
          className={`inline-flex shrink-0 ${active ? "text-mariner" : "text-neutral-700"}`}
        >
          {icon}
        </span>
      ) : null}
      {collapsed ? null : <span className="min-w-0">{label}</span>}
      {badge && !collapsed ? (
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-500">
          {badge}
        </span>
      ) : null}
      {active && !collapsed ? (
        <span
          aria-hidden="true"
          data-nav-indicator=""
          className={
            stacked
              ? "absolute bottom-0 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-mariner"
              : "ml-auto h-4 w-1 rounded-full bg-mariner"
          }
        />
      ) : null}
    </>
  );

  if ("href" in props && props.href !== undefined) {
    const { href, ...anchorProps } = props as NavItemLinkProps;
    return (
      <a
        {...anchorProps}
        href={href}
        aria-label={ariaLabel ?? spokenLabel}
        aria-current={active ? "page" : undefined}
        className={classes}
      >
        {content}
      </a>
    );
  }

  const buttonProps = props as NavItemButtonProps;
  return (
    <button
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      aria-label={ariaLabel ?? spokenLabel}
      aria-current={active ? "page" : undefined}
      className={classes}
    >
      {content}
    </button>
  );
}
