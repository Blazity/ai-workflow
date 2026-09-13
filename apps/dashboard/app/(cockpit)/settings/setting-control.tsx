"use client";

import { findSettingDefinition } from "@shared/contracts";
import type { SettingsEntryView } from "@shared/contracts";

import { Input, Select, Textarea } from "@/components/ui";
import { Switch } from "@/components/ui/switch";

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

  if (definition?.type === "boolean") {
    const on = value === true;
    return (
      <Switch
        checked={on}
        aria-label={label}
        disabled={disabled}
        onCheckedChange={onChange}
      >
        {on ? "on" : "off"}
      </Switch>
    );
  }

  if (definition?.type === "integer") {
    return (
      <Input
        type="number"
        step={1}
        min={definition.minimum}
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        placeholder={definition.default === null ? "not set" : "required"}
        onChange={(event) => onChange(event.target.value)}
        monospace
        invalid={invalid}
        className="max-w-[220px]"
      />
    );
  }

  if (definition?.type === "string-list") {
    return (
      <Textarea
        rows={3}
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        placeholder="One name per line"
        onChange={(event) => onChange(event.target.value)}
        monospace
        invalid={invalid}
      />
    );
  }

  if (definition?.enumValues) {
    return (
      <Select
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        invalid={invalid}
        onChange={onChange}
        className="max-w-[220px]"
        options={[
          ...(definition.default === null ? [{ value: "", label: "not set" }] : []),
          ...definition.enumValues.map((allowed) => ({ value: allowed, label: allowed })),
        ]}
      />
    );
  }

  return (
    <Input
      type="text"
      aria-label={label}
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      placeholder={definition?.default === null ? "not set" : "required"}
      onChange={(event) => onChange(event.target.value)}
      monospace
      invalid={invalid}
    />
  );
}
