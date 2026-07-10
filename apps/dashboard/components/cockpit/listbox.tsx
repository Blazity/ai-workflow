"use client";

import { useEffect, useId, useReducer, useRef } from "react";
import { keyToEvent, listboxReducer } from "@/lib/listbox";

export interface ListboxOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ListboxProps {
  options: ListboxOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}

export function Listbox({ options, value, onChange, disabled, ariaLabel, className }: ListboxProps) {
  const [state, dispatch] = useReducer(listboxReducer, { open: false, activeIdx: 0 });
  const { open, activeIdx } = state;
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const selectedIdx = options.findIndex((o) => o.value === value);
  const current = selectedIdx >= 0 ? options[selectedIdx] : undefined;
  const displayLabel = current ? current.label : value !== "" ? value : options[0]?.label ?? "";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) dispatch({ type: "close" });
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  const commit = (idx: number) => {
    const opt = options[idx];
    if (opt) onChange(opt.value);
    dispatch({ type: "close" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ev = keyToEvent(e.key, state, options.length, selectedIdx);
    if (!ev) return;
    if (e.key !== "Tab") e.preventDefault();
    if (ev.type === "commit") {
      const opt = options[activeIdx];
      if (opt) onChange(opt.value);
    }
    dispatch(ev);
  };

  return (
    <div ref={rootRef} className={`relative w-full ${className ?? ""}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        data-open={open}
        onClick={() => dispatch({ type: "toggle", selectedIdx })}
        onKeyDown={onKeyDown}
        className="group/sel appearance-none w-full inline-flex items-center gap-2 h-[26px] px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs text-coal outline-none cursor-pointer transition-[color,background-color,border-color,box-shadow] duration-[120ms] ease-standard hover:border-neutral-300 focus-visible:border-mariner focus-visible:ring-2 focus-visible:ring-mariner-100 data-[open=true]:border-mariner data-[open=true]:ring-2 data-[open=true]:ring-mariner-100 disabled:opacity-60 disabled:cursor-default"
      >
        <span className="flex-1 min-w-0 truncate text-left">{displayLabel}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3 shrink-0 -mr-0.5 text-neutral-400 transition-[transform,color] duration-[160ms] ease-standard group-hover/sel:text-neutral-600 group-data-[open=true]/sel:rotate-180 group-data-[open=true]/sel:text-mariner"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          aria-activedescendant={options[activeIdx] ? `${listId}-opt-${activeIdx}` : undefined}
          className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-full w-max max-w-[min(420px,80vw)] max-h-[min(60vh,360px)] overflow-y-auto py-1 bg-panel border border-neutral-200 rounded-sm shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] origin-top animate-ck-pop motion-reduce:animate-none"
        >
          {options.map((opt, i) => {
            const selected = i === selectedIdx;
            const active = i === activeIdx;
            return (
              <li
                key={opt.value}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={selected}
                data-active={active}
                onMouseEnter={() => dispatch({ type: "activate", idx: i })}
                onClick={() => commit(i)}
                className={`relative mx-1 flex items-center gap-2.5 rounded-[3px] pl-3 pr-2 py-1.5 cursor-pointer transition-colors duration-[90ms] ${
                  active ? "bg-app-bg" : ""
                }`}
              >
                {selected && (
                  <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-mariner" aria-hidden="true" />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className={`font-mono text-xs leading-tight truncate ${
                      selected ? "font-semibold text-mariner" : "text-coal"
                    }`}
                  >
                    {opt.label}
                  </span>
                  {opt.hint && (
                    <span className="font-mono text-[10px] tracking-[0.04em] text-neutral-500 truncate">{opt.hint}</span>
                  )}
                </span>
                {selected && (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="ml-auto size-3.5 flex-none text-mariner"
                  >
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
