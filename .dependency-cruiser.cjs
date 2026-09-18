/**
 * ADR-001 tier rules for editor and local dependency-cruiser feedback.
 * The gate and this configuration derive their mapping from tiers.json.
 */
const tierMap = require("./scripts/gates/tiers.json");

function patternsFor(tier) {
  return tierMap.tiers[tier].patterns.join("|");
}

function exclusionsFor(tier) {
  const index = tierMap.classificationOrder.indexOf(tier);
  return tierMap.classificationOrder.slice(0, index)
    .filter((name) => name !== "testing")
    .map(patternsFor)
    .join("|");
}

function effectivePattern(tier) {
  const exclusions = exclusionsFor(tier);
  return exclusions
    ? `(?!(?:${exclusions}))(?:(?:${patternsFor(tier)}))`
    : patternsFor(tier);
}

/**
 * A package tier carries the root it came from (`packages/contracts`,
 * `integrations/sdk`), and `<root>/*` reads as any package under that root.
 */
function packagePattern(tier) {
  if (!tier) return `^(?:${tierMap.packageRoots.join("|")})/[^/]+(?:/|$)`;
  if (tier.endsWith("/*")) return `^${tier.slice(0, -2)}/[^/]+(?:/|$)`;
  return `^${tier}(?:/|$)`;
}

const TEST = patternsFor("testing");
const PACKAGES = packagePattern();
const INTERNAL = [
  `^${tierMap.workerSourceRoot}(?:/|$)`,
  "^apps/worker/env\\.ts$",
  `^${tierMap.dashboardRoot}(?:/|$)`,
  PACKAGES,
].join("|");

function layerRule(name, from, allowedTiers, extraAllowed = [], excludeFrom = []) {
  const allowed = [from, ...allowedTiers.map(effectivePattern), ...extraAllowed].join("|");
  return {
    name: `tier-${name}`,
    comment: `ADR-001 allowed edges for ${name}`,
    severity: "error",
    from: { path: from, pathNot: [TEST, ...excludeFrom].join("|") },
    to: { path: INTERNAL, pathNot: allowed },
  };
}

// A package with edges of its own is excluded from its root's wildcard rule,
// so `packages/*` does not contradict `packages/workflow-graph`.
const exactPackageTiers = Object.keys(tierMap.packageEdges).filter((tier) => !tier.endsWith("/*"));

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Circular dependencies make architecture changes unsafe.",
      severity: "error",
      from: { pathNot: TEST },
      to: { circular: true, pathNot: TEST },
    },
    ...Object.entries(tierMap.allowedEdges).map(([tier, allowed]) =>
      layerRule(
        tier,
        effectivePattern(tier),
        allowed,
        [
          ...(tierMap.packageConsumers.includes(tier)
            ? tierMap.corePackageTargets.map(packagePattern)
            : []),
          ...Object.entries(tierMap.edgeExceptions)
            .filter(([edge]) => edge.startsWith(`${tier}->`))
            .flatMap(([, paths]) => paths.map((path) => `^${path}$`)),
          ...((tierMap.restrictedPackageConsumers ?? {})[tier] ?? []).map(packagePattern),
        ],
      ),
    ),
    ...Object.entries(tierMap.packageEdges).map(([tier, allowed]) =>
      layerRule(
        tier.replaceAll("/", "-").replace("*", "any"),
        packagePattern(tier),
        [],
        allowed.map(packagePattern),
        tier.endsWith("/*")
          ? exactPackageTiers
            .filter((exact) => exact.startsWith(`${tier.slice(0, -2)}/`))
            .map(packagePattern)
          : [],
      ),
    ),
    ...(tierMap.forbiddenImports ?? []).map((rule, index) => ({
      name: `bundle-boundary-${index}`,
      comment: rule.reason,
      severity: "error",
      from: { path: rule.from, pathNot: TEST },
      to: { path: rule.to },
    })),
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
