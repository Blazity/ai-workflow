#!/usr/bin/env node
/**
 * Keep dashboard screens on the shared UI primitives and motion tokens.
 * Violations are reported as file:line entries. Native controls that have a
 * documented platform constraint may be listed in ui-primitives.allowlist.json.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions, readJson } from "./shared.mjs";

const sourceRoots = ["apps/dashboard/components", "apps/dashboard/app"];
const testFile = /\.test\.tsx$/u;
const nativeControl = /<(input|select|textarea)\b[\s\S]*?>/gu;
const literalDuration = /\bduration-(?:\[\d+ms\]|\d+)(?=[^\w-]|$)/gu;
const transitionAll = /\btransition-all\b/gu;
const inlineTransition = /\btransition\s*:\s*["'`][^"'`\n]*\b\d+(?:ms|s)\b/gu;
const animatedTimeout = /(?:window\.)?setTimeout\s*\(([\s\S]{0,600}),\s*\d+\s*\)/gu;
const selectedPrimary = /\bvariant\s*=\s*\{[\s\S]{0,300}?\?\s*["']primary["']\s*:/gu;
const animationSignal = /animat|classList|opacity|transform|transition|translate|scale/iu;

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
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

function findingsForFile(file, root) {
  const path = relative(root, file).replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");
  return [
    ...nativeFindings(path, source),
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
    ...regexFindings(
      path,
      source,
      inlineTransition,
      "literal-motion",
      "inline transition duration must use a --motion-* token",
    ),
    ...timeoutFindings(path, source),
    ...regexFindings(
      path,
      source,
      selectedPrimary,
      "selected-primary",
      'boolean selection must use variant="selected" instead of "primary"',
    ),
  ];
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

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--allowlist": "allowlist",
  });
  const allowlistPath = options.allowlist ?? fileURLToPath(
    new URL("./ui-primitives.allowlist.json", import.meta.url),
  );
  const allowlist = readJson(allowlistPath);
  validateAllowlist(allowlist);
  const allowed = new Set(allowlist.map(findingKey));
  const files = sourceRoots
    .flatMap((path) => sourceFiles(join(options.root, path)))
    .filter((file) => !testFile.test(file))
    .filter((file) => !file.startsWith(join(options.root, "apps/dashboard/components/ui/")));
  const findings = files
    .flatMap((file) => findingsForFile(file, options.root))
    .filter((entry) => !allowed.has(findingKey(entry)))
    .toSorted((left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule),
    );

  for (const entry of findings) {
    console.log(`${entry.path}:${entry.line} ${entry.message}`);
  }
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
