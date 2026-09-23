import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pack } from "tar-stream";
import {
  createGitHubSkillSource,
  extractRepositoryFiles,
  SkillSourceError,
} from "./skills";

const octokit = {
  repos: {
    get: vi.fn(),
    getCommit: vi.fn(),
    downloadTarballArchive: vi.fn(),
  },
  git: { getTree: vi.fn() },
};

/** The adapter's own client, which the source is handed. */
const CLIENT = octokit as never;
/** The context's HTTP; only the snapshot download reaches it directly. */
const HTTP = { fetch: vi.fn() };

/** A snapshot as `ctx.http` hands a streamed body back: unread. */
function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new Response(new Uint8Array(bytes)).body!;
}
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

function validSkill(name = "review-rules", description = "Review rules"): Buffer {
  return Buffer.from(
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

async function tarball(
  entries: Array<{ name: string; content: Buffer }>,
): Promise<Buffer> {
  const archive = pack();
  for (const entry of entries) archive.entry({ name: entry.name }, entry.content);
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

describe("GitHub repository snapshots", () => {
  it("extracts requested files from one tarball and ignores unrelated files", async () => {
    const archive = await tarball([
      { name: "acme-skills-commit/skills/review/SKILL.md", content: validSkill() },
      {
        name: "acme-skills-commit/large-unrelated.bin",
        content: Buffer.alloc(2 * 1024 * 1024),
      },
    ]);

    const files = await extractRepositoryFiles(
      archive,
      new Set(["skills/review/SKILL.md"]),
    );

    expect([...files.keys()]).toEqual(["skills/review/SKILL.md"]);
  });

  it("rejects snapshots with multiple root directories", async () => {
    const archive = await tarball([
      { name: "first-root/skills/review/SKILL.md", content: validSkill() },
      {
        name: "second-root/skills/other/SKILL.md",
        content: validSkill("other", "Other"),
      },
    ]);

    await expect(
      extractRepositoryFiles(
        archive,
        new Set(["skills/review/SKILL.md", "skills/other/SKILL.md"]),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("GitHub skill source", () => {
  it("unpacks the snapshot for the exact commit and answers only the wanted paths", async () => {
    const archive = await tarball([
      { name: "acme-skills-abc/skills/review/SKILL.md", content: validSkill() },
      { name: "acme-skills-abc/README.md", content: Buffer.from("# ignored\n") },
    ]);
    octokit.repos.downloadTarballArchive.mockResolvedValue({ data: streamOf(archive) });

    const files = await createGitHubSkillSource(CLIENT, HTTP).getFiles({
      owner: "acme",
      repository: "skills",
      commitSha: COMMIT,
      paths: ["skills/review/SKILL.md"],
    });

    expect([...files.keys()]).toEqual(["skills/review/SKILL.md"]);
    expect(Buffer.from(files.get("skills/review/SKILL.md")!).toString()).toBe(
      validSkill().toString(),
    );
    // The snapshot has to be pinned to the commit core resolved, not to a ref
    // that can move between discovery and import.
    expect(octokit.repos.downloadTarballArchive).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "skills", ref: COMMIT }),
    );
  });

  it("refuses an archive over the 50 MiB ceiling before unpacking it", async () => {
    octokit.repos.downloadTarballArchive.mockResolvedValue({
      data: streamOf(Buffer.alloc(50 * 1024 * 1024 + 1)),
    });

    const error = await createGitHubSkillSource(CLIENT, HTTP)
      .getFiles({
        owner: "acme",
        repository: "skills",
        commitSha: COMMIT,
        paths: ["skills/review/SKILL.md"],
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    // Core maps this status straight onto the dashboard response, so a status
    // that stops travelling turns "too large" into a generic read failure.
    expect(error).toBeInstanceOf(SkillSourceError);
    expect(error).toMatchObject({
      status: 413,
      message: "GitHub repository snapshot exceeds the 50 MiB download limit",
    });
  });

  it("refuses a repository with no default branch rather than resolving an empty ref", async () => {
    octokit.repos.get.mockResolvedValue({ data: { default_branch: null } });

    await expect(
      createGitHubSkillSource(CLIENT, HTTP).getDefaultBranch({
        owner: "acme",
        repository: "skills",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "GitHub repository has no default branch",
    });
  });

  it("returns tree entries core can validate and refuses an entry it cannot", async () => {
    octokit.git.getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          {
            path: "skills/review/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: "c".repeat(40),
            size: 42,
          },
        ],
      },
    });

    await expect(
      createGitHubSkillSource(CLIENT, HTTP).getTree({
        owner: "acme",
        repository: "skills",
        treeSha: TREE,
      }),
    ).resolves.toEqual({
      truncated: false,
      entries: [
        {
          path: "skills/review/SKILL.md",
          mode: "100644",
          type: "blob",
          sha: "c".repeat(40),
          size: 42,
        },
      ],
    });

    octokit.git.getTree.mockResolvedValue({
      data: { truncated: false, tree: [{ path: "skills", type: "blob" }] },
    });
    await expect(
      createGitHubSkillSource(CLIENT, HTTP).getTree({
        owner: "acme",
        repository: "skills",
        treeSha: TREE,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

/**
 * What reaches the dashboard when GitHub refuses. Core takes any error with a
 * 4xx `status` as one that already chose its answer, and Octokit's own errors
 * carry one, so GitHub's raw "Not Found" used to be the sentence a person read.
 */
describe("GitHub refusing a skill import", () => {
  function requestError(status: number, message: string) {
    return Object.assign(new Error(message), { name: "HttpError", status });
  }

  it("says the repository is missing or outside the installation on a 404", async () => {
    octokit.repos.get.mockRejectedValueOnce(requestError(404, "Not Found"));

    const failure = await createGitHubSkillSource(CLIENT, HTTP)
      .getDefaultBranch({ owner: "acme", repository: "skills" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SkillSourceError);
    expect(failure).toMatchObject({
      status: 404,
      message: "GitHub repository not found, or not part of this App installation",
    });
  });

  it("says the installation cannot read the repository on a 403", async () => {
    octokit.repos.getCommit.mockRejectedValueOnce(
      requestError(403, "Resource not accessible by integration"),
    );

    const failure = await createGitHubSkillSource(CLIENT, HTTP)
      .resolveCommit({ owner: "acme", repository: "skills", ref: "main" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 422,
      message: "The GitHub App installation cannot read this repository",
    });
  });

  it("leaves a GitHub outage without a status of its own", async () => {
    octokit.git.getTree.mockRejectedValueOnce(requestError(502, "Bad Gateway"));

    const failure = await createGitHubSkillSource(CLIENT, HTTP)
      .getTree({ owner: "acme", repository: "skills", treeSha: TREE })
      .catch((error: unknown) => error);

    expect(failure).not.toHaveProperty("status");
  });
});

/**
 * The snapshot download through the real Octokit, against a server on a
 * loopback port that sends a tarball the way a slow link does.
 *
 * The context's attempt deadline used to end this download while its body was
 * still arriving, and Octokit reads a body that failed as an empty one, so a
 * slow download came back as 200 with zero bytes and the person read "could
 * not be unpacked safely" about a repository that was fine. The download now
 * asks the context for its body as a stream, under a deadline of its own, and
 * reads it here, where a cut is a failure to reach GitHub and the 50 MiB
 * ceiling stops the download as soon as it is crossed.
 */
describe("downloading a repository snapshot", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function github(answer: (res: http.ServerResponse) => void): Promise<string> {
    const server = http.createServer((_req, res) => answer(res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** The context's HTTP as far as a streamed body goes: the real `fetch`,
   *  with an attempt deadline running while the body is read. The one the
   *  download asked for is recorded; the test's own is short. */
  function contextHttp(deadlineMs: number) {
    const asked: Array<Record<string, unknown>> = [];
    return {
      asked,
      http: {
        fetch: (input: string | URL | Request, init?: Record<string, unknown>) => {
          asked.push({ ...init });
          return fetch(input, { ...(init as RequestInit), signal: AbortSignal.timeout(deadlineMs) });
        },
      },
    };
  }

  function download(baseUrl: string, httpClient: { fetch: (...args: never[]) => unknown }) {
    return createGitHubSkillSource(new Octokit({ baseUrl }) as never, httpClient as never)
      .getFiles({ owner: "acme", repository: "skills", commitSha: COMMIT, paths: ["skills/review/SKILL.md"] })
      .then(
        () => null,
        (error: unknown) => error as Error & { status?: number },
      );
  }

  it("reads a download cut by its deadline as GitHub not reached, not as a broken snapshot", async () => {
    const baseUrl = await github((res) => {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      res.write(Buffer.alloc(1024, 1));
      setTimeout(() => !res.destroyed && res.end(Buffer.alloc(1024, 1)), 600);
    });
    const { http: httpClient, asked } = contextHttp(150);

    const failure = await download(baseUrl, httpClient);

    expect(failure?.message).toBe("GitHub could not be reached to read this repository");
    expect(failure).not.toHaveProperty("status");
    // Asked as a stream, with a deadline for the whole download, once.
    expect(asked).toEqual([
      expect.objectContaining({ streamBody: true, timeoutMs: 50_000, retries: 0 }),
    ]);
  });

  it("stops a download as soon as it passes 50 MiB", async () => {
    let sent = 0;
    const baseUrl = await github((res) => {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      const chunk = Buffer.alloc(1024 * 1024, 1);
      const more = () => {
        while (!res.destroyed && sent < 200 * 1024 * 1024) {
          sent += chunk.byteLength;
          if (!res.write(chunk)) {
            res.once("drain", more);
            return;
          }
        }
        if (!res.destroyed) res.end();
      };
      more();
    });

    const failure = await download(baseUrl, contextHttp(10_000).http);

    expect(failure).toMatchObject({
      status: 413,
      message: "GitHub repository snapshot exceeds the 50 MiB download limit",
    });
    // Not the 200 MiB the server would have sent: the download was cancelled.
    expect(sent).toBeLessThan(100 * 1024 * 1024);
  });
});
