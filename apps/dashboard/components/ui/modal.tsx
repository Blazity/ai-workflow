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
import { IconButton } from "./icon-button";

type ModalVariant = "center" | "drawer" | "sheet" | "command";

export interface ModalProps {
  open?: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: ModalVariant;
  dismissible?: boolean;
  showCloseButton?: boolean;
  closeLabel?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  frameClassName?: string;
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

interface InertMainState {
  count: number;
  hadAttribute: boolean;
}

const inertMainStates = new WeakMap<HTMLElement, InertMainState>();

function makeCockpitMainInert(): () => void {
  const main = document.querySelector<HTMLElement>("[data-cockpit-main]");
  if (!main) {
    return () => {
      // This modal is outside the cockpit shell, so there is no page region to restore.
    };
  }
  const current = inertMainStates.get(main);
  if (current) {
    current.count += 1;
  } else {
    inertMainStates.set(main, {
      count: 1,
      hadAttribute: main.hasAttribute("inert"),
    });
    main.setAttribute("inert", "");
  }
  return () => {
    const state = inertMainStates.get(main);
    if (!state) return;
    state.count -= 1;
    if (state.count > 0) return;
    inertMainStates.delete(main);
    if (!state.hadAttribute) main.removeAttribute("inert");
  };
}

function focusableElements(dialog: HTMLElement | null) {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
}

function isTopmostDialog(dialog: HTMLElement | null): dialog is HTMLElement {
  if (!dialog) return false;
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'),
  );
  return dialogs.at(-1) === dialog;
}

export function Modal({
  open = true,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  variant = "center",
  dismissible = true,
  showCloseButton = false,
  closeLabel = "Close",
  initialFocusRef,
  className,
  frameClassName,
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
    const restoreCockpitMain = makeCockpitMainInert();
    const focusInside = (preferLast = false) => {
      const dialog = dialogRef.current;
      if (!isTopmostDialog(dialog)) return;
      const marked = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      const focusable = focusableElements(dialog);
      (
        initialFocusRef?.current ??
        marked ??
        (preferLast ? focusable.at(-1) : focusable[0]) ??
        dialog
      )?.focus();
    };
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const active = document.activeElement;
      const focusedInside =
        active instanceof HTMLElement && dialog?.contains(active) ? active : null;
      if (!focusedInside) focusInside();
    });

    function onKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!isTopmostDialog(dialog)) return;
      if (event.key === "Escape" && dismissible && !event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!last) return;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onFocusIn(event: FocusEvent) {
      const dialog = dialogRef.current;
      if (
        !isTopmostDialog(dialog) ||
        !(event.target instanceof Node) ||
        dialog.contains(event.target)
      ) {
        return;
      }
      focusInside();
    }

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn, true);
      document.body.style.overflow = previousOverflow;
      restoreCockpitMain();
      const previous = previousFocusRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [dismissible, initialFocusRef, open]);

  if (!mounted) return null;

  const placementClassName = {
    center: "items-center justify-center p-4",
    drawer: "items-stretch justify-end",
    sheet: "items-end justify-center",
    command: "items-start justify-center px-4 pt-[16vh]",
  }[variant];
  const panelClassName = {
    center: sizeClasses[size],
    drawer:
      "h-dvh max-h-dvh max-w-[420px] rounded-none border-y-0 border-r-0 data-[state=closed]:translate-x-full",
    sheet:
      "max-h-[75vh] max-w-none rounded-b-none rounded-t-[16px] border-x-0 border-b-0 data-[state=closed]:translate-y-full",
    command: "max-w-[560px]",
  }[variant];
  const headerClassName = variant === "command"
    ? "sr-only"
    : variant === "sheet"
      ? "shrink-0 border-b border-neutral-200 px-[18px] pb-2.5 pt-3"
      : "shrink-0 border-b border-neutral-200 px-5 py-4";
  const bodyClassName = variant === "center"
    ? "min-h-0 flex-1 overflow-y-auto px-5 py-4"
    : "min-h-0 flex-1 overflow-y-auto";
  const footerClassName = variant === "drawer"
    ? "shrink-0 border-t border-neutral-200 px-[18px] py-3"
    : "shrink-0 border-t border-neutral-200 px-5 py-4";

  const frame = (
    <div
      className={`fixed inset-0 z-[100] flex pointer-events-none ${placementClassName} ${frameClassName ?? ""}`}
      data-state={state}
    >
      <div
        aria-hidden="true"
        data-modal-overlay=""
        className="absolute inset-0 bg-coal/40 opacity-100 pointer-events-auto transition-[opacity] duration-[var(--motion-base)] ease-emphasized data-[state=closed]:opacity-0 data-[state=closed]:ease-exit"
        data-state={state}
        onMouseDown={(event) => {
          if (dismissible && event.target === event.currentTarget) {
            onCloseRef.current();
          }
        }}
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-state={state}
        onTransitionEnd={(event: TransitionEvent<HTMLElement>) => {
          if (!open && event.target === event.currentTarget) setMounted(false);
        }}
        className={[
          "relative flex max-h-[calc(100dvh-32px)] w-full flex-col overflow-hidden rounded-md border border-neutral-200 bg-panel opacity-100 shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)] pointer-events-auto",
          "transition-[opacity,transform] data-[state=open]:duration-[var(--motion-slow)] data-[state=open]:ease-emphasized data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0 data-[state=closed]:duration-[var(--motion-base)] data-[state=closed]:ease-exit",
          panelClassName,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        data-variant={variant}
      >
        {variant === "sheet" ? (
          <span className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-neutral-300" aria-hidden="true" />
        ) : null}
        <header className={headerClassName}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="m-0 font-display text-base font-semibold text-coal">{title}</h2>
              {description ? <p id={descriptionId} className="mt-1 mb-0 font-body text-xs leading-relaxed text-neutral-700">{description}</p> : null}
            </div>
            {showCloseButton && dismissible ? (
              <IconButton aria-label={closeLabel} onClick={onClose} size="sm">×</IconButton>
            ) : null}
          </div>
        </header>
        <div className={bodyClassName}>{children}</div>
        {footer ? <footer className={footerClassName}>{footer}</footer> : null}
      </section>
    </div>
  );

  return typeof document === "undefined" ? frame : createPortal(frame, document.body);
}
