/**
 * The contract's own fixtures, for code outside this package that exercises
 * core against them. The foil is the one core's tracing path is tested with:
 * a provider shaped nothing like the first, run through the real plan and
 * install code rather than through a stand-in written for the test.
 */
export { otelFixtureManifest } from "./fixture-manifest";
export { otelFixtureRuntime } from "./fixture-runtime";
