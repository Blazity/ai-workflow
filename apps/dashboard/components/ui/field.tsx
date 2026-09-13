"use client";

import { cloneElement, useId, type ReactElement, type ReactNode } from "react";

interface FieldControlProps {
  id?: string;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

export interface FieldProps {
  label: ReactNode;
  children: ReactElement<FieldControlProps>;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
}

export function Field({
  label,
  children,
  hint,
  error,
  required = false,
  className,
}: FieldProps) {
  const generatedId = useId();
  const controlId = children.props.id ?? `${generatedId}-control`;
  const hintId = hint ? `${generatedId}-hint` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errorId]
    .filter(Boolean)
    .join(" ") || undefined;

  const control = cloneElement(children, {
    id: controlId,
    required: required || children.props.required || undefined,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : children.props["aria-invalid"],
  });

  return (
    <div className={["flex flex-col gap-1.5", className].filter(Boolean).join(" ")}>
      <label htmlFor={controlId} className="font-body text-xs font-medium text-neutral-800">
        {label}
        {required ? <span aria-hidden="true" className="ml-1 text-fail">*</span> : null}
      </label>
      {control}
      {hint ? <p id={hintId} className="m-0 font-body text-[11px] leading-relaxed text-neutral-500">{hint}</p> : null}
      {error ? <p id={errorId} role="alert" className="m-0 font-body text-[11px] leading-relaxed text-fail-fg">{error}</p> : null}
    </div>
  );
}
