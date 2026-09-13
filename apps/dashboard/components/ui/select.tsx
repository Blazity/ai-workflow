"use client";

import { Listbox } from "@/components/cockpit/listbox";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  size?: "compact" | "default";
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  size = "default",
  invalid = false,
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: SelectProps) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  return (
    <Listbox
      id={id}
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      invalid={isInvalid}
      ariaLabel={ariaLabel}
      ariaDescribedBy={ariaDescribedBy}
      className={className}
      fallbackLabel={placeholder}
      density={size}
      triggerClassName={[
        size === "default" ? "bg-panel" : undefined,
        "active:scale-[0.98] disabled:active:scale-100",
      ].filter(Boolean).join(" ")}
    />
  );
}
