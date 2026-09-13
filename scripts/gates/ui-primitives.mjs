#!/usr/bin/env node
/**
 * Keep dashboard screens on the shared UI primitives and motion tokens.
 * Violations are reported as file:line entries. Native controls that have a
 * documented platform constraint may be listed in ui-primitives.allowlist.json.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseOptions, readJson } from "./shared.mjs";

const sourceRoots = ["apps/dashboard/components", "apps/dashboard/app"];
const sourceExtension = /\.tsx?$/u;
const testFile = /\.test\.tsx$/u;
const primitiveRoot = "apps/dashboard/components/ui/";
// motion.ts owns the JavaScript mirrors of the CSS duration tokens, and its
// test pins those values. These are the only paths allowed to hold the numbers.
const motionTokenOwnerPaths = new Set([
  `${primitiveRoot}motion.ts`,
  `${primitiveRoot}motion.test.ts`,
]);
const nativeControl = /<(input|select|textarea)\b[\s\S]*?>/gu;
const literalDuration = /\bduration-(?:\[\d+ms\]|\d+)(?=[^\w-]|$)/gu;
const transitionAll = /\btransition-all\b/gu;
const animatedTimeout = /(?:window\.)?setTimeout\s*\(([\s\S]{0,600}),\s*\d+\s*\)/gu;
const animationSignal = /animat|classList|opacity|transform|transition|translate|scale/iu;
const durationValue = /\b\d+(?:\.\d+)?(?:ms|s)\b/u;
const inlineMotionProperties = new Set([
  "animationDuration",
  "transition",
  "transitionDuration",
]);
const selfTestFixtures = [
  {
    file: "reversed-ternary.txt",
    path: "apps/dashboard/components/cockpit/reversed-ternary.tsx",
    rule: "selected-primary",
  },
  {
    file: "inline-transition-duration.txt",
    path: "apps/dashboard/components/cockpit/inline-transition-duration.tsx",
    rule: "literal-motion",
  },
  {
    file: "inline-animation-duration.txt",
    path: "apps/dashboard/components/cockpit/inline-animation-duration.tsx",
    rule: "literal-motion",
  },
  {
    file: "multiline-transition.txt",
    path: "apps/dashboard/components/cockpit/multiline-transition.tsx",
    rule: "literal-motion",
  },
  {
    absentRule: "native-control",
    file: "primitive-literal-duration.txt",
    path: `${primitiveRoot}primitive-literal-duration.tsx`,
    rule: "literal-motion",
  },
];

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && sourceExtension.test(entry.name) ? [path] : [];
  });
}

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function finding(path, source, index, rule, message) {
  return { line: lineAt(source, index), message, path, rule };
}

function regexFindings(path, source, expression, rule, message) {
  return [...source.matchAll(expression)].map((match) =>
    finding(path, source, match.index, rule, message),
  );
}

function nativeFindings(path, source) {
  return [...source.matchAll(nativeControl)].flatMap((match) => {
    const [, tag] = match;
    if (
      tag === "input" &&
      /\btype\s*=\s*["'](?:hidden|file)["']/u.test(match[0])
    ) {
      return [];
    }
    return [
      finding(
        path,
        source,
        match.index,
        "native-control",
        `native <${tag}> must use a shared UI primitive`,
      ),
    ];
  });
}

function timeoutFindings(path, source) {
  return [...source.matchAll(animatedTimeout)].flatMap((match) => {
    if (!animationSignal.test(match[1])) return [];
    return [
      finding(
        path,
        source,
        match.index,
        "literal-motion",
        "animation setTimeout must use a MOTION_*_MS token",
      ),
    ];
  });
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringValue(expression) {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  return undefined;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function literalMotionStyleFindings(path, source, sourceFile) {
  const findings = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && inlineMotionProperties.has(name)) {
        const initializer = unwrapExpression(node.initializer);
        const isStringExpression =
          ts.isStringLiteral(initializer) ||
          ts.isNoSubstitutionTemplateLiteral(initializer) ||
          ts.isTemplateExpression(initializer);
        if (isStringExpression && durationValue.test(initializer.getText(sourceFile))) {
          findings.push(
            finding(
              path,
              source,
              node.getStart(sourceFile),
              "literal-motion",
              `inline ${name} duration must use a --motion-* token`,
            ),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function selectedPrimaryFindings(path, source, sourceFile) {
  const findings = [];
  const inspectConditional = (node) => {
    if (ts.isConditionalExpression(node)) {
      const whenTrue = staticStringValue(node.whenTrue);
      const whenFalse = staticStringValue(node.whenFalse);
      if (whenTrue === "primary" || whenFalse === "primary") {
        findings.push(
          finding(
            path,
            source,
            node.getStart(sourceFile),
            "selected-primary",
            'boolean selection must use variant="selected" instead of "primary"',
          ),
        );
      }
    }
    ts.forEachChild(node, inspectConditional);
  };
  const visit = (node) => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "variant" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      inspectConditional(node.initializer.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function findingsForSource(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(path),
  );
  return [
    ...(path.startsWith(primitiveRoot) ? [] : nativeFindings(path, source)),
    ...regexFindings(
      path,
      source,
      literalDuration,
      "literal-motion",
      "literal duration must use a --motion-* token",
    ),
    ...regexFindings(
      path,
      source,
      transitionAll,
      "literal-motion",
      "transition-all is forbidden; name the transitioned properties",
    ),
    ...literalMotionStyleFindings(path, source, sourceFile),
    ...timeoutFindings(path, source),
    ...selectedPrimaryFindings(path, source, sourceFile),
  ];
}

function findingsForFile(file, root) {
  const path = relative(root, file).replaceAll("\\", "/");
  return findingsForSource(path, readFileSync(file, "utf8"));
}

function validateAllowlist(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("The UI primitives allowlist must be an array.");
  }
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      !entry.path ||
      !Number.isInteger(entry.line) ||
      entry.line < 1 ||
      typeof entry.rule !== "string" ||
      entry.rule !== "native-control" ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      entry.reason.includes("\n")
    ) {
      throw new TypeError(
        'Each UI primitives allowlist entry needs path, line, rule "native-control", and a one-line reason.',
      );
    }
  }
}

function findingKey({ line, path, rule }) {
  return `${rule}:${path}:${line}`;
}

function collectFindings(options, allowed) {
  const files = sourceRoots
    .flatMap((path) => sourceFiles(join(options.root, path)))
    .map((file) => [file, relative(options.root, file).replaceAll("\\", "/")])
    .filter(([, path]) => !motionTokenOwnerPaths.has(path))
    .filter(([, path]) => !testFile.test(path));
  return files
    .flatMap(([file]) => findingsForFile(file, options.root))
    .filter((entry) => !allowed.has(findingKey(entry)))
    .toSorted((left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule),
    );
}

function reportFindings(findings) {
  for (const entry of findings) {
    console.log(`${entry.path}:${entry.line} ${entry.message}`);
  }
}

function runSelfTest(options, allowed) {
  const fixtureRoot = fileURLToPath(
    new URL("./fixtures/ui-primitives/", import.meta.url),
  );
  for (const fixture of selfTestFixtures) {
    const source = readFileSync(join(fixtureRoot, fixture.file), "utf8");
    const findings = findingsForSource(fixture.path, source);
    assert.ok(
      findings.some((entry) => entry.rule === fixture.rule),
      `${fixture.file} did not trigger ${fixture.rule}`,
    );
    if (fixture.absentRule) {
      assert.ok(
        findings.every((entry) => entry.rule !== fixture.absentRule),
        `${fixture.file} unexpectedly triggered ${fixture.absentRule}`,
      );
    }
    console.log(`ui-primitives self-test: ${fixture.file} caught ${fixture.rule}`);
  }
  const realFindings = collectFindings(options, allowed);
  reportFindings(realFindings);
  assert.equal(realFindings.length, 0, "the real dashboard tree must pass");
  console.log(
    `ui-primitives self-test PASS: ${selfTestFixtures.length} fixture(s) caught; real tree has 0 violations`,
  );
}

function main() {
  const argv = process.argv.slice(2);
  const selfTest = argv.includes("--self-test");
  const options = parseOptions(argv.filter((argument) => argument !== "--self-test"), {
    "--root": "root",
    "--allowlist": "allowlist",
  });
  const allowlistPath = options.allowlist ?? fileURLToPath(
    new URL("./ui-primitives.allowlist.json", import.meta.url),
  );
  const allowlist = readJson(allowlistPath);
  validateAllowlist(allowlist);
  const allowed = new Set(allowlist.map(findingKey));
  if (selfTest) {
    runSelfTest(options, allowed);
    return;
  }
  const findings = collectFindings(options, allowed);
  reportFindings(findings);
  if (findings.length > 0) {
    console.log(`ui-primitives FAIL: ${findings.length} violation(s)`);
    process.exitCode = 1;
  } else {
    console.log("ui-primitives PASS: 0 violations");
  }
}

try {
  main();
} catch (error) {
  console.error(`ui-primitives FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
