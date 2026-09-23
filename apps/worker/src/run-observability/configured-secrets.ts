/**
 * The environment half of "the secrets this deployment knows".
 *
 * The whole set is `knownSecretValues()` in services/integrations/secret-values.ts:
 * these values plus the secrets of every connected integration, including a
 * connection an admin stored in the dashboard, which is decrypted from the
 * database and never appears in the environment. Anything that can await
 * uses that set. This half exists for the code that cannot: workflow scope,
 * which sees the environment (the Workflow VM hands it a frozen copy) but can
 * never read a connection, and the few synchronous passes that run before a
 * value crosses into a step. What those passes miss, the step that writes or
 * publishes the value catches with the whole set.
 *
 * It is also the ONE rule for which environment variables hold a secret.
 * Three filters used to answer that question (this one, a second inside the
 * diagnostic redactor, a hand-kept list in the MCP sanitizer), and a variable
 * could be a secret to one of them and plain text to another.
 */

// The secret words, plus two kinds of names that hold a credential without
// saying so: a database connection string (DATABASE_URL, POSTGRES_URL and the
// variants the Neon integration injects carry the password) and an encryption
// key (WEBHOOK_TRIGGER_ENCRYPTION_KEY, which the MCP result sanitizer redacts).
const SECRET_ENVIRONMENT_KEY =
  /(?:password|secret|token|private[_-]?key|api[_-]?key|oauth|credential|encryption[_-]?key|(?:database|postgres)\w*url)/i;

export function environmentSecretValues(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        value.length > 0 &&
        SECRET_ENVIRONMENT_KEY.test(key),
    )
    .map(([, value]) => value!);
}

/**
 * Every written form of these secrets a redactor looks for, longest first so a
 * longer form is replaced before a shorter one inside it. The ONE answer for
 * the three redactors (a provider's message, `redactIntegrationText`; a health
 * probe's message; the run log and everything it feeds, `sanitizer.ts`), which
 * used to know three different lists.
 *
 * - The value as written, whatever its length: a short credential is a bad
 *   credential, not a public one.
 * - For a value of at least `ENCODED_FORM_FLOOR` characters, the forms a
 *   provider echoes it back in: percent-encoded, base64 and JSON-escaped (a PEM
 *   key quoted in a JSON error body has `\n` for each newline). A shorter
 *   value's encoded forms would match by coincidence and mangle the sentence.
 * - Each line of a multiline value that is at least `SECRET_LINE_FLOOR`
 *   characters once trimmed, since a provider may quote one line of a key; a
 *   shorter line, or a PEM BEGIN or END line, is public boilerplate.
 *
 * Pure and free of Node globals: the workflow bundle runs the sanitizer, and
 * has no Buffer.
 */
export function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    forms.add(secret);
    if (secret.length >= ENCODED_FORM_FLOOR) {
      forms.add(encodeURIComponent(secret));
      forms.add(base64(secret));
      forms.add(JSON.stringify(secret).slice(1, -1));
    }
    if (/\r?\n/u.test(secret)) {
      for (const line of secret.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length >= SECRET_LINE_FLOOR && !PEM_ARMOR.test(trimmed)) forms.add(trimmed);
      }
    }
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

/** Below this, an encoded form is more likely a coincidence than a leak. */
const ENCODED_FORM_FLOOR = 8;
/** Below this, a line of a multiline secret is boilerplate, not a credential. */
const SECRET_LINE_FLOOR = 16;
/** `-----BEGIN RSA PRIVATE KEY-----` and its END: the same in every key. */
const PEM_ARMOR = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/u;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard padded base64 of the UTF-8 bytes, without Buffer or btoa. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const chunk = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]!;
    out += b === undefined ? "=" : BASE64_ALPHABET[(chunk >> 6) & 63]!;
    out += c === undefined ? "=" : BASE64_ALPHABET[chunk & 63]!;
  }
  return out;
}
