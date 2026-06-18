"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CkStatusPill } from "@/components/ui";
import type { RunStatus } from "@shared/contracts";

interface Hit {
  id: string;
  ticket: string;
  ticketTitle: string;
  workflowName: string;
  status: RunStatus;
  startedAtMin: number;
  runCount: number;
}

/** Event a header trigger dispatches to summon the shell-mounted overlay. */
const OPEN_EVENT = "cockpit:spotlight-open";

/** Open the Spotlight overlay from anywhere on the page. */
export function openSpotlight() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const SearchGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-neutral-400 shrink-0" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** Small keycap, matching the cockpit's mono utility voice. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 font-mono text-[10px] leading-none text-neutral-500 bg-panel border border-neutral-200 rounded-[3px]">
      {children}
    </kbd>
  );
}

/**
 * Header affordance that opens Spotlight. It is a button, not an input — the
 * search itself lives in the overlay so it can be summoned from any screen with
 * ⌘K, not just the one showing this button. Reads as a search field at rest.
 */
export function SpotlightTrigger() {
  return (
    <button
      type="button"
      onClick={openSpotlight}
      aria-label="Search tickets (Command-K)"
      aria-keyshortcuts="Meta+K Control+K"
      className="group flex items-center gap-2 h-[38px] w-full max-w-[320px] pl-3 pr-2 bg-panel border border-neutral-200 rounded-sm text-left cursor-pointer transition-colors hover:border-neutral-300 focus:outline-none focus-visible:border-mariner focus-visible:ring-2 focus-visible:ring-mariner/20"
    >
      <SearchGlyph />
      <span className="flex-1 min-w-0 font-body text-[13px] text-neutral-500 group-hover:text-neutral-700 transition-colors">
        Search tickets
      </span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}

/**
 * Spotlight-style ticket search. A centered overlay summoned by ⌘K (⌃K) from
 * anywhere — mount once in the shell. Type a ticket key or title; matches across
 * all history stream in (debounced, via the same-origin /api/runs/search proxy),
 * and ↑/↓ + ↩ opens that run's trace. Esc or a backdrop click dismisses it.
 */
export function SpotlightSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reqId = useRef(0);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const listId = useId();

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setHits([]);
    setActive(0);
    setLoading(false);
  }, []);

  // ⌘K / ⌃K toggles the overlay; a custom event lets a trigger button open it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // While open: lock body scroll, focus the input, restore focus on close, and
  // dismiss on Escape from anywhere — a modal's exit can't depend on which
  // element currently holds focus (the input may not have been focused yet).
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onEsc);
      document.body.style.overflow = prevOverflow;
      restoreFocus.current?.focus?.();
    };
  }, [open, close]);

  useEffect(() => () => clearTimeout(debounce.current), []);

  const search = useCallback((value: string) => {
    const term = value.trim();
    if (term.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    fetch(`/api/runs/search?q=${encodeURIComponent(term)}`)
      .then((r) => r.json())
      .then((data: { rows?: Hit[] }) => {
        if (id !== reqId.current) return; // a newer keystroke won
        setHits(data.rows ?? []);
        setActive(0);
        setLoading(false);
      })
      .catch(() => {
        if (id === reqId.current) {
          setHits([]);
          setLoading(false);
        }
      });
  }, []);

  const onChange = (value: string) => {
    setQ(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => search(value), 200);
  };

  const go = (hit: Hit | undefined) => {
    if (!hit) return;
    close();
    if (hit.ticket) {
      router.push(`/ticket/${encodeURIComponent(hit.ticket)}`);
    } else {
      router.push(`/trace/${encodeURIComponent(hit.id)}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (hits.length ? (i + 1) % hits.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(hits[active]);
    }
  };

  // Keep the active row in view as the selection moves by keyboard.
  useEffect(() => {
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  if (!mounted || !open) return null;

  const term = q.trim();
  const hasQuery = term.length >= 2;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={close}
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[16vh] bg-coal/50 backdrop-blur-[2px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search tickets"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] bg-panel border border-neutral-200 rounded-md shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)] overflow-hidden animate-ck-pop motion-reduce:animate-none"
      >
        {/* Query row — the input is the one large element on the surface. */}
        <div className="flex items-center gap-3 px-4 h-[60px] border-b border-neutral-200">
          {loading ? (
            <span
              className="w-4 h-4 shrink-0 rounded-full border-[1.5px] border-neutral-300 border-t-mariner animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <SearchGlyph />
          )}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={hasQuery}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={hasQuery && hits[active] ? `${listId}-opt-${active}` : undefined}
            value={q}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search by ticket key or title"
            aria-label="Search by ticket key or title"
            className="flex-1 min-w-0 bg-transparent border-none outline-none font-body text-[18px] text-neutral-900 placeholder:text-neutral-400"
          />
          <Kbd>esc</Kbd>
        </div>

        {/* Results / states */}
        <div id={listId} role="listbox" aria-label="Matching runs" className="max-h-[min(56vh,420px)] overflow-y-auto">
          {!hasQuery && (
            <div className="px-4 py-9 flex flex-col items-center text-center gap-1">
              <SearchGlyph />
              <p className="font-body text-[13px] text-neutral-700 m-0 mt-1">Search your run history</p>
              <p className="font-body text-[12px] text-neutral-500 m-0">
                Type a ticket key or title to jump straight to its trace.
              </p>
            </div>
          )}

          {hasQuery && loading && hits.length === 0 && (
            <div className="px-4 py-6 font-mono text-[11px] text-neutral-500">Searching…</div>
          )}

          {hasQuery && !loading && hits.length === 0 && (
            <div className="px-4 py-6 font-body text-[13px] text-neutral-500">
              No runs match “{term}”.
            </div>
          )}

          {hasQuery && hits.length > 0 && (
            <>
              <div className="flex items-center justify-between px-4 pt-3 pb-1.5 font-mono text-[10px] tracking-[0.08em] uppercase text-neutral-500">
                <span>Tickets</span>
                <span>
                  {hits.length} {hits.length === 1 ? "match" : "matches"}
                </span>
              </div>
              {hits.map((h, i) => (
                <button
                  key={h.id}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className={`relative w-full appearance-none border-none cursor-pointer text-left flex items-center gap-3 pl-4 pr-3 py-2.5 ${
                    i === active ? "bg-mariner-100" : "bg-panel"
                  }`}
                >
                  {/* Signature: the mariner rail marks the active row. */}
                  {i === active && (
                    <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-mariner" aria-hidden="true" />
                  )}
                  <CkStatusPill status={h.status} />
                  <span className="flex flex-col min-w-0 flex-1">
                    <span className="truncate font-semibold text-neutral-900 text-[13px] leading-tight">
                      {h.ticketTitle || h.ticket || h.id}
                    </span>
                    <span className="truncate font-mono text-[10px] text-neutral-500 mt-0.5">
                      {[
                        h.ticket,
                        h.workflowName,
                        h.runCount > 1 ? `${h.runCount} runs` : `${h.startedAtMin}m ago`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span
                    className={`font-mono text-[11px] shrink-0 ${i === active ? "text-mariner" : "text-transparent"}`}
                    aria-hidden="true"
                  >
                    ↩
                  </span>
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer legend — the cockpit's mono console voice. */}
        <div className="flex items-center gap-4 px-4 h-9 border-t border-neutral-200 bg-off-white font-mono text-[10px] text-neutral-500">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> navigate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↩</Kbd> open ticket
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>esc</Kbd> close
          </span>
          <span className="ml-auto">{hasQuery && hits.length ? `${hits.length} shown` : "Up to 8 results"}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
