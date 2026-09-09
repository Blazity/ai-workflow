/**
 * This gate stops new imports that violate ADR-001 and new top-level directory
 * cycles. It exits 1 for unknown paths, tool failures, or counts above the
 * recorded tier-pair and cycle-pair baseline. Run with --update-baseline after
 * an approved architecture change and review the complete before and after table.
 */
import { existsSync, globSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countRegression,
  parseOptions,
  printTable,
  readJson,
  repositoryRoot,
  runTool,
  sortedObject,
  writeJson,
} from "./shared.mjs";

const defaultBaseline = new URL("./boundaries.baseline.json", import.meta.url);
const tierMap = readJson(fileURLToPath(new URL("./tiers.json", import.meta.url)));
const sourceExtension = /\.[cm]?[jt]sx?$/;
const testFile = new RegExp(tierMap.testFilePattern);
const tierPatterns = Object.fromEntries(
  Object.entries(tierMap.tiers).map(([tier, definition]) => [
    tier,
    definition.patterns.map((pattern) => new RegExp(pattern)),
  ]),
);

function slash(path) {
  return path.split(sep).join("/");
}

function within(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function workspacePath(modulePath, root) {
  const unresolved = isAbsolute(modulePath) ? modulePath : resolve(root, modulePath);
  const absolute = existsSync(unresolved) ? realpathSync(unresolved) : unresolved;
  return slash(relative(root, absolute));
}

function isTrackedSource(path) {
  return (
    within(path, tierMap.workerSourceRoot) ||
    path === "apps/worker/env.ts" ||
    within(path, `${tierMap.dashboardRoot}/app`) ||
    within(path, `${tierMap.dashboardRoot}/components`) ||
    within(path, `${tierMap.dashboardRoot}/lib`) ||
    new RegExp(`^${tierMap.dashboardRoot}/[^/]+\\.[cm]?[jt]sx?$`).test(path) ||
    tierMap.packageRoots.some((root) => within(path, root))
  );
}

function hasStepDirective(root, path) {
  try {
    const directive = tierMap.stepDirective.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^[ \\t]*(["'])${directive}\\1;?[ \\t]*$`, "m")
      .test(readFileSync(join(root, path), "utf8"));
  } catch {
    return false;
  }
}

export function classify(root, path) {
  if (tierPatterns.testing.some((pattern) => pattern.test(path))) return "testing";
  for (const packageRoot of tierMap.packageRoots) {
    if (!within(path, packageRoot)) continue;
    const packageName = path.slice(packageRoot.length + 1).split("/")[0];
    return packageName ? `packages/${packageName}` : null;
  }
  for (const tier of tierMap.classificationOrder) {
    if (tier === "testing") continue;
    if (
      tier === "services" &&
      path.startsWith(`${tierMap.workerSourceRoot}/`) &&
      tierMap.stepDirective.directories.includes(path.slice(tierMap.workerSourceRoot.length + 1).split("/")[0]) &&
      hasStepDirective(root, path)
    ) {
      return tierMap.stepDirective.tier;
    }
    if (tierPatterns[tier].some((pattern) => pattern.test(path))) return tier;
  }
  return null;
}

function allowed(from, to, toPath) {
  if (from === to) return true;
  if (from === "testing") return true;
  if (to === "testing") return false;
  if (tierMap.edgeExceptions[`${from}->${to}`]?.includes(toPath)) return true;
  if (from.startsWith("packages/")) {
    const fromPackage = from.slice("packages/".length);
    const toPackage = to.startsWith("packages/") ? to.slice("packages/".length) : null;
    return [...tierMap.packageEdges.default, ...(tierMap.packageEdges[fromPackage] ?? [])]
      .includes(toPackage);
  }
  if (to.startsWith("packages/")) {
    return tierMap.packageConsumers.includes(from) ||
      (from === "db" && to === "packages/contracts");
  }
  return (tierMap.allowedEdges[from] ?? []).includes(to);
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function workspacePackageDirectories(root) {
  const workspaceFile = join(root, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) return new Map();
  const workspaceGlobs = [...readFileSync(workspaceFile, "utf8").matchAll(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/gm)]
    .map((match) => match[1]);
  const directories = new Set();
  for (const workspaceGlob of workspaceGlobs) {
    const excluded = workspaceGlob.startsWith("!");
    const pattern = excluded ? workspaceGlob.slice(1) : workspaceGlob;
    for (const directory of globSync(pattern, { cwd: root })) {
      if (excluded) directories.delete(directory);
      else directories.add(directory);
    }
  }
  const packages = new Map();
  for (const directory of directories) {
    const manifestPath = join(root, directory, "package.json");
    if (!existsSync(manifestPath) || !statSync(join(root, directory)).isDirectory()) continue;
    const manifest = readJson(manifestPath);
    if (typeof manifest.name === "string") packages.set(manifest.name, slash(directory));
  }
  return packages;
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function resolveTsconfigPath(root, fromPath, specifier, cache) {
  if (typeof specifier !== "string") return null;
  const owner = fromPath.match(/^(apps\/[^/]+)(?:\/|$)/)?.[1];
  if (!owner) return null;
  const tsconfigPath = join(root, owner, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return null;
  if (!cache.has(tsconfigPath)) {
    cache.set(tsconfigPath, JSON.parse(stripJsonComments(readFileSync(tsconfigPath, "utf8"))));
  }
  const compilerOptions = cache.get(tsconfigPath).compilerOptions ?? {};
  for (const [alias, targets] of Object.entries(compilerOptions.paths ?? {})) {
    const star = alias.indexOf("*");
    const prefix = star === -1 ? alias : alias.slice(0, star);
    const suffix = star === -1 ? "" : alias.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (star === -1 && specifier !== alias) continue;
    const wildcard = star === -1 ? "" : specifier.slice(prefix.length, specifier.length - suffix.length);
    const target = Array.isArray(targets) ? targets[0] : null;
    if (typeof target !== "string") continue;
    const mapped = star === -1 ? target : target.replace("*", wildcard);
    return workspacePath(resolve(root, owner, compilerOptions.baseUrl ?? ".", mapped), root);
  }
  return null;
}

function resolvedDependencyPath(root, source, fromPath, dependency, packageDirectories, tsconfigCache) {
  const resolved = dependency.resolved || dependency.module;
  if (!resolved) return null;
  if (isAbsolute(resolved)) return workspacePath(resolved, root);
  if (resolved.startsWith("apps/") || resolved.startsWith("packages/")) {
    return workspacePath(resolve(root, resolved), root);
  }
  for (const [name, directory] of packageDirectories) {
    if (dependency.module !== name && !dependency.module?.startsWith(`${name}/`)) continue;
    const subpath = dependency.module.slice(name.length + 1);
    return subpath ? `${directory}/${subpath}` : directory;
  }
  const tsconfigPath = resolveTsconfigPath(root, fromPath, dependency.module, tsconfigCache);
  if (tsconfigPath) return tsconfigPath;
  if (resolved.startsWith(".")) {
    if (!dependency.couldNotResolve) {
      return workspacePath(resolve(root, resolved), root);
    }
    const sourceFile = isAbsolute(source) ? source : resolve(root, source);
    return workspacePath(resolve(dirname(sourceFile), dependency.module), root);
  }
  return null;
}

function sourceInputs(root) {
  const candidates = [
    "apps/worker/src",
    "apps/dashboard/app",
    "apps/dashboard/components",
    "apps/dashboard/lib",
  ];
  const dashboard = join(root, "apps/dashboard");
  if (existsSync(dashboard)) {
    for (const entry of readdirSync(dashboard, { withFileTypes: true })) {
      if (entry.isFile() && sourceExtension.test(entry.name) && !testFile.test(entry.name)) {
        candidates.push(`apps/dashboard/${entry.name}`);
      }
    }
  }
  return candidates.filter((path) => existsSync(join(root, path)));
}

function dependencyCounts(root, config) {
  const inputs = sourceInputs(root);
  if (inputs.length === 0) throw new Error("No worker or dashboard source paths exist.");
  const result = runTool("depcruise", [
    "--config",
    config,
    "--output-type",
    "json",
    "--exclude",
    "(^|/)(node_modules|\\.next|dist)/|\\.(test|spec)\\.[cm]?[jt]sx?$",
    ...inputs,
  ], root);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`dependency-cruiser did not return JSON: ${result.stderr.trim()}`);
  }
  if (![0, 1].includes(result.status)) {
    throw new Error(`dependency-cruiser exited ${result.status}: ${result.stderr.trim()}`);
  }
  const counts = new Map();
  const unknown = new Set();
  const packageDirectories = workspacePackageDirectories(root);
  const tsconfigCache = new Map();
  for (const module of report.modules ?? report.output?.modules ?? []) {
    const fromPath = workspacePath(module.source, root);
    if (!isTrackedSource(fromPath)) continue;
    const fromTier = classify(root, fromPath);
    if (!fromTier) unknown.add(fromPath);
    for (const dependency of module.dependencies ?? []) {
      const toPath = resolvedDependencyPath(
        root,
        module.source,
        fromPath,
        dependency,
        packageDirectories,
        tsconfigCache,
      );
      if (!toPath) continue;
      if (!isTrackedSource(toPath)) continue;
      const toTier = classify(root, toPath);
      if (!toTier) unknown.add(toPath);
      if (fromTier && toTier && !allowed(fromTier, toTier, toPath)) {
        increment(counts, `${fromTier}->${toTier}`);
      }
    }
  }
  return { counts: sortedObject(counts), unknown: [...unknown].sort() };
}

function walk(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else if (/\.(ts|tsx)$/.test(entry.name)) output.push(path);
  }
  return output;
}

function cycleCounts(root) {
  const targets = [
    ["worker", join(root, "apps/worker/src")],
    ["dashboard", join(root, "apps/dashboard/src")],
  ];
  const cycles = new Map();
  const importPattern = /(?:import|export)\s+(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]|import\(\s*['\"]([^'\"]+)['\"]\s*\)/g;
  for (const [name, base] of targets) {
    if (!existsSync(base)) continue;
    const edges = new Set();
    for (const file of walk(base)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const local = relative(base, file);
      const from = local.includes(sep) ? local.split(sep)[0] : "(root)";
      const source = readFileSync(file, "utf8");
      importPattern.lastIndex = 0;
      let match;
      while ((match = importPattern.exec(source))) {
        const specifier = match[1] ?? match[2];
        if (!specifier?.startsWith(".")) continue;
        const target = relative(base, resolve(dirname(file), specifier));
        if (target.startsWith("..")) continue;
        const to = target.includes(sep) ? target.split(sep)[0] : "(root)";
        if (from !== to) edges.add(`${from}->${to}`);
      }
    }
    for (const edge of edges) {
      const [from, to] = edge.split("->");
      if (from < to && edges.has(`${to}->${from}`)) cycles.set(`${name}:${from}<->${to}`, 1);
    }
  }
  return sortedObject(cycles);
}

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--baseline": "baseline",
    "--config": "config",
  });
  const root = realpathSync(options.root);
  const baselinePath = options.baseline ?? fileURLToPath(defaultBaseline);
  const config = options.config ?? join(repositoryRoot, ".dependency-cruiser.cjs");
  const { counts: tierPairs, unknown } = dependencyCounts(root, config);
  const cycles = cycleCounts(root);
  const current = { tierPairs, cycles, cycleTotal: Object.values(cycles).reduce((sum, value) => sum + value, 0) };
  if (options.updateBaseline) {
    if (unknown.length) throw new Error(`Cannot baseline unknown paths: ${unknown.join(", ")}`);
    writeJson(baselinePath, current);
  }
  const baseline = options.updateBaseline ? current : readJson(baselinePath);
  const tierKeys = [...new Set([...Object.keys(baseline.tierPairs), ...Object.keys(tierPairs)])].sort();
  console.log("Boundary tier pairs");
  printTable(["pair", "baseline", "now"], tierKeys.map((key) => [key, baseline.tierPairs[key] ?? 0, tierPairs[key] ?? 0]));
  console.log("Cycle pairs");
  const cycleKeys = [...new Set([...Object.keys(baseline.cycles), ...Object.keys(cycles)])].sort();
  printTable(["pair", "baseline", "now"], cycleKeys.map((key) => [key, baseline.cycles[key] ?? 0, cycles[key] ?? 0]));
  console.log(`cycle total  ${baseline.cycleTotal}  ${current.cycleTotal}`);
  if (unknown.length) {
    console.log("Unknown paths");
    for (const path of unknown) console.log(path);
  }
  const failed = unknown.length > 0 || countRegression(tierPairs, baseline.tierPairs) ||
    countRegression(cycles, baseline.cycles) || current.cycleTotal > baseline.cycleTotal;
  console.log(failed ? "boundaries FAIL" : "boundaries PASS");
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`boundaries FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
