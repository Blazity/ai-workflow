import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readPrivateKey, requirePrivateKey } from "./auth";

/**
 * A real RSA key, generated here rather than pasted, so these tests run against
 * the bytes GitHub actually hands an admin rather than a shape we invented.
 */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const pem = privateKey as unknown as string;
const base64 = Buffer.from(pem, "utf8").toString("base64");

describe("the GitHub App private key, in every form it arrives in", () => {
  it("accepts the base64 the environment has carried since before this integration existed", () => {
    const reading = readPrivateKey(base64);
    expect(reading).toEqual({ ok: true, pem: `${pem.trimEnd()}\n` });
  });

  it("accepts the .pem file whole, which is what an admin has on disk", () => {
    const reading = readPrivateKey(pem);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    // Byte for byte: a key that survives the read but not intact signs nothing.
    expect(reading.pem.trimEnd()).toBe(pem.trimEnd());
  });

  it("accepts a .pem whose newlines arrived as the two characters backslash n", () => {
    const escaped = pem.trimEnd().split("\n").join("\\n");
    const reading = readPrivateKey(escaped);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.pem.trimEnd()).toBe(pem.trimEnd());
  });

  it("accepts base64 that a deployment UI wrapped across lines", () => {
    const wrapped = (base64.match(/.{1,64}/gu) ?? []).join("\n");
    const reading = readPrivateKey(wrapped);
    expect(reading).toEqual({ ok: true, pem: `${pem.trimEnd()}\n` });
  });

  // What main ran with: origin/main apps/worker/src/adapters/vcs/github-auth.ts:20-21
  // decoded GITHUB_APP_PRIVATE_KEY with Buffer.from(value, "base64"), which
  // skips anything outside the alphabet and needs no padding, and
  // universal-github-app-jwt 2.2.2 (index.js:17) turned a written backslash-n
  // back into a line break before signing. Each of these signed on main.
  it("accepts the base64 of a .pem whose newlines were written as backslash n", () => {
    const escaped = pem.trimEnd().split("\n").join("\\n");
    const reading = readPrivateKey(Buffer.from(escaped, "utf8").toString("base64"));
    expect(reading).toEqual({ ok: true, pem: `${pem.trimEnd()}\n` });
  });

  it("accepts base64 whose padding was dropped", () => {
    // A trailing line changes the length until the encoding needs padding.
    let padded = pem;
    while (!Buffer.from(padded, "utf8").toString("base64").endsWith("=")) padded += "\n";
    const unpadded = Buffer.from(padded, "utf8").toString("base64").replace(/=+$/u, "");
    expect(readPrivateKey(unpadded)).toEqual({ ok: true, pem: `${pem.trimEnd()}\n` });
  });

  it("accepts base64 wrapped in the quotes a .env file puts around it", () => {
    expect(readPrivateKey(`"${base64}"`)).toEqual({ ok: true, pem: `${pem.trimEnd()}\n` });
  });

  it("accepts the URL-safe base64 alphabet, which the same decoder read", () => {
    const reading = readPrivateKey(Buffer.from(pem, "utf8").toString("base64url"));
    expect(reading).toEqual({ ok: true, pem: `${pem.trimEnd()}\n` });
  });

  it("refuses a value that is neither, and says which two forms it wanted", () => {
    const reading = readPrivateKey("my github app key (the one from settings)");
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.reason).toContain("neither a PEM block nor base64");
    expect(reading.reason).toContain("-----BEGIN RSA PRIVATE KEY-----");
  });

  it("refuses a PEM block with a line missing, which only reading it as a key catches", () => {
    const lines = pem.trimEnd().split("\n");
    lines.splice(5, 1);
    const reading = readPrivateKey(lines.join("\n"));
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.reason).toContain("does not read as a key");
    // The key itself is never quoted back.
    expect(reading.reason).not.toContain(lines[3]!);
  });

  it("refuses a key GitHub cannot sign App tokens with", () => {
    const ec = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey as unknown as string;
    const reading = readPrivateKey(ec);
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.reason).toContain("not an RSA key (it reads as ec)");
  });

  it("refuses base64 that decodes to something that is not a key", () => {
    const reading = readPrivateKey(Buffer.from("not a key at all", "utf8").toString("base64"));
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.reason).toContain("does not decode to a PEM private key");
  });

  it("refuses an empty value rather than reporting a connection with no key", () => {
    expect(readPrivateKey("").ok).toBe(false);
    expect(readPrivateKey("   \n ").ok).toBe(false);
    expect(readPrivateKey(undefined).ok).toBe(false);
  });

  it("throws the same sentence where a caller cannot carry on without a key", () => {
    expect(() => requirePrivateKey("my github app key (the one from settings)")).toThrow(
      /neither a PEM block nor base64/u,
    );
    expect(requirePrivateKey(base64).trimEnd()).toBe(pem.trimEnd());
  });
});

/**
 * The defect this reader exists to close, written down as a test so nobody
 * reintroduces the shortcut. `Buffer.from(value, "base64")` drops every
 * character outside the base64 alphabet instead of throwing, so a pasted PEM
 * decoded to a few hundred bytes of rubbish, saved cleanly, and failed hours
 * later with a message about a bad key.
 */
describe("why the reader is not Buffer.from(value, base64)", () => {
  it("shows that the old decoding silently mangled a pasted PEM", () => {
    const salvaged = Buffer.from(pem, "base64").toString("utf8");
    expect(salvaged).not.toContain("BEGIN");
    expect(salvaged).not.toBe(pem);
    // And the reader gives that same input back unharmed.
    const reading = readPrivateKey(pem);
    expect(reading.ok).toBe(true);
    if (reading.ok) expect(reading.pem).toContain("BEGIN RSA PRIVATE KEY");
  });
});
