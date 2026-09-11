/**
 * Authoring-time inspection of a JSON Schema the dashboard is editing.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export { inspectJsonSchemaSource } from "./schema-inspection.js";
