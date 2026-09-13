"use client";

import { useRef, useState } from "react";
import { usedVariables } from "@shared/prompts";
import { VariablePickerPopover } from "./variable-picker-popover";
import { Button } from "@/components/ui";

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
  const btnRef = useRef<HTMLSpanElement>(null);
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
          <span ref={btnRef} className="self-start">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={open}
            >
              + variable
            </Button>
          </span>
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
