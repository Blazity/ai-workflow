/**
 * The two names an integration writes into everything that outlives a build.
 *
 * The id names the package, the webhook URL, the screen and every stored
 * `ticket:<id>:KEY`, and it prefixes every block type the integration
 * contributes, which is why it has no separator of its own. A block type is
 * the string a stored workflow definition holds. Each rule is written once,
 * here, and read by the SDK's conformance check, the registry generator, the
 * scaffold, the worker's routes and the definition parser, so no two of them
 * can disagree about a name the others accept.
 *
 * A field that names a version control provider (a repository's provider, a
 * trigger's provider list, a model's answer naming a repository) names an
 * integration, so it is held to `INTEGRATION_ID` too: through
 * `repositoryCatalogProviderSchema` where it can import a value, and as a
 * literal copy under a test that holds it equal where it cannot (a block
 * manifest imports only types from this package).
 */
const ID = "[a-z][a-z0-9]{2,31}";

/** 3 to 32 lowercase letters and digits, starting with a letter. */
export const INTEGRATION_ID = new RegExp(`^${ID}$`, "u");

/** The integration's id, an underscore, then lowercase words joined by underscores. */
export const INTEGRATION_BLOCK_TYPE = new RegExp(`^${ID}_[a-z0-9]+(?:_[a-z0-9]+)*$`, "u");
