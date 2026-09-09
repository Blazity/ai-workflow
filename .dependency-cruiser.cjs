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

function packagePattern(name = "[^/]+") {
  return `^(?:${tierMap.packageRoots.join("|")})/${name}(?:/|$)`;
}

const TEST = patternsFor("testing");
const PACKAGES = packagePattern();
const INTERNAL = [
  `^${tierMap.workerSourceRoot}(?:/|$)`,
  "^apps/worker/env\\.ts$",
  `^${tierMap.dashboardRoot}(?:/|$)`,
  PACKAGES,
].join("|");

function layerRule(name, from, allowedTiers, extraAllowed = []) {
  const allowed = [from, ...allowedTiers.map(effectivePattern), ...extraAllowed].join("|");
  return {
    name: `tier-${name}`,
    comment: `ADR-001 allowed edges for ${name}`,
    severity: "error",
    from: { path: from, pathNot: TEST },
    to: { path: INTERNAL, pathNot: allowed },
  };
}

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
          ...(tierMap.packageConsumers.includes(tier) ? [PACKAGES] : []),
          ...Object.entries(tierMap.edgeExceptions)
            .filter(([edge]) => edge.startsWith(`${tier}->`))
            .flatMap(([, paths]) => paths.map((path) => `^${path}$`)),
          ...((tierMap.restrictedPackageConsumers ?? {})[tier] ?? []).map(packagePattern),
        ],
      ),
    ),
    ...tierMap.packageTiers.map(
      (name) => layerRule(
        name,
        packagePattern(name),
        [],
        [...tierMap.packageEdges.default, ...(tierMap.packageEdges[name] ?? [])].map(packagePattern),
      ),
    ),
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
