"use client";

import { useState } from "react";
import { AVAILABLE_VARIABLES, usedVariables } from "@/lib/prompt-library/variables";

/** Compact variable summary for a prompt body: a row of chips for the
 *  variables actually used, plus an optional inline picker to insert one. */
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
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="self-start appearance-none cursor-pointer rounded-xs px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-mariner hover:bg-mariner-100"
          >
            + variable
          </button>
          {open && (
            <div className="flex flex-col border border-neutral-200 rounded-xs overflow-hidden">
              {AVAILABLE_VARIABLES.map((spec) => (
                <button
                  key={spec.name}
                  type="button"
                  onClick={() => {
                    onInsertToken(`{{${spec.name}}}`);
                    setOpen(false);
                  }}
                  className="block w-full appearance-none cursor-pointer text-left px-2 py-1.5 border-b border-neutral-200 last:border-b-0 bg-panel hover:bg-[#FAFBFC]"
                >
                  <div className="font-mono text-[11px] text-neutral-900">{spec.name}</div>
                  <div className="text-[10px] text-neutral-500">{spec.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
