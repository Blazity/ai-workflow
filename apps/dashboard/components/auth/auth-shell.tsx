"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type BannerTone = "error" | "success" | "info";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh bg-panel lg:grid-cols-[minmax(0,44%)_1fr]">
      <BrandPanel />
      <section className="flex min-h-dvh items-center justify-center overflow-auto px-5 py-10 sm:px-8">
        {children}
      </section>
    </main>
  );
}

export function AuthFormShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full max-w-[380px] flex-col gap-4">
      <div className="mb-0.5 flex flex-col gap-1.5">
        <h1 className="font-display text-[28px] font-semibold leading-[1.15] text-neutral-900">
          {title}
        </h1>
        {subtitle ? (
          <p className="m-0 text-[14px] leading-6 text-neutral-700">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function AuthField({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      {label ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
          {label}
        </span>
      ) : null}
      <input
        {...props}
        className={[
          "h-10 rounded-[3px] border border-neutral-200 bg-white px-3 text-[14px] text-neutral-900 outline-none transition",
          "focus:border-mariner focus:shadow-[0_0_0_3px_rgba(60,67,231,0.18)]",
          "read-only:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60",
          props.className ?? "",
        ].join(" ")}
      />
      {hint ? <span className="text-[12px] text-neutral-500">{hint}</span> : null}
    </label>
  );
}

export function AuthButton({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
}) {
  const styles =
    variant === "secondary"
      ? "border-neutral-200 bg-white text-neutral-900 hover:bg-app-bg"
      : "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800";

  return (
    <button
      {...props}
      className={[
        "inline-flex h-[42px] w-full items-center justify-center gap-2 rounded-[3px] border px-3",
        "font-mono text-[12px] font-medium uppercase tracking-[0.04em] transition",
        "disabled:cursor-default disabled:opacity-40",
        styles,
        className ?? "",
      ].join(" ")}
    />
  );
}

export function AuthLinkButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={[
        "border-0 bg-transparent p-0 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
        "text-mariner hover:text-mariner-600 disabled:opacity-40",
        props.className ?? "",
      ].join(" ")}
    />
  );
}

export function AuthBanner({
  tone = "error",
  children,
}: {
  tone?: BannerTone;
  children: ReactNode;
}) {
  const styles = {
    error: {
      wrap: "border-[#f3cfc7] bg-fail-bg text-[#80261c]",
      mark: "bg-[#80261c] text-fail-bg",
      icon: "!",
    },
    success: {
      wrap: "border-sulu-300 bg-success-bg text-success-fg",
      mark: "bg-success-fg text-success-bg",
      icon: "✓",
    },
    info: {
      wrap: "border-mariner-200 bg-mariner-100 text-[#2a2fa8]",
      mark: "bg-[#2a2fa8] text-mariner-100",
      icon: "i",
    },
  }[tone];

  return (
    <div className={`flex items-start gap-2.5 rounded-[3px] border px-3 py-2.5 ${styles.wrap}`}>
      <span
        className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-pill font-mono text-[9px] font-semibold ${styles.mark}`}
      >
        {styles.icon}
      </span>
      <span className="text-[13px] leading-5">{children}</span>
    </div>
  );
}

export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-neutral-200" />
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-500">
        {label}
      </span>
      <span className="h-px flex-1 bg-neutral-200" />
    </div>
  );
}

export function PasswordRule({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${
        ok ? "text-success-fg" : "text-neutral-500"
      }`}
    >
      <span
        className={`inline-flex h-[13px] w-[13px] items-center justify-center rounded-pill border text-[8px] ${
          ok ? "border-success bg-success text-white" : "border-neutral-300"
        }`}
      >
        {ok ? "✓" : ""}
      </span>
      {children}
    </span>
  );
}

export function BlazityLogo({
  size = 28,
  color = "#FD6027",
  wordmarkColor = "#181B20",
  showWord = true,
}: {
  size?: number;
  color?: string;
  wordmarkColor?: string;
  showWord?: boolean;
}) {
  const width = Math.round(size * (1168.768 / 1219.666));
  return (
    <span className="inline-flex items-center gap-2.5 leading-none">
      <svg
        width={width}
        height={size}
        viewBox="0 0 1168.768 1219.666"
        fill={color}
        aria-hidden="true"
      >
        <path d="M 610.721 240.562 C 544.026 203.398 495.29 182.174 495.29 182.174 L 549.74 311.483 L 0 0 L 293.909 593.627 L 158.646 534.855 C 158.646 534.855 178.765 571.588 202.773 626.471 C 245.46 724.04 277.151 811.622 310.042 906.119 C 369.487 1076.721 531.542 1219.666 730.474 1219.666 C 972.525 1219.666 1168.768 1023.807 1168.768 782.188 C 1168.768 598.141 1054.873 440.599 893.586 376.017 C 796.449 337.124 702.096 291.556 610.673 240.61 L 610.721 240.61 Z" />
      </svg>
      {showWord ? (
        <span
          className="font-wordmark font-bold leading-none"
          style={{ color: wordmarkColor, fontSize: Math.round(size * 0.92) }}
        >
          blazity
        </span>
      ) : null}
    </span>
  );
}

function BrandPanel() {
  return (
    <section className="relative hidden min-h-dvh flex-col justify-between overflow-hidden bg-coal p-10 text-white lg:flex">
      <svg
        className="absolute right-[-120px] top-1/2 opacity-[0.07]"
        width="520"
        height="520"
        viewBox="0 0 520 520"
        aria-hidden="true"
      >
        {Array.from({ length: 11 }, (_, index) => (
          <circle
            key={index}
            cx="260"
            cy="260"
            r={24 + index * 22}
            fill="none"
            stroke="#fff"
            strokeWidth="1"
          />
        ))}
      </svg>

      <div className="relative z-10 flex items-center gap-2">
        <BlazityLogo size={24} color="#FD6027" wordmarkColor="#fff" />
        <span className="ml-0.5 mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-white/55">
          / AI Workflow
        </span>
      </div>

      <div className="relative z-10 flex max-w-[380px] flex-col gap-4">
        <div className="font-display text-[34px] font-medium leading-[1.2] text-white">
          Ship faster with <span className="text-sulu">autonomous</span> workflows.
        </div>
        <p className="m-0 text-[14px] leading-6 text-white/65">
          Observe every run, trace every span, and review every PR in one team
          workspace.
        </p>
      </div>

      <div className="relative z-10 font-mono text-[10px] uppercase tracking-[0.06em] text-white/40">
        Blazity · AI Workflow
      </div>
    </section>
  );
}
