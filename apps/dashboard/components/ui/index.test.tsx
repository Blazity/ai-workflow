import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Button,
  CkChip,
  CkDot,
  Checkbox,
  Field,
  IconButton,
  Input,
  Modal,
  RouteTabs,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "./index";
import type {
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  CheckboxProps,
  ChipTone,
  FieldProps,
  IconButtonProps,
  InputProps,
  InputSize,
  ModalProps,
  RouteTab,
  RouteTabsProps,
  SelectOption,
  SelectProps,
  SkeletonProps,
  SkeletonVariant,
  SwitchProps,
  TextareaProps,
} from "./index";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("primitive index reexports the canonical chip and status dot", () => {
  const html = renderToStaticMarkup(
    <div>
      <CkChip tone="success">Success</CkChip>
      <CkDot color="var(--color-success)" />
    </div>,
  );
  assert.match(html, /Success/);
  assert.match(html, /background:var\(--color-success\)/);
});

test("primitive index exposes every runtime component", () => {
  for (const component of [
    Button,
    Checkbox,
    IconButton,
    Field,
    RouteTabs,
    Select,
    Modal,
    Skeleton,
    Switch,
  ]) {
    assert.equal(typeof component, "function");
  }
  assert.equal(typeof Input, "object");
  assert.equal(typeof Textarea, "object");
});

test("primitive index exposes every public prop type", () => {
  type PublicTypes = [
    ButtonProps,
    ButtonSize,
    ButtonVariant,
    CheckboxProps,
    ChipTone,
    FieldProps,
    IconButtonProps,
    InputProps,
    InputSize,
    ModalProps,
    RouteTab,
    RouteTabsProps,
    SelectOption,
    SelectProps,
    SkeletonProps,
    SkeletonVariant,
    SwitchProps,
    TextareaProps,
  ];
  const compileTimeContract: PublicTypes | null = null;
  assert.equal(compileTimeContract, null);
});
