/**
 * The hard bounds on what one briefing stores: the index and the repository
 * context document. Section texts are bounded by the storage budget
 * (storage.test.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_BRIEFING_CONTEXT_MAX_BYTES,
  AGENT_BRIEFING_INDEX_MAX_BYTES,
  AgentVisibilityInputError,
  agentBriefingIndexSchema,
  agentBriefingRepositoryContextSchema,
  buildAgentBriefing,
  readVisibilityRecord,
  type AgentBriefingBuildInput,
} from "./index";
import { bytes, noSecrets, planningPassInput, prose, sha, stageSixInput } from "./test-support/fixtures";

const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));

function contextOf(built: { index: { repositoryContext: { sha256: string } | null }; texts: { sha256: string; text: string }[] }) {
  const text = built.texts.find((entry) => entry.sha256 === built.index.repositoryContext!.sha256)!.text;
  const read = readVisibilityRecord(agentBriefingRepositoryContextSchema, JSON.parse(text));
  return { text, context: read.ok ? read.value : assert.fail(read.message) };
}

// Red when: the stage 6 map (150 repositories with 5 KB profiles) or a runtime
// section with 120 review threads does not fit whole, or is stored over a
// bound: stage 6 would then ship a map the briefing cannot show.
test("a 150-repository map with 5 KB profiles and 120 review threads is stored whole within both bounds", async () => {
  const input = stageSixInput();
  const built = await buildAgentBriefing(input, { sanitize: noSecrets });
  const { text, context } = contextOf(built);

  assert.ok(jsonBytes(built.index) <= AGENT_BRIEFING_INDEX_MAX_BYTES, `index is ${jsonBytes(built.index)} bytes`);
  assert.ok(bytes(text) <= AGENT_BRIEFING_CONTEXT_MAX_BYTES, `context is ${bytes(text)} bytes`);
  assert.equal(built.index.repositoryContext!.bytes, bytes(text));
  assert.equal(context.repositories.length, 150);
  input.repositoryContext!.repositories.forEach((repository, position) => {
    assert.equal(context.repositories[position]!.description.text, repository.description.text);
    assert.equal(context.repositories[position]!.rules, repository.rules);
  });
  const runtime = built.index.sections[4]!;
  assert.equal(runtime.parts.length, input.sections[4]!.parts!.length);
  assert.equal(runtime.parts.filter((part) => part.origin.kind === "pr_thread").length, 120);
  assert.equal(runtime.parts.at(-1)!.id, "pr_thread.120");
  assert.equal(runtime.truncatedForStorage, false);
  assert.equal(readVisibilityRecord(agentBriefingIndexSchema, JSON.parse(JSON.stringify(built.index))).ok, true);
});

// Red when: a context over its bound is stored anyway, refused (a sent prompt
// reported as not recorded), shortened unevenly (one repository wiped, the
// rest whole), or shortened in a key.
test("a context over its bound shortens every long text to one length, saying so, and keeps every key", async () => {
  const input = stageSixInput();
  const context = input.repositoryContext!;
  context.repositories = Array.from({ length: 400 }, (_unused, index) => ({
    ...context.repositories[index % 150]!,
    key: `github:acme/big-${index}`,
    relationships: [],
    rules: prose(`rules ${index}`, 5_120),
  }));
  const built = await buildAgentBriefing(input, { sanitize: noSecrets });
  const { text, context: stored } = contextOf(built);

  assert.ok(bytes(text) <= AGENT_BRIEFING_CONTEXT_MAX_BYTES, `context is ${bytes(text)} bytes`);
  assert.deepEqual(
    stored.repositories.map((repository) => repository.key),
    context.repositories.map((repository) => repository.key),
  );
  const lengths = new Set(stored.repositories.flatMap((repository) => [repository.description.text.length, repository.rules!.length]));
  assert.equal(lengths.size, 1, `descriptions and rules were cut to ${[...lengths].join(", ")}`);
  for (const repository of stored.repositories) {
    assert.match(repository.description.text, /\u2026 \(5120 characters in full\)$/);
  }
  // Short text under the common length stays whole.
  assert.equal(stored.repositories[24]!.reason, "Disabled in the catalog by an administrator: do not request it.");
});

// Red when: an index over its bound is stored anyway, or its identity and
// sizes are shortened along with its titles.
test("an index over its bound shortens part titles and origins, and keeps identity and sizes", async () => {
  const input: AgentBriefingBuildInput = { ...planningPassInput(), repositoryContext: null };
  const parts = Array.from({ length: 1_000 }, (_unused, index) => ({
    id: "thread",
    title: prose(`title ${index}`, 200),
    origin: { kind: "pr_thread", ref: prose(`ref ${index}`, 200), label: prose(`label ${index}`, 200) },
    content: "x",
  }));
  input.sections = [{ kind: "runtime", title: "Runtime data", text: "x".repeat(1_000), parts }];
  const small = { ...input, sections: [{ ...input.sections[0]!, text: "x", parts: parts.slice(0, 1) }] };
  const whole = await buildAgentBriefing(small, { sanitize: noSecrets });
  const { index } = await buildAgentBriefing(input, { sanitize: noSecrets });

  assert.ok(jsonBytes(index) <= AGENT_BRIEFING_INDEX_MAX_BYTES, `index is ${jsonBytes(index)} bytes`);
  const titles = new Set(index.sections[0]!.parts.map((part) => part.title.length));
  assert.equal(titles.size, 1);
  assert.ok([...titles][0]! < 200);
  assert.match(index.sections[0]!.parts[0]!.title, /\u2026 \(200 characters in full\)$/);
  assert.equal(index.sections[0]!.parts[999]!.id, "thread.1000");
  assert.deepEqual(index.identity, whole.index.identity);
  assert.deepEqual(index.harness, whole.index.harness);
  assert.equal(index.sections[0]!.sentBytes, 1_000);
});

// Red when: an index that cannot fit even with every title at its floor is
// stored over its bound instead of refused.
test("an index that cannot fit even fully shortened is refused, not stored over its bound", async () => {
  const input: AgentBriefingBuildInput = {
    ...planningPassInput(),
    repositoryContext: null,
    sections: Array.from({ length: 10 }, () => ({
      kind: "runtime",
      title: "Runtime data",
      text: "x".repeat(1_000),
      parts: Array.from({ length: 1_000 }, (_unused, index) => ({
        id: "thread",
        title: `Thread ${index}`,
        origin: { kind: "pr_thread" },
        content: "x",
      })),
    })),
  };
  await assert.rejects(buildAgentBriefing(input, { sanitize: noSecrets }), (error: unknown) => {
    assert.ok(error instanceof AgentVisibilityInputError);
    assert.match(error.message, /does not fit in 524288 bytes even with every section and part title/);
    assert.match(error.message, /10 sections and 10000 parts/);
    return true;
  });
});

/** A block section's provenance as the compiler builds it from the prompt
 *  manifest: `promptId:promptName`, the resolved version, the body hash. */
function promptProvenance(count: number, name: (index: number) => string = (index) => `review step ${index}`) {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: "prompt",
    id: `p${index + 1}:${name(index)}`,
    version: index + 1,
    hash: sha(`body ${index}`),
  }));
}

// Red when: a block whose prompt includes nest past the ceiling refuses the
// briefing (a sent prompt reported as not recorded), or its extra entries
// vanish without a count.
test("a section with 20 prompt manifest entries lists the first 16 and counts all 20", async () => {
  const input = planningPassInput();
  input.sections[3] = { ...input.sections[3]!, provenance: promptProvenance(20) };
  const { index } = await buildAgentBriefing(input, { sanitize: noSecrets });
  const block = index.sections[3]!;
  assert.equal(block.provenanceCount, 20);
  assert.equal(block.provenance.length, 16);
  assert.deepEqual(block.provenance[15], { kind: "prompt", id: "p16:review step 15", version: 16, hash: sha("body 15") });
  assert.equal(index.sections[0]!.provenanceCount, 1);
});

// Red when: a long prompt name (names have no bound when written) refuses
// the briefing, or is stored cut, which would join to the wrong prompt or to
// none; the same for a harness profile id.
test("a join key is stored whole up to its bound and past it as its length and hash, never cut or refused", async () => {
  const long = "n".repeat(420);
  const huge = "h".repeat(10_000);
  const input = planningPassInput();
  input.sections[3] = {
    ...input.sections[3]!,
    provenance: [...promptProvenance(1, () => long), ...promptProvenance(1, () => huge)],
  };
  input.harness.profile = { id: `profile-${huge}`, version: 2 };
  const { index } = await buildAgentBriefing(input, { sanitize: noSecrets });

  const [whole, tooLong] = index.sections[3]!.provenance;
  assert.equal(whole!.id, `p1:${long}`);
  assert.equal(whole!.idWithheld, undefined);
  assert.equal(tooLong!.id, null);
  assert.deepEqual(tooLong!.idWithheld, { reason: "too_long", lengthUtf16: 10_003, sha256: sha(`p1:${huge}`) });
  assert.deepEqual(index.harness.profile, {
    pinned: true,
    id: null,
    idWithheld: { reason: "too_long", lengthUtf16: 10_008, sha256: sha(`profile-${huge}`) },
    version: 2,
  });
  assert.equal(JSON.stringify(index).includes("h".repeat(3_000)), false);
  assert.equal(readVisibilityRecord(agentBriefingIndexSchema, JSON.parse(JSON.stringify(index))).ok, true);
});

// Red when: a catalog larger than a context lists, or a repository with more
// relationships than it lists, refuses the briefing, or loses the rest
// without a count.
test("a catalog past the listing ceilings is listed from the start and counted, never refused", async () => {
  const input = planningPassInput();
  const base = input.repositoryContext!.repositories[1]!;
  input.repositoryContext!.repositories = Array.from({ length: 1_050 }, (_unused, index) => ({
    ...base,
    key: `github:acme/service-${index}`,
    inclusion: { cause: "catalog" },
    relationships:
      index === 0
        ? Array.from({ length: 120 }, (_unused2, target) => ({ kind: "depends_on", target: `github:acme/service-${target + 1}` }))
        : [],
  }));
  input.repositoryContext!.workScope = { version: 4, leftOutKeys: [] };
  const built = await buildAgentBriefing(input, { sanitize: noSecrets });
  const { context } = contextOf(built);
  assert.equal(built.index.repositoryContext!.repositoryCount, 1_050);
  assert.equal(context.repositories.length, 1_000);
  assert.equal(context.repositories[999]!.key, "github:acme/service-999");
  assert.deepEqual([context.repositories[0]!.relationships.length, context.repositories[0]!.relationshipCount], [100, 120]);
});
