"use client";

import { findSettingDefinition } from "@shared/contracts";
import type { SettingsEntryView } from "@shared/contracts";

const FIELD_CLASS =
  "w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] text-neutral-800 disabled:bg-app-bg disabled:text-neutral-500";

/**
 * One editable field, chosen by the registry type.
 *
 * A field whose registry default is not null says "required" rather than
 * showing that default: a greyed out number in an empty box reads as a value
 * that is already there, and clearing the field would then look harmless. The
 * default is stated in the description line instead.
 *
 * The registry is the only thing that decides which control a key gets, so a
 * key added to the contracts package renders with the right control here
 * without a second list to keep in step.
 */
export function SettingControl({
  entry,
  value,
  disabled,
  invalid,
  onChange,
}: {
  entry: SettingsEntryView;
  value: string | boolean;
  disabled: boolean;
  invalid: boolean;
  onChange: (next: string | boolean) => void;
}) {
  const definition = findSettingDefinition(entry.key);
  const label = `Value of ${entry.key}`;
  const border = invalid ? " border-red-300" : "";

  if (definition?.type === "boolean") {
    const on = value === true;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className="inline-flex items-center gap-2 appearance-none border-none bg-transparent cursor-pointer disabled:cursor-default disabled:opacity-60 p-0"
      >
        <span
          className={`w-8 h-[18px] rounded-full flex items-center px-[2px] transition-colors duration-[120ms] ${
            on ? "bg-mariner justify-end" : "bg-neutral-300 justify-start"
          }`}
        >
          <span className="w-[14px] h-[14px] rounded-full bg-white" />
        </span>
        <span className="font-mono text-[11px] text-neutral-700">
          {on ? "on" : "off"}
        </span>
      </button>
    );
  }

  if (definition?.type === "integer") {
    return (
      <input
        type="number"
        step={1}
        min={definition.minimum}
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        placeholder={definition.default === null ? "not set" : "required"}
        onChange={(event) => onChange(event.target.value)}
        className={`${FIELD_CLASS}${border} max-w-[220px]`}
      />
    );
  }

  if (definition?.type === "string-list") {
    return (
      <textarea
        rows={3}
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        placeholder="One name per line"
        onChange={(event) => onChange(event.target.value)}
        className={`${FIELD_CLASS}${border} resize-y`}
      />
    );
  }

  if (definition?.enumValues) {
    return (
      <select
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`${FIELD_CLASS}${border} max-w-[220px]`}
      >
        {definition.default === null && <option value="">not set</option>}
        {definition.enumValues.map((allowed) => (
          <option key={allowed} value={allowed}>
            {allowed}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type="text"
      aria-label={label}
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      placeholder={definition?.default === null ? "not set" : "required"}
      onChange={(event) => onChange(event.target.value)}
      className={`${FIELD_CLASS}${border}`}
    />
  );
}
