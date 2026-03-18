import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@octokit/rest', () => {
  const mockInstance = {
    git: {
      getRef: vi.fn(),
      createRef: vi.fn(),
    },
    pulls: {
      create: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      listReviewComments: vi.fn(),
      get: vi.fn(),
    },
    repos: {
      getContent: vi.fn(),
      createOrUpdateFileContents: vi.fn(),
    },
  };
  return {
    Octokit: vi.fn(function Octokit() {
      return mockInstance;
    }),
  };
});

describe('GitHubClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a branch from base branch SHA', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.git.getRef.mockResolvedValue({
      data: { object: { sha: 'abc123' } },
    });
    mockInstance.git.createRef.mockResolvedValue({ data: {} });

    await client.createBranch('owner', 'repo', 'blazebot/PROJ-42', 'main');

    expect(mockInstance.git.getRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'heads/main',
    });
    expect(mockInstance.git.createRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/blazebot/PROJ-42',
      sha: 'abc123',
    });
  });

  it('silently succeeds when branch already exists (422)', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.git.getRef.mockResolvedValue({
      data: { object: { sha: 'abc123' } },
    });
    mockInstance.git.createRef.mockRejectedValue(
      Object.assign(new Error('Reference already exists'), { status: 422 }),
    );

    await client.createBranch('owner', 'repo', 'blazebot/PROJ-42', 'main');
  });

  it('creates a pull request', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.create.mockResolvedValue({
      data: { number: 42, html_url: 'https://github.com/owner/repo/pull/42' },
    });

    const pr = await client.createPR(
      'owner',
      'repo',
      'feat: add dark mode',
      'Implements dark mode',
      'blazebot/PROJ-42',
      'main',
    );

    expect(pr).toEqual({
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
    });
  });

  it('returns existing PR when create returns 422', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.create.mockRejectedValue(
      Object.assign(new Error('Validation Failed'), { status: 422 }),
    );
    mockInstance.pulls.list.mockResolvedValue({
      data: [{ number: 99, html_url: 'https://github.com/owner/repo/pull/99' }],
    });
    mockInstance.pulls.update.mockResolvedValue({ data: {} });

    const pr = await client.createPR(
      'owner',
      'repo',
      'updated title',
      'updated body',
      'blazebot/PROJ-42',
      'main',
    );

    expect(pr).toEqual({
      number: 99,
      url: 'https://github.com/owner/repo/pull/99',
    });
    expect(mockInstance.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 99,
        title: 'updated title',
        body: 'updated body',
      }),
    );
  });

  it('getFileContent returns decoded file content', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from('You are an agent.').toString('base64'),
        encoding: 'base64',
      },
    });

    const content = await client.getFileContent(
      'owner',
      'repo',
      '.blazebot/implement.md',
      'main',
    );
    expect(content).toBe('You are an agent.');
  });

  it('getFileContent returns null when file not found', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.repos.getContent.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    const content = await client.getFileContent(
      'owner',
      'repo',
      '.blazebot/missing.md',
      'main',
    );
    expect(content).toBeNull();
  });

  it('getPRComments returns formatted comments', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.listReviewComments.mockResolvedValue({
      data: [
        {
          user: { login: 'reviewer' },
          body: 'Fix this',
          path: 'src/app.ts',
          line: 42,
        },
      ],
    });

    const comments = await client.getPRComments('owner', 'repo', 1);

    expect(comments).toEqual([
      {
        author: 'reviewer',
        body: 'Fix this',
        path: 'src/app.ts',
        line: 42,
        fromApprovedReview: false,
      },
    ]);
  });

  it('getPRComments marks comments with +1 reactions as liked', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.listReviewComments.mockResolvedValue({
      data: [
        {
          user: { login: 'reviewer' },
          body: 'This needs fixing',
          path: 'src/app.ts',
          line: 10,
          reactions: { '+1': 2, '-1': 0 },
        },
        {
          user: { login: 'reviewer2' },
          body: 'Nit: spacing',
          path: 'src/app.ts',
          line: 20,
          reactions: { '+1': 0, '-1': 0 },
        },
        {
          user: { login: 'reviewer3' },
          body: 'Old comment',
          path: 'src/old.ts',
          line: 5,
        },
      ],
    });

    const comments = await client.getPRComments('owner', 'repo', 1);

    expect(comments).toEqual([
      expect.objectContaining({ author: 'reviewer', fromApprovedReview: true }),
      expect.objectContaining({
        author: 'reviewer2',
        fromApprovedReview: false,
      }),
      expect.objectContaining({
        author: 'reviewer3',
        fromApprovedReview: false,
      }),
    ]);
  });

  it('initializes empty repo and creates branch when getRef returns 409', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;

    mockInstance.git.getRef.mockRejectedValueOnce(
      Object.assign(new Error('Git Repository is empty'), { status: 409 }),
    );

    mockInstance.repos.createOrUpdateFileContents.mockResolvedValue({
      data: { commit: { sha: 'init-sha' } },
    });
    mockInstance.git.createRef.mockResolvedValue({ data: {} });

    await client.createBranch('owner', 'repo', 'blazebot/PROJ-42', 'main');

    expect(mockInstance.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      path: 'README.md',
      message: 'Initial commit',
      content: expect.any(String),
    });
    expect(mockInstance.git.getRef).toHaveBeenCalledTimes(1);
    expect(mockInstance.git.createRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/blazebot/PROJ-42',
      sha: 'init-sha',
    });
  });

  it('propagates non-409 errors from getRef', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.git.getRef.mockRejectedValue(
      Object.assign(new Error('Internal Server Error'), { status: 500 }),
    );

    await expect(
      client.createBranch('owner', 'repo', 'blazebot/PROJ-42', 'main'),
    ).rejects.toThrow('Internal Server Error');

    expect(
      mockInstance.repos.createOrUpdateFileContents,
    ).not.toHaveBeenCalled();
  });

  it('wraps createOrUpdateFileContents errors with repo context', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.git.getRef.mockRejectedValueOnce(
      Object.assign(new Error('Git Repository is empty'), { status: 409 }),
    );
    mockInstance.repos.createOrUpdateFileContents.mockRejectedValue(
      new Error('Resource not accessible by integration'),
    );

    await expect(
      client.createBranch('owner', 'repo', 'blazebot/PROJ-42', 'main'),
    ).rejects.toThrow(
      'Failed to initialize empty repository owner/repo: Resource not accessible by integration',
    );
  });

  it('getPRConflictStatus returns true when mergeable is false', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.get.mockResolvedValue({
      data: { mergeable: false },
    });

    const hasConflicts = await client.getPRConflictStatus('owner', 'repo', 1);
    expect(hasConflicts).toBe(true);
  });

  it('getPRConflictStatus returns false when mergeable is true', async () => {
    const { Octokit } = await import('@octokit/rest');
    const { GitHubClient } = await import('./github-client.js');
    const client = new GitHubClient('test-token');

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.get.mockResolvedValue({
      data: { mergeable: true },
    });

    const hasConflicts = await client.getPRConflictStatus('owner', 'repo', 1);
    expect(hasConflicts).toBe(false);
  });
});
