import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultTransformConfiguration,
  defaultTransformPredicate,
  TransformFields,
  transformPathFromText,
  transformPathToText,
} from "./transform-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Transform paths round-trip through the readable field syntax", () => {
  assert.deepEqual(transformPathFromText(" profile . address.city "), [
    "profile",
    "address",
    "city",
  ]);
  assert.equal(transformPathToText(["profile", "address", "city"]), "profile.address.city");
});

test("new operations have one visible, editable stage", () => {
  assert.deepEqual(defaultTransformConfiguration("map_object", "profile"), {
    operation: "map_object",
    fields: [
      {
        name: "value",
        value: {
          kind: "input",
          source: { input: "profile", path: [] },
        },
      },
    ],
  });
  assert.deepEqual(defaultTransformConfiguration("filter_array", "rows"), {
    operation: "filter_array",
    source: { input: "rows", path: [] },
    predicate: defaultTransformPredicate(),
  });
});

test("Map object renders bound values, literals, and absent-only defaults", () => {
  const html = renderToStaticMarkup(
    <TransformFields
      configuration={{
        operation: "map_object",
        fields: [
          {
            name: "displayName",
            value: {
              kind: "input",
              source: { input: "profile", path: ["name"] },
              defaultValue: "Anonymous",
            },
          },
          { name: "source", value: { kind: "literal", value: "workflow" } },
        ],
      }}
      inputNames={["profile"]}
      canEdit
      onChange={() => undefined}
    />,
  );
  assert.match(html, /Map object/);
  assert.match(html, /Output field/);
  assert.match(html, /Default when absent/);
  assert.match(html, /Literal value/);
  assert.match(html, /profile/);
  assert.match(html, /name/);
});

test("Filter array renders nested all, any, not, comparison, and null controls", () => {
  const html = renderToStaticMarkup(
    <TransformFields
      configuration={{
        operation: "filter_array",
        source: { input: "rows", path: [] },
        predicate: {
          kind: "all",
          predicates: [
            {
              kind: "comparison",
              path: ["score"],
              operator: "greater_than_or_equal",
              value: 5,
            },
            {
              kind: "any",
              predicates: [
                { kind: "is_null", path: ["note"], isNull: false },
                {
                  kind: "not",
                  predicate: {
                    kind: "comparison",
                    path: ["active"],
                    operator: "equals",
                    value: false,
                  },
                },
              ],
            },
          ],
        },
      }}
      inputNames={["rows"]}
      canEdit
      onChange={() => undefined}
    />,
  );
  assert.match(html, /Filter array/);
  assert.match(html, /Keep item when/);
  assert.match(html, /All conditions/);
  assert.match(html, /Any condition/);
  assert.match(html, /Check null/);
  assert.match(html, /Not/);
  assert.match(html, /is at least/);
});
