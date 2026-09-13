"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type TransitionEvent,
} from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  open?: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "modal" | "drawer";
  dismissible?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const sizeClasses = {
  sm: "max-w-[476px]",
  md: "max-w-[680px]",
  lg: "max-w-[1240px]",
} as const;

function focusableElements(dialog: HTMLElement | null) {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
}

export function Modal({
  open = true,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  variant = "modal",
  dismissible = true,
  initialFocusRef,
  className,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<"open" | "closed">(open ? "open" : "closed");

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setState("open"));
      return () => cancelAnimationFrame(frame);
    }
    setState("closed");
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setMounted(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      (initialFocusRef?.current ?? focusableElements(dialog)[0] ?? dialog)?.focus();
    });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      const previous = previousFocusRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [dismissible, initialFocusRef, open]);

  if (!mounted) return null;

  const frame = (
    <div
      className={[
        "fixed inset-0 z-[100] flex pointer-events-none",
        variant === "drawer" ? "items-stretch justify-end" : "items-center justify-center p-4",
      ].join(" ")}
      data-state={state}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-coal/40 opacity-100 pointer-events-auto transition-[opacity] duration-[var(--motion-base)] ease-emphasized data-[state=closed]:opacity-0 data-[state=closed]:ease-exit"
        data-state={state}
        onClick={dismissible ? onClose : undefined}
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-state={state}
        data-variant={variant}
        onTransitionEnd={(event: TransitionEvent<HTMLElement>) => {
          if (!open && event.target === event.currentTarget) setMounted(false);
        }}
        className={[
          "relative flex max-h-[calc(100dvh-32px)] w-full flex-col overflow-hidden rounded-md border border-neutral-200 bg-panel opacity-100 pointer-events-auto",
          "transition-[opacity,transform] data-[state=open]:duration-[var(--motion-slow)] data-[state=open]:ease-emphasized data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0 data-[state=closed]:duration-[var(--motion-base)] data-[state=closed]:ease-exit",
          variant === "drawer"
            ? "h-full max-h-none max-w-[620px] rounded-none border-y-0 border-r-0 shadow-[-12px_0_32px_rgba(24,27,32,0.08)]"
            : `${sizeClasses[size]} shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)]`,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <header className="shrink-0 border-b border-neutral-200 px-5 py-4">
          <h2 id={titleId} className="m-0 font-display text-base font-semibold text-coal">{title}</h2>
          {description ? <p id={descriptionId} className="mt-1 mb-0 font-body text-xs leading-relaxed text-neutral-700">{description}</p> : null}
        </header>
        <div
          className={
            variant === "drawer"
              ? "flex min-h-0 flex-1 flex-col overflow-hidden px-5"
              : "min-h-0 flex-1 overflow-y-auto px-5 py-4"
          }
        >
          {children}
        </div>
        {footer ? <footer className="shrink-0 border-t border-neutral-200 px-5 py-4">{footer}</footer> : null}
      </section>
    </div>
  );

  return typeof document === "undefined" ? frame : createPortal(frame, document.body);
}
