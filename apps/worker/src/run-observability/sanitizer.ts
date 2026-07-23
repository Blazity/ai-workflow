import type {
  JsonValue,
  ReplayAttemptOutcome,
  ReplayRedactionClass,
  ReplaySanitizationMetadata,
  ReplaySanitizedEnvelope,
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
} from "@shared/contracts";

export const REPLAY_FIELD_MAX_BYTES = 64 * 1024;
export const REPLAY_ATTEMPT_MAX_BYTES = 256 * 1024;

const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STRING_CHARACTERS = 512 * 1024;
const REPLAY_GRAPH_MAX_BYTES = 512 * 1024;
const REPLAY_LAYOUT_MAX_BYTES = 512 * 1024;
const REPLAY_IDENTIFIER_MAX_CHARACTERS = 200;
const REPLAY_NODE_NAME_MAX_CHARACTERS = 4096;
const REDACTION_PREFIX = "[REDACTED:";
const TRUNCATED_HEAD_MARKER = "\n[TRUNCATED]";
const TRUNCATED_TAIL_MARKER = "[TRUNCATED]\n";

type UnavailableReason = ReplaySanitizationMetadata["unavailableReason"];

class SanitizationError extends Error {
  constructor(readonly reason: Exclude<UnavailableReason, null>) {
    super(reason);
  }
}

interface TraversalContext {
  readonly configuredSecrets: readonly string[];
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxInputBytes: number;
  readonly maxStringCharacters: number;
  readonly seen: WeakSet<object>;
  readonly redactions: Partial<Record<ReplayRedactionClass, number>>;
  nodes: number;
  inputBytes: number;
}

export interface SanitizeReplayValueOptions {
  secrets?: readonly string[];
  maxDepth?: number;
  maxNodes?: number;
  maxInputBytes?: number;
  maxStringCharacters?: number;
  maxBytes?: number;
  /** Logs retain their most recent bytes; other envelopes retain their head. */
  retain?: "head" | "tail";
}

export interface ReplayAttemptEnvelopeSet {
  input: ReplaySanitizedEnvelope | null;
  output: ReplaySanitizedEnvelope | null;
  logs: ReplaySanitizedEnvelope | null;
  metadata: ReplaySanitizedEnvelope | null;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new SanitizationError("serialization");
  }
}

function addRedaction(
  redactions: Partial<Record<ReplayRedactionClass, number>>,
  kind: ReplayRedactionClass,
  count = 1,
): void {
  redactions[kind] = (redactions[kind] ?? 0) + count;
}

function redacted(kind: ReplayRedactionClass): string {
  return `${REDACTION_PREFIX}${kind}]`;
}

function unavailableValue(reason: Exclude<UnavailableReason, null>): JsonValue {
  return { $replay: "unavailable", reason };
}

function unavailableEnvelope(
  reason: Exclude<UnavailableReason, null>,
  redactions: Partial<Record<ReplayRedactionClass, number>> = {},
  originalBytes = 0,
): ReplaySanitizedEnvelope {
  const value = unavailableValue(reason);
  return {
    value,
    metadata: {
      redactions,
      truncated: false,
      originalBytes,
      storedBytes: jsonBytes(value),
      unavailable: true,
      unavailableReason: reason,
    },
  };
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const HARD_EXCLUDED_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "cookies",
  "cookiejar",
  "cookiejars",
  "setcookie",
  "env",
  "envvars",
  "environment",
  "environmentvariables",
  "processenv",
  "authfile",
  "authfiles",
  "authcontents",
  "credentialfile",
  "credentialfiles",
  "credentialcontents",
  "credentials",
]);

function isHardExcludedKey(key: string): boolean {
  return HARD_EXCLUDED_KEYS.has(normalizedKey(key));
}

function isSensitiveValueKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (
    normalized.endsWith("ref") ||
    normalized.endsWith("refs") ||
    normalized.endsWith("reference") ||
    normalized.endsWith("references")
  ) {
    return false;
  }
  return /(?:password|passwd|secret|token|apikey|accesskey|privatekey|sessionkey|webhookkey)/.test(
    normalized,
  );
}

function isCommandArgumentsKey(key: string): boolean {
  return [
    "args",
    "argv",
    "cmd",
    "command",
    "commandargs",
    "commandarguments",
  ].includes(
    normalizedKey(key),
  );
}

function isAuthenticationFilePath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length > 4096) return false;
  return /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.?auth(?:\.json)?|\.?credentials(?:\.json)?|\.git-credentials|\.npmrc|\.netrc|\.docker\/config\.json|\.aws\/credentials|\.config\/gh\/hosts\.ya?ml|\.config\/gcloud\/application_default_credentials\.json|\.kube\/config)$/i.test(
    value,
  );
}

function isAuthenticationFileObject(value: object): boolean {
  try {
    const candidate = value as Record<string, unknown>;
    return Object.entries(candidate).some(
      ([key, path]) =>
        ["path", "file", "filename", "filepath"].includes(
          normalizedKey(key),
        ) && isAuthenticationFilePath(path),
    );
  } catch {
    throw new SanitizationError("serialization");
  }
}

function replaceMatches(
  value: string,
  pattern: RegExp,
  kind: ReplayRedactionClass,
  redactions: Partial<Record<ReplayRedactionClass, number>>,
  predicate?: (match: string) => boolean,
): string {
  return value.replace(pattern, (match) => {
    if (predicate && !predicate(match)) return match;
    addRedaction(redactions, kind);
    return redacted(kind);
  });
}

function isLikelyPaymentCard(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isLikelyIban(candidate: string): boolean {
  const compact = candidate.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits =
      character >= "A"
        ? String(character.charCodeAt(0) - 55)
        : character;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

function isLikelyPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function accountInputText(
  value: string,
  context: TraversalContext,
): void {
  if (value.length > context.maxStringCharacters) {
    throw new SanitizationError("size_limit");
  }
  context.inputBytes += Buffer.byteLength(value, "utf8");
  if (context.inputBytes > context.maxInputBytes) {
    throw new SanitizationError("size_limit");
  }
}

function redactConfiguredSecrets(
  input: string,
  context: TraversalContext,
): string {
  const secrets = context.configuredSecrets.filter(
    (secret) => secret.length > 0,
  );
  if (secrets.length === 0) return input;

  const redactSegment = (segment: string): string => {
    let cursor = 0;
    let output = "";
    while (cursor < segment.length) {
      let matchIndex = -1;
      let matchedSecret = "";
      for (const secret of secrets) {
        const index = segment.indexOf(secret, cursor);
        if (
          index !== -1 &&
          (matchIndex === -1 ||
            index < matchIndex ||
            (index === matchIndex && secret.length > matchedSecret.length))
        ) {
          matchIndex = index;
          matchedSecret = secret;
        }
      }
      if (matchIndex === -1) {
        output += segment.slice(cursor);
        break;
      }
      output += `${segment.slice(cursor, matchIndex)}${redacted("configured_secret")}`;
      addRedaction(context.redactions, "configured_secret");
      cursor = matchIndex + matchedSecret.length;
    }
    return output;
  };

  const marker = /\[REDACTED:[a-z_]+\]/g;
  let cursor = 0;
  let output = "";
  for (const match of input.matchAll(marker)) {
    const index = match.index;
    output += redactSegment(input.slice(cursor, index));
    output += match[0];
    cursor = index + match[0].length;
  }
  output += redactSegment(input.slice(cursor));
  return output;
}

function sanitizeText(
  input: string,
  context: TraversalContext,
  alreadyAccounted = false,
): string {
  if (!alreadyAccounted) accountInputText(input, context);
  let value = redactConfiguredSecrets(input, context);

  value = value.replace(
    /(^|\s)(?:(-u)(?:=|\s*)|(--user)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
    (
      _match,
      prefix: string,
      shortFlag: string | undefined,
      longFlag: string | undefined,
    ) => {
      addRedaction(context.redactions, "command_argument");
      return `${prefix}${shortFlag ?? longFlag}=${redacted("command_argument")}`;
    },
  );
  value = value.replace(
    /(^|\s)-H(?:"([^"]*)"|'([^']*)'|((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)\s*:[^\r\n]*?)(?=\s+(?:--?[A-Za-z]|[A-Z_][A-Z0-9_]*=|https?:\/\/)|$))/gi,
    (
      match,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const header = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (!isSensitiveHeaderArgument(header)) return match;
      addRedaction(context.redactions, "command_argument");
      return `${prefix}-H=${redacted("command_argument")}`;
    },
  );
  value = value.replace(
    /(^|\s)(-H|--header)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/gi,
    (
      match,
      prefix: string,
      flag: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const header = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (!isSensitiveHeaderArgument(header)) return match;
      addRedaction(context.redactions, "command_argument");
      return `${prefix}${flag}=${redacted("command_argument")}`;
    },
  );
  value = value.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)[ \t]*:[^\r\n]*/gi,
    (_match, header: string) => {
      addRedaction(context.redactions, "hard_exclusion");
      return `${header}: ${redacted("hard_exclusion")}`;
    },
  );
  value = replaceMatches(
    value,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "private_key",
    context.redactions,
  );
  value = replaceMatches(
    value,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+(?::[^@\s/]*)?@[^\s]+/gi,
    "credential_url",
    context.redactions,
  );
  value = replaceMatches(
    value,
    /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    "jwt",
    context.redactions,
  );
  value = replaceMatches(
    value,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    "token",
    context.redactions,
  );
  value = replaceMatches(
    value,
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    "token",
    context.redactions,
  );
  value = replaceMatches(
    value,
    /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi,
    "iban",
    context.redactions,
    isLikelyIban,
  );
  value = replaceMatches(
    value,
    /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    "payment_card",
    context.redactions,
    isLikelyPaymentCard,
  );
  value = replaceMatches(
    value,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "email",
    context.redactions,
  );
  value = replaceMatches(
    value,
    /(?<![A-Za-z0-9])(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}(?![A-Za-z0-9])/g,
    "phone",
    context.redactions,
    isLikelyPhone,
  );
  value = replaceMatches(
    value,
    /\b(?:pi|pm|ch|cus|cs|seti|src|txn)_[A-Za-z0-9]{8,}\b/g,
    "payment_identifier",
    context.redactions,
  );

  return value;
}

const SENSITIVE_ARGUMENT =
  /^(--?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|password|passwd|secret|token|cookie|proxy[-_]?user|oauth2[-_]?bearer))(?:=(.*))?$/i;
const USER_ARGUMENT = /^(?:-u|--user)(?:=(.*))?$/i;
const HEADER_ARGUMENT = /^(?:-H|--header)(?:=(.*))?$/;

function isSensitiveHeaderArgument(value: string): boolean {
  const unquoted =
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
  const separator = unquoted.indexOf(":");
  if (separator < 1) return false;
  const name = normalizedKey(unquoted.slice(0, separator));
  return [
    "authorization",
    "proxyauthorization",
    "cookie",
    "setcookie",
    "xapikey",
    "xauthtoken",
    "apikey",
  ].includes(name);
}

function sanitizeCommandArguments(
  value: unknown,
  context: TraversalContext,
  depth: number,
): JsonValue {
  if (typeof value === "string") {
    accountInputText(value, context);
    let sanitized = value.replace(
      /(^|\s)(?:(-u)(?:=|\s*)|(--user)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
      (
        _match,
        prefix: string,
        shortFlag: string | undefined,
        longFlag: string | undefined,
      ) => {
        addRedaction(context.redactions, "command_argument");
        return `${prefix}${shortFlag ?? longFlag}=${redacted("command_argument")}`;
      },
    );
    sanitized = sanitized.replace(
      /(^|\s)(-b)(?:=|\s*)("[^"]*"|'[^']*'|\S+)/gi,
      (_match, prefix: string, flag: string) => {
        addRedaction(context.redactions, "command_argument");
        return `${prefix}${flag}=${redacted("command_argument")}`;
      },
    );
    sanitized = sanitized.replace(
      /(^|\s)-H(?:"([^"]*)"|'([^']*)'|((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)\s*:[^\r\n]*?)(?=\s+(?:--?[A-Za-z]|[A-Z_][A-Z0-9_]*=|https?:\/\/)|$))/gi,
      (
        match,
        prefix: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        bare: string | undefined,
      ) => {
        const header = doubleQuoted ?? singleQuoted ?? bare ?? "";
        if (!isSensitiveHeaderArgument(header)) return match;
        addRedaction(context.redactions, "command_argument");
        return `${prefix}-H=${redacted("command_argument")}`;
      },
    );
    sanitized = sanitized.replace(
      /(^|\s)(-H|--header)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/gi,
      (
        match,
        prefix: string,
        flag: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        bare: string | undefined,
      ) => {
        const header = doubleQuoted ?? singleQuoted ?? bare ?? "";
        if (!isSensitiveHeaderArgument(header)) return match;
        addRedaction(context.redactions, "command_argument");
        return `${prefix}${flag}=${redacted("command_argument")}`;
      },
    );
    sanitized = sanitized.replace(
      /(--?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|password|passwd|secret|token|cookie|proxy[-_]?user|oauth2[-_]?bearer))(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      (match, flag: string) => {
        addRedaction(context.redactions, "command_argument");
        return `${flag}=${redacted("command_argument")}`;
      },
    );
    sanitized = sanitized.replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/gi,
      (_match, name: string) => {
        addRedaction(context.redactions, "command_argument");
        return `${name}=${redacted("command_argument")}`;
      },
    );
    return sanitizeText(sanitized, context, true);
  }
  if (!Array.isArray(value)) return sanitizeValue(value, context, depth);

  const output: JsonValue[] = [];
  let redactNext: "value" | "header" | null = null;
  for (const item of value) {
    if (typeof item !== "string") {
      if (redactNext === "value") {
        output.push(redacted("command_argument"));
        addRedaction(context.redactions, "command_argument");
      } else {
        output.push(sanitizeValue(item, context, depth + 1));
      }
      redactNext = null;
      continue;
    }
    accountInputText(item, context);
    if (redactNext === "value") {
      output.push(redacted("command_argument"));
      addRedaction(context.redactions, "command_argument");
      redactNext = null;
      continue;
    }
    if (redactNext === "header") {
      if (isSensitiveHeaderArgument(item)) {
        output.push(redacted("command_argument"));
        addRedaction(context.redactions, "command_argument");
      } else {
        output.push(sanitizeText(item, context, true));
      }
      redactNext = null;
      continue;
    }
    const attachedUser = /^-u(.+)$/.exec(item);
    if (attachedUser) {
      output.push(`-u=${redacted("command_argument")}`);
      addRedaction(context.redactions, "command_argument");
      continue;
    }
    const attachedCookie = /^-b(.+)$/.exec(item);
    if (attachedCookie) {
      output.push(`-b=${redacted("command_argument")}`);
      addRedaction(context.redactions, "command_argument");
      continue;
    }
    if (item === "-b") {
      output.push(item);
      redactNext = "value";
      continue;
    }
    const attachedHeader = /^-H(.+)$/.exec(item);
    if (attachedHeader && isSensitiveHeaderArgument(attachedHeader[1]!)) {
      output.push(`-H=${redacted("command_argument")}`);
      addRedaction(context.redactions, "command_argument");
      continue;
    }
    const user = USER_ARGUMENT.exec(item);
    if (user) {
      if (user[1] === undefined) {
        output.push(item);
        redactNext = "value";
      } else {
        output.push(`${item.slice(0, item.indexOf("="))}=${redacted("command_argument")}`);
        addRedaction(context.redactions, "command_argument");
      }
      continue;
    }
    const header = HEADER_ARGUMENT.exec(item);
    if (header) {
      if (header[1] === undefined) {
        output.push(item);
        redactNext = "header";
      } else if (isSensitiveHeaderArgument(header[1])) {
        output.push(`${item.slice(0, item.indexOf("="))}=${redacted("command_argument")}`);
        addRedaction(context.redactions, "command_argument");
      } else {
        output.push(sanitizeText(item, context, true));
      }
      continue;
    }
    const flag = SENSITIVE_ARGUMENT.exec(item);
    if (flag) {
      if (flag[2] === undefined) {
        output.push(flag[1]!);
        redactNext = "value";
      } else {
        output.push(`${flag[1]}=${redacted("command_argument")}`);
        addRedaction(context.redactions, "command_argument");
      }
      continue;
    }
    const assignmentAt = item.indexOf("=");
    const assignmentName =
      assignmentAt > 0 ? item.slice(0, assignmentAt) : "";
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(assignmentName) &&
      isSensitiveValueKey(assignmentName)
    ) {
      output.push(`${assignmentName}=${redacted("command_argument")}`);
      addRedaction(context.redactions, "command_argument");
      continue;
    }
    output.push(sanitizeText(item, context, true));
  }
  return output;
}

function sanitizeValue(
  value: unknown,
  context: TraversalContext,
  depth: number,
): JsonValue {
  context.nodes += 1;
  if (depth > context.maxDepth || context.nodes > context.maxNodes) {
    throw new SanitizationError("traversal_limit");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value === "string" ? sanitizeText(value, context) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SanitizationError("serialization");
    return value;
  }
  if (typeof value !== "object") {
    throw new SanitizationError("serialization");
  }
  if (context.seen.has(value)) {
    throw new SanitizationError("traversal_limit");
  }
  context.seen.add(value);

  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (const item of value) {
        output.push(sanitizeValue(item, context, depth + 1));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SanitizationError("serialization");
    }
    if (isAuthenticationFileObject(value)) {
      addRedaction(context.redactions, "hard_exclusion");
      return redacted("hard_exclusion");
    }

    const output: Record<string, JsonValue> = {};
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      accountInputText(key, context);
      const sanitizedKey = sanitizeText(key, context, true);
      if (Object.prototype.hasOwnProperty.call(output, sanitizedKey)) {
        throw new SanitizationError("serialization");
      }
      const item = record[key];
      if (isHardExcludedKey(key)) {
        output[sanitizedKey] = redacted("hard_exclusion");
        addRedaction(context.redactions, "hard_exclusion");
      } else if (isSensitiveValueKey(key)) {
        output[sanitizedKey] = redacted("token");
        addRedaction(context.redactions, "token");
      } else if (isCommandArgumentsKey(key)) {
        output[sanitizedKey] = sanitizeCommandArguments(
          item,
          context,
          depth + 1,
        );
      } else {
        output[sanitizedKey] = sanitizeValue(item, context, depth + 1);
      }
    }
    return output;
  } catch (error) {
    if (error instanceof SanitizationError) throw error;
    throw new SanitizationError("serialization");
  } finally {
    context.seen.delete(value);
  }
}

function sliceUtf8(
  value: string,
  maxBytes: number,
  retain: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  const characters = Array.from(value);
  let bytes = 0;
  const selected: string[] = [];
  if (retain === "head") {
    for (const character of characters) {
      const width = Buffer.byteLength(character, "utf8");
      if (bytes + width > maxBytes) break;
      selected.push(character);
      bytes += width;
    }
    return selected.join("");
  }
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    selected.push(character);
    bytes += width;
  }
  return selected.reverse().join("");
}

function truncatedValue(
  value: JsonValue,
  maxValueBytes: number,
  retain: "head" | "tail",
): JsonValue {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value);
  const marker =
    retain === "tail" ? TRUNCATED_TAIL_MARKER : TRUNCATED_HEAD_MARKER;
  const contentBudget = Math.max(
    0,
    maxValueBytes - Buffer.byteLength(marker, "utf8") - 2,
  );
  const content = sliceUtf8(serialized, contentBudget, retain);
  return retain === "tail" ? `${marker}${content}` : `${content}${marker}`;
}

function fitEnvelope(
  value: JsonValue,
  metadata: Omit<ReplaySanitizationMetadata, "storedBytes">,
  maxBytes: number,
  retain: "head" | "tail",
): ReplaySanitizedEnvelope {
  let nextValue = value;
  let nextMetadata = { ...metadata };
  let envelope: ReplaySanitizedEnvelope = {
    value: nextValue,
    metadata: {
      ...nextMetadata,
      storedBytes: jsonBytes(nextValue),
    },
  };
  if (jsonBytes(envelope) <= maxBytes) return envelope;

  nextMetadata = { ...nextMetadata, truncated: true };
  let valueBudget = Math.max(64, maxBytes - 768);
  while (valueBudget >= 64) {
    nextValue = truncatedValue(value, valueBudget, retain);
    envelope = {
      value: nextValue,
      metadata: {
        ...nextMetadata,
        storedBytes: jsonBytes(nextValue),
      },
    };
    const envelopeBytes = jsonBytes(envelope);
    if (envelopeBytes <= maxBytes) return envelope;
    valueBudget -= Math.max(64, envelopeBytes - maxBytes + 32);
  }
  return unavailableEnvelope(
    "size_limit",
    nextMetadata.redactions,
    nextMetadata.originalBytes,
  );
}

export function sanitizeReplayValue(
  value: unknown,
  options: SanitizeReplayValueOptions = {},
): ReplaySanitizedEnvelope {
  const context: TraversalContext = {
    configuredSecrets: [...(options.secrets ?? [])].sort(
      (left, right) => right.length - left.length,
    ),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxInputBytes: options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    maxStringCharacters:
      options.maxStringCharacters ?? DEFAULT_MAX_STRING_CHARACTERS,
    seen: new WeakSet(),
    redactions: {},
    nodes: 0,
    inputBytes: 0,
  };
  try {
    const sanitized = sanitizeValue(value, context, 0);
    const originalBytes = jsonBytes(sanitized);
    return fitEnvelope(
      sanitized,
      {
        redactions: context.redactions,
        truncated: false,
        originalBytes,
        unavailable: false,
        unavailableReason: null,
      },
      options.maxBytes ?? REPLAY_FIELD_MAX_BYTES,
      options.retain ?? "head",
    );
  } catch (error) {
    const reason =
      error instanceof SanitizationError ? error.reason : "serialization";
    return unavailableEnvelope(reason, context.redactions);
  }
}

function sanitizedPresentationText(
  value: string,
  secrets: readonly string[] | undefined,
): string {
  const envelope = sanitizeReplayValue(value, {
    secrets,
    maxBytes: 8 * 1024,
  });
  return typeof envelope.value === "string"
    ? envelope.value
    : "[REPLAY VALUE UNAVAILABLE]";
}

function isSafeReplayIdentifier(
  value: string,
  secrets: readonly string[] | undefined,
): boolean {
  if (
    !(
      value.length > 0 &&
      value.length <= REPLAY_IDENTIFIER_MAX_CHARACTERS &&
      /^[A-Za-z0-9_.:-]+$/.test(value)
    )
  ) {
    return false;
  }
  const sanitized = sanitizeReplayValue(value, {
    secrets,
    maxBytes: 8 * 1024,
  });
  return (
    !sanitized.metadata.unavailable &&
    Object.keys(sanitized.metadata.redactions).length === 0 &&
    sanitized.value === value
  );
}

export function sanitizeReplayGraphSnapshot(
  graph: WorkflowReplayGraphSnapshot,
  secrets?: readonly string[],
): WorkflowReplayGraphSnapshot | null {
  if (
    graph.nodes.some(
      (node) =>
        !isSafeReplayIdentifier(node.id, secrets) ||
        !Number.isFinite(node.x) ||
        !Number.isFinite(node.y) ||
        (node.name !== null &&
          node.name.length > REPLAY_NODE_NAME_MAX_CHARACTERS),
    ) ||
    graph.edges.some(
      (edge) =>
        !isSafeReplayIdentifier(edge.id, secrets) ||
        !isSafeReplayIdentifier(edge.from, secrets) ||
        !isSafeReplayIdentifier(edge.to, secrets) ||
        (edge.fromPort !== null &&
          !isSafeReplayIdentifier(edge.fromPort, secrets)),
    )
  ) {
    return null;
  }
  const sanitized: WorkflowReplayGraphSnapshot = {
    nodes: graph.nodes.map((node) => ({
      ...node,
      name:
        node.name === null
          ? null
          : sanitizedPresentationText(node.name, secrets),
    })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
  return jsonBytes(sanitized) <= REPLAY_GRAPH_MAX_BYTES
    ? sanitized
    : null;
}

export function sanitizeReplayLayoutSnapshot(
  layout: WorkflowReplayLayoutSnapshot,
  secrets?: readonly string[],
): WorkflowReplayLayoutSnapshot | null {
  const nodes: WorkflowReplayLayoutSnapshot["nodes"] = {};
  for (const [nodeId, position] of Object.entries(layout.nodes)) {
    if (!isSafeReplayIdentifier(nodeId, secrets)) return null;
    if (
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    ) {
      nodes[nodeId] = { x: position.x, y: position.y };
    }
  }
  if (!layout.edges) {
    const sanitized = { nodes };
    return jsonBytes(sanitized) <= REPLAY_LAYOUT_MAX_BYTES
      ? sanitized
      : null;
  }
  if (
    Object.keys(layout.edges).some(
      (edgeId) => !isSafeReplayIdentifier(edgeId, secrets),
    )
  ) {
    return null;
  }
  const edges = sanitizeReplayValue(layout.edges, {
    secrets,
    maxBytes: REPLAY_LAYOUT_MAX_BYTES,
  });
  if (
    edges.metadata.unavailable ||
    !edges.value ||
    typeof edges.value !== "object" ||
    Array.isArray(edges.value)
  ) {
    return null;
  }
  const sanitized = {
    nodes,
    edges: edges.value as Record<string, JsonValue>,
  };
  return jsonBytes(sanitized) <= REPLAY_LAYOUT_MAX_BYTES
    ? sanitized
    : null;
}

export function sanitizeReplayAttemptOutcome(
  outcome: ReplayAttemptOutcome | null | undefined,
  secrets?: readonly string[],
): ReplayAttemptOutcome | null {
  if (!outcome) return null;
  const sanitized = sanitizeReplayValue(outcome, { secrets });
  if (
    sanitized.value &&
    typeof sanitized.value === "object" &&
    !Array.isArray(sanitized.value) &&
    typeof sanitized.value.kind === "string" &&
    typeof sanitized.value.status === "string"
  ) {
    return sanitized.value as unknown as ReplayAttemptOutcome;
  }
  return {
    kind: outcome.kind,
    status: "unavailable",
    details: sanitized.value,
  };
}

function mergeRedactions(
  ...sets: Array<Partial<Record<ReplayRedactionClass, number>>>
): Partial<Record<ReplayRedactionClass, number>> {
  const merged: Partial<Record<ReplayRedactionClass, number>> = {};
  for (const set of sets) {
    for (const [kind, count] of Object.entries(set)) {
      addRedaction(
        merged,
        kind as ReplayRedactionClass,
        count ?? 0,
      );
    }
  }
  return merged;
}

export function appendReplayLogEnvelope(
  existing: ReplaySanitizedEnvelope | null,
  next: ReplaySanitizedEnvelope,
): ReplaySanitizedEnvelope {
  if (!existing) return next;
  if (next.metadata.unavailable) return next;
  const values =
    Array.isArray(existing.value) && !existing.metadata.truncated
      ? [...existing.value, next.value]
      : [existing.value, next.value];
  const metadata = {
    redactions: mergeRedactions(
      existing.metadata.redactions,
      next.metadata.redactions,
    ),
    truncated: existing.metadata.truncated || next.metadata.truncated,
    originalBytes:
      existing.metadata.originalBytes + next.metadata.originalBytes,
    unavailable: false,
    unavailableReason: null,
  } satisfies Omit<ReplaySanitizationMetadata, "storedBytes">;
  return fitEnvelope(
    values,
    metadata,
    REPLAY_FIELD_MAX_BYTES,
    "tail",
  );
}

function shrinkEnvelope(
  envelope: ReplaySanitizedEnvelope,
  maxBytes: number,
  retain: "head" | "tail",
): ReplaySanitizedEnvelope {
  if (jsonBytes(envelope) <= maxBytes) return envelope;
  return fitEnvelope(
    envelope.value,
    {
      ...envelope.metadata,
      truncated: true,
      unavailable: false,
      unavailableReason: null,
    },
    maxBytes,
    retain,
  );
}

export function replayAttemptEnvelopeBytes(
  envelopes: ReplayAttemptEnvelopeSet,
): number {
  return jsonBytes(envelopes);
}

/** Enforces the whole-attempt budget in the product-defined reduction order:
 * logs first, then input, then output. Metadata is already field-capped. */
export function enforceReplayAttemptStorageBudget(
  envelopes: ReplayAttemptEnvelopeSet,
  maxBytes = REPLAY_ATTEMPT_MAX_BYTES,
): ReplayAttemptEnvelopeSet {
  const result = { ...envelopes };
  for (const [key, retain] of [
    ["logs", "tail"],
    ["input", "head"],
    ["output", "head"],
  ] as const) {
    const current = result[key];
    if (!current) continue;
    const total = replayAttemptEnvelopeBytes(result);
    if (total <= maxBytes) return result;
    const currentBytes = jsonBytes(current);
    const target = Math.max(256, currentBytes - (total - maxBytes) - 64);
    result[key] = shrinkEnvelope(current, target, retain);
  }
  if (replayAttemptEnvelopeBytes(result) <= maxBytes) return result;

  // A field-capped metadata envelope is the only value left after the required
  // reduction order. Fail it closed rather than ever exceeding the row budget.
  if (result.metadata) {
    result.metadata = unavailableEnvelope(
      "size_limit",
      result.metadata.metadata.redactions,
      result.metadata.metadata.originalBytes,
    );
  }
  return result;
}
