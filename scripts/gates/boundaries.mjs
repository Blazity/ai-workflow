/**
 * This gate stops imports that violate ADR-001 and any distinct file cycles.
 * It also stops a services cluster reaching past another cluster's index.ts
 * without an entry in cluster-deep-imports.json.
 */
import { existsSync, globSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOptions,
  printTable,
  readJson,
  repositoryRoot,
  requireAnchor,
  requireScan,
  runTool,
  sortedObject,
} from "./shared.mjs";

const boundaryInvariant = "the ADR-001 import and cycle boundary";

// Stable report rows make a clean run auditable even when a pair has no edges.
const reportedTierPairs = [
  "adapters->db",
  "adapters->engine",
  "adapters->services",
  "app->adapters",
  "app->db",
  "app->engine",
  "app->infra",
  "db->adapters",
  "db->config",
  "db->engine",
  "db->services",
  "engine->config",
  "engine->services",
  "services->app",
  "services->config",
];
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

const clusterRoot = tierMap.serviceClusterRoot ?? null;
const workspaceRoots = ["apps", ...tierMap.packageRoots];

export function serviceCluster(path) {
  if (!clusterRoot || !path.startsWith(`${clusterRoot}/`)) return null;
  return path.slice(clusterRoot.length + 1).split("/")[0] || null;
}

export function isClusterInterface(path) {
  const cluster = serviceCluster(path);
  return cluster !== null && path === `${clusterRoot}/${cluster}/index.ts`;
}

// One cluster reaching into another cluster's files instead of its index.ts.
export function crossClusterDeepImport(fromPath, toPath) {
  const from = serviceCluster(fromPath);
  const to = serviceCluster(toPath);
  return from !== null && to !== null && from !== to && !isClusterInterface(toPath);
}

function deepImportKey(pair) {
  return pair.join(" -> ");
}

export function deepImportRegression(observed, recorded) {
  const recordedKeys = new Set(recorded.map((pair) => deepImportKey(pair)));
  const observedKeys = new Set(observed.map((pair) => deepImportKey(pair)));
  return {
    added: observed.filter((pair) => !recordedKeys.has(deepImportKey(pair))),
    stale: recorded.filter((pair) => !observedKeys.has(deepImportKey(pair))),
  };
}

function workspacePath(modulePath, root) {
  const unresolved = isAbsolute(modulePath) ? modulePath : resolve(root, modulePath);
  const absolute = existsSync(unresolved) ? realpathSync(unresolved) : unresolved;
  return slash(relative(root, absolute));
}

function isTrackedSource(path) {
  return (
    within(path, tierMap.workerSourceRoot) ||
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
  // A package tier carries the root it came from. Labelling every package
  // `packages/<name>` made the integration SDK read as `packages/sdk`, a name a
  // real package could take one day, and it flattened the fixtures nested a
  // level deeper. packageRoots is ordered longest first so the nested root wins.
  for (const packageRoot of tierMap.packageRoots) {
    if (!within(path, packageRoot)) continue;
    const packageName = path.slice(packageRoot.length + 1).split("/")[0];
    return packageName ? `${packageRoot}/${packageName}` : null;
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

// A tier pattern is either a tier name or `<root>/*`, which reads as "any
// package under that root". A rule keyed by the exact tier wins over one keyed
// by a pattern, so `integrations/registry` can be allowed more than every other
// integration is.
function matchesTier(pattern, tier) {
  return pattern === tier || (pattern.endsWith("/*") && within(tier, pattern.slice(0, -2)));
}

function matchesAny(patterns, tier) {
  return (patterns ?? []).some((pattern) => matchesTier(pattern, tier));
}

function isPackageTier(tier) {
  return tierMap.packageRoots.some((root) => within(tier, root));
}

function packageEdgesFor(tier) {
  if (tierMap.packageEdges[tier]) return tierMap.packageEdges[tier];
  const pattern = Object.keys(tierMap.packageEdges)
    .filter((key) => key.endsWith("/*") && matchesTier(key, tier))
    .toSorted((left, right) => right.length - left.length)[0];
  return pattern ? tierMap.packageEdges[pattern] : [];
}

export function allowed(from, to, toPath) {
  if (from === to) return true;
  if (from === "testing") return true;
  if (to === "testing") return false;
  if (tierMap.edgeExceptions[`${from}->${to}`]?.includes(toPath)) return true;
  if (isPackageTier(from)) return matchesAny(packageEdgesFor(from), to);
  if (isPackageTier(to)) {
    // Core reaches an integration only through the generated registry, and the
    // SDK, which is types. Everything else under integrations/ is a provider.
    if (!matchesAny(tierMap.corePackageTargets, to)) return false;
    return tierMap.packageConsumers.includes(from) ||
      matchesAny((tierMap.restrictedPackageConsumers ?? {})[from], to);
  }
  return (tierMap.allowedEdges[from] ?? []).includes(to);
}

/**
 * Why an edge is refused, in the words the person who hits it needs. Without
 * it the report says `engine->integrations/jira` and leaves them to guess what
 * to import instead.
 */
export function edgeReason(from, to) {
  const rule = (tierMap.edgeReasons ?? []).find(
    (candidate) =>
      (!candidate.from || candidate.from === "*" || matchesTier(candidate.from, from)) &&
      (!candidate.to || candidate.to === "*" || matchesTier(candidate.to, to)),
  );
  return rule?.reason ?? null;
}

const forbiddenImports = (tierMap.forbiddenImports ?? []).map((rule) => ({
  from: new RegExp(rule.from),
  to: new RegExp(rule.to),
  reason: rule.reason,
}));

/**
 * Rules the tier graph cannot express, because they are about which bundle a
 * file ends up in rather than which layer it belongs to. Returns the rule that
 * refuses the edge, or null.
 */
export function forbiddenImport(fromPath, toPath) {
  return forbiddenImports.find((rule) => rule.from.test(fromPath) && rule.to.test(toPath)) ?? null;
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

function withSourceExtension(root, path) {
  if (sourceExtension.test(path)) return path;
  for (const suffix of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", "/index.ts", "/index.tsx"]) {
    if (existsSync(join(root, path + suffix))) return path + suffix;
  }
  return path;
}

function resolvedDependencyPath(root, source, fromPath, dependency, packageDirectories, tsconfigCache) {
  const resolved = dependency.resolved || dependency.module;
  if (!resolved) return null;
  if (isAbsolute(resolved)) return workspacePath(resolved, root);
  // Every root the gate classifies, not a hand-written pair of them: a path
  // under a root this list forgets resolves to nothing, and an edge the gate
  // cannot resolve is an edge it cannot refuse.
  if (workspaceRoots.some((prefix) => resolved.startsWith(`${prefix}/`))) {
    return workspacePath(resolve(root, resolved), root);
  }
  for (const [name, directory] of packageDirectories) {
    if (dependency.module !== name && !dependency.module?.startsWith(`${name}/`)) continue;
    const subpath = dependency.module.slice(name.length + 1);
    // A package subpath carries no extension, and a rule about which file a
    // bundle may reach needs the file, not the specifier.
    return subpath ? withSourceExtension(root, `${directory}/${subpath}`) : directory;
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
  // integrations/ is scanned directly, not only where an app reaches it, so the
  // rule that integrations never import each other holds before core imports
  // the registry at all.
  const candidates = [
    "apps/worker/src",
    "apps/dashboard/app",
    "apps/dashboard/components",
    "apps/dashboard/lib",
    "integrations",
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
  if (inputs.length === 0) {
    throw new Error(
      `none of the source paths this gate scans exist under ${root}, so ${boundaryInvariant} is unproven. Restore them or point the gate at where they moved.`,
    );
  }
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
  const modules = report.modules ?? report.output?.modules ?? [];
  requireScan(modules.length, "modules", `the dependency-cruiser report for ${inputs.join(", ")}`, boundaryInvariant);
  const counts = new Map();
  const forbiddenEdges = [];
  const bundleViolations = [];
  const unknown = new Set();
  const deepImports = new Set();
  const packageDirectories = workspacePackageDirectories(root);
  const tsconfigCache = new Map();
  for (const module of modules) {
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
        const pair = `${fromTier}->${toTier}`;
        increment(counts, pair);
        forbiddenEdges.push({ from: fromPath, to: toPath, pair });
      }
      if (!dependency.dynamic && crossClusterDeepImport(fromPath, toPath)) {
        deepImports.add(JSON.stringify([fromPath, toPath]));
      }
      const bundleRule = forbiddenImport(fromPath, toPath);
      if (bundleRule) bundleViolations.push({ from: fromPath, to: toPath, reason: bundleRule.reason });
    }
  }
  return {
    counts: sortedObject(counts),
    moduleCount: modules.length,
    report,
    unknown: [...unknown].sort(),
    bundleViolations: bundleViolations.toSorted((left, right) =>
      `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`),
    ),
    deepImports: [...deepImports].toSorted().map((entry) => JSON.parse(entry)),
    forbiddenEdges: forbiddenEdges.toSorted((left, right) =>
      `${left.pair}\0${left.from}\0${left.to}`.localeCompare(`${right.pair}\0${right.from}\0${right.to}`),
    ),
  };
}

export function normalizeFileCycles(report) {
  const cycles = new Map();
  for (const module of report.modules ?? report.output?.modules ?? []) {
    for (const dependency of module.dependencies ?? []) {
      if (!dependency.circular || !Array.isArray(dependency.cycle)) continue;
      const files = [...new Set([
        module.source,
        ...dependency.cycle.map((entry) => entry.name),
      ].filter((path) => typeof path === "string"))].toSorted();
      cycles.set(JSON.stringify(files), files);
    }
  }
  return [...cycles.values()].toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

export function hasFileCycles(fileCycles) {
  return fileCycles.length > 0;
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

function directoryCycleCounts(root) {
  const targets = [
    ["worker", join(root, "apps/worker/src")],
    ["dashboard", join(root, "apps/dashboard/src")],
  ];
  const cycles = new Map();
  const importPattern = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
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
  const printEdges = process.argv.includes("--print-edges");
  const options = parseOptions(process.argv.slice(2).filter((argument) => argument !== "--print-edges"), {
    "--root": "root",
    "--config": "config",
    "--cluster-deep-imports": "clusterDeepImports",
  });
  const root = realpathSync(options.root);
  const config = options.config ?? join(repositoryRoot, ".dependency-cruiser.cjs");
  requireAnchor(root, config, "the dependency-cruiser configuration this gate reads", boundaryInvariant);
  const {
    counts: tierPairs,
    moduleCount,
    report,
    unknown,
    bundleViolations,
    deepImports,
    forbiddenEdges,
  } = dependencyCounts(root, config);
  // The default list belongs to this repository, so a fixture root under --root
  // neither reads nor overwrites it; a fixture passes its own with the flag.
  const ownsDefaultList = root === realpathSync(repositoryRoot);
  const deepImportPath = options.clusterDeepImports ?? (tierMap.clusterDeepImports && ownsDefaultList
    ? fileURLToPath(new URL(tierMap.clusterDeepImports, import.meta.url))
    : null);
  const recordedDeepImports = deepImportPath && existsSync(deepImportPath) ? readJson(deepImportPath) : [];
  const deepImportDrift = deepImportRegression(deepImports, recordedDeepImports);
  const directoryCycles = directoryCycleCounts(root);
  const fileCycles = normalizeFileCycles(report);
  const tierKeys = [
    ...new Set([
      ...reportedTierPairs,
      ...Object.keys(tierPairs),
    ]),
  ].sort();
  console.log(`Modules read from the dependency-cruiser report  ${moduleCount}`);
  console.log("Boundary tier pairs");
  printTable(["pair", "now"], tierKeys.map((key) => [key, tierPairs[key] ?? 0]));
  console.log("Directory cycle pairs (informational)");
  printTable(["pair", "now"], Object.entries(directoryCycles).map(([key, count]) => [key, count]));
  console.log(`file cycles  ${fileCycles.length}`);
  console.log("Cross-cluster deep imports");
  printTable(
    ["state", "count"],
    [["recorded", recordedDeepImports.length], ["now", deepImports.length]],
  );
  for (const [from, to] of deepImportDrift.added) console.log(`new deep import  ${from} -> ${to}`);
  for (const [from, to] of deepImportDrift.stale) console.log(`retired deep import still listed  ${from} -> ${to}`);
  if (unknown.length > 0) {
    console.log("Unknown paths");
    for (const path of unknown) console.log(path);
  }
  console.log(`Imports across a bundle boundary  ${bundleViolations.length}`);
  for (const { from, to, reason } of bundleViolations) {
    console.log(`${from} must not import ${to}: ${reason}`);
  }
  const failed = unknown.length > 0 || Object.values(tierPairs).some((count) => count > 0) ||
    hasFileCycles(fileCycles) || bundleViolations.length > 0 ||
    deepImportDrift.added.length > 0 || deepImportDrift.stale.length > 0;
  if (failed || printEdges) {
    console.log("Forbidden edges");
    for (const { from, to, pair } of forbiddenEdges) {
      const reason = edgeReason(...pair.split("->"));
      console.log(`${from} -> ${to}  (${pair})${reason ? `\n  ${reason}` : ""}`);
    }
    console.log("File cycles");
    for (const cycle of fileCycles) console.log(cycle.join(" -> "));
    console.log("Cross-cluster deep import edges");
    for (const [from, to] of deepImports) console.log(`${from} -> ${to}`);
  }
  console.log(failed ? "boundaries FAIL" : `boundaries PASS: ${moduleCount} module(s) read`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    main();
  } catch (error) {
    console.error(`boundaries FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
