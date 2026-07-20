"use client";

import { useRef, useState } from "react";
import { usedVariables } from "@/lib/prompt-library/variables";
import { VariablePickerPopover } from "./variable-picker-popover";

/** Compact variable summary for a prompt body: a row of chips for the
 *  variables actually used, plus an optional inline trigger that opens the
 *  floating variable picker (a portal popover, so it never pushes layout). */
export function VariableChips({
  body,
  onInsertToken,
  disabled,
}: {
  body: string;
  onInsertToken?: (token: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const used = usedVariables(body);
  const canInsert = onInsertToken != null && !disabled;

  return (
    <div className="flex flex-col gap-1.5">
      {used.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500">
            Variables
          </span>
          {used.map((v) => (
            <span
              key={v.name}
              className={`rounded-pill border px-1.5 font-mono text-[10px] ${
                v.known
                  ? "border-mariner-200 bg-mariner-100 text-mariner"
                  : "border-yellow-300 bg-[#FFF4CC] text-[#7A5A00]"
              }`}
            >
              {v.name}
            </span>
          ))}
        </div>
      )}

      {canInsert && (
        <>
          <button
            ref={btnRef}
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={open}
            className="self-start appearance-none cursor-pointer rounded-xs px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-mariner transition-[background-color,transform] duration-150 ease-standard hover:bg-mariner-100 active:scale-[0.96]"
          >
            + variable
          </button>
          <VariablePickerPopover
            open={open}
            anchorRef={btnRef}
            onPick={(token) => {
              onInsertToken?.(token);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </div>
  );
}
