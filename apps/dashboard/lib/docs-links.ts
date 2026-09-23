/**
 * Where the dashboard sends a person to read this product's own setup
 * documents. One home, so a moved repository or a renamed section is one edit.
 */
const REPOSITORY_DOCS = "https://github.com/Blazity/ai-workflow/blob/main";

/** SETUP.md, the section on the key stored integration secrets are encrypted with. */
export const SECRETS_KEY_SETUP_URL = `${REPOSITORY_DOCS}/SETUP.md#integration-secrets`;
