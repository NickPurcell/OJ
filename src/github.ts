/** Every byte OJO exchanges with GitHub goes through this file. */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AuthEnv } from './config.js';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`GitHub ${method} ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = 'GitHubError';
  }
}

/** A source of bearer tokens. */
export interface GitHubAuth {
  appJwt?(): string | null;
  /** A token good for at least the next few seconds. May mint a fresh one. */
  token(): Promise<string>;
  /** For logs and the startup banner. Never includes the credential. */
  describe(): string;
}

class PatAuth implements GitHubAuth {
  constructor(private readonly value: string) {}
  async token(): Promise<string> {
    return this.value;
  }
  describe(): string {
    return 'personal access token';
  }
}

class AppAuth implements GitHubAuth {
  #cached: { token: string; expiresAt: number } | null = null;
  #inFlight: Promise<string> | null = null;

  constructor(
    private readonly appId: string,
    private readonly installationId: string,
    private readonly privateKeyPath: string,
    private readonly apiBaseUrl: string,
  ) {}

  describe(): string {
    return `GitHub App ${this.appId} installation ${this.installationId}`;
  }

  async token(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt > now) return this.#cached.token;
    // Concurrent reviews would otherwise each mint their own token on expiry.
    // Harmless but noisy in the app's audit log, and it makes a key problem
    // look like N key problems.
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#mint().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #mint(): Promise<string> {
    const jwt = this.#appJwt();
    const url = `${this.apiBaseUrl}/app/installations/${this.installationId}/access_tokens`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'oj-review-bot',
      },
    });

    const text = await response.text();
    if (!response.ok) {
      // 401 here is almost always clock skew or the wrong key — the JWT is
      // time-sensitive and the error GitHub returns for both is identical.
      throw new GitHubError(
        response.status,
        'POST',
        `/app/installations/${this.installationId}/access_tokens`,
        `${text} (check the private key, the installation id, and the host clock)`,
      );
    }

    const parsed = JSON.parse(text) as { token?: string; expires_at?: string };
    if (!parsed.token) throw new Error('GitHub returned an installation token response with no token');

    this.#cached = { token: parsed.token, expiresAt: Date.now() + 50 * 60 * 1000 };
    return parsed.token;
  }

  /** RS256 JWT, signed with node:crypto so this needs no JWT library. */
  appJwt(): string | null {
    return this.#appJwt();
  }

  #appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    // `iat` is backdated 60s: GitHub rejects tokens issued in its future, and
    // an unsynchronised host clock is the single most common cause of a 401
    // from this endpoint. `exp` stays under the 10-minute maximum.
    const payload = { iat: now - 60, exp: now + 9 * 60, iss: this.appId };

    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const signingInput = `${encode(header)}.${encode(payload)}`;

    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(readFileSync(this.privateKeyPath, 'utf8')).toString('base64url');
    return `${signingInput}.${signature}`;
  }
}

export function createAuth(env: AuthEnv, apiBaseUrl: string): GitHubAuth {
  if (env.kind === 'pat') return new PatAuth(env.token);
  return new AppAuth(env.appId, env.installationId, env.privateKeyPath, apiBaseUrl);
}

// ── The shapes OJO actually reads ──────────────────────────────────────────── Deliberately partial.

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  htmlUrl: string;
  authorLogin: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  /** True when the head branch lives in a different repository. */
  fromFork: boolean;
  headRepoSlug: string;
  labels: string[];
  updatedAt: string;
};

type RawPull = {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  html_url?: string;
  updated_at?: string;
  user?: { login?: string } | null;
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null;
  labels?: Array<{ name?: string }>;
};

function toPullRequest(raw: RawPull, slug: string): PullRequest {
  const headRepoSlug = raw.head?.repo?.full_name ?? '';
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    draft: raw.draft === true,
    // `merged` is only present on the single-PR endpoint; the list endpoint
    // carries `merged_at` instead. Reading both keeps callers from having to
    // know which endpoint their PullRequest came from.
    merged: raw.merged === true || typeof raw.merged_at === 'string',
    htmlUrl: raw.html_url ?? '',
    authorLogin: raw.user?.login ?? '',
    baseRef: raw.base?.ref ?? '',
    baseSha: raw.base?.sha ?? '',
    headRef: raw.head?.ref ?? '',
    headSha: raw.head?.sha ?? '',
    // A deleted fork leaves head.repo null. Treating that as "not a fork"
    // would be wrong in the one direction that matters, so unknown means fork.
    fromFork: headRepoSlug !== slug,
    headRepoSlug: headRepoSlug || '(deleted repository)',
    labels: (raw.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
    updatedAt: raw.updated_at ?? '',
  };
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * The client. One per process; it holds the auth and the backoff state.
 */
export class GitHubClient {
  static readonly #RETRY_DELAYS_MS = [1_000, 4_000, 12_000] as const;

  static readonly #MAX_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

  constructor(
    private readonly auth: GitHubAuth,
    private readonly apiBaseUrl: string,
  ) {}

  describeAuth(): string {
    return this.auth.describe();
  }

  async gitToken(): Promise<string> {
    return this.auth.token();
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= GitHubClient.#RETRY_DELAYS_MS.length; attempt += 1) {
      const token = await this.auth.token();
      let response: Response;
      try {
        response = await fetch(`${this.apiBaseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'oj-review-bot',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        // DNS, TLS, connection reset. The host's network, not GitHub's answer.
        lastError = error;
        const delay = GitHubClient.#RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await sleep(delay);
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const text = await response.text();
      const wait = rateLimitWaitMs(response);

      if (wait !== null) {
        if (wait > GitHubClient.#MAX_RATE_LIMIT_WAIT_MS) {
          throw new GitHubError(
            response.status,
            method,
            path,
            `rate limited for another ${Math.round(wait / 1000)}s, which is longer than ` +
              'OJO will block the poll loop. Backing off until the next tick.',
          );
        }
        process.stderr.write(
          `[oj] rate limited on ${method} ${path} — sleeping ${Math.round(wait / 1000)}s\n`,
        );
        await sleep(wait + 1_000);
        attempt -= 1;
        continue;
      }

      if (response.status >= 500) {
        lastError = new GitHubError(response.status, method, path, text);
        const delay = GitHubClient.#RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await sleep(delay);
        continue;
      }

      throw new GitHubError(response.status, method, path, text);
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error(`GitHub ${method} ${path} failed after retries`);
  }

  async #paged<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    for (;;) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.#request<T[]>('GET', `${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) return results;
      results.push(...batch);
      if (batch.length < 100) return results;
      page += 1;
      // Ten pages of open PRs is a thousand of them. Something is wrong with
      // the config, not with the repo, and paging forever would hide it.
      if (page > 10) {
        process.stderr.write(`[oj] stopped paging ${path} at 1000 items\n`);
        return results;
      }
    }
  }

  async listOpenPulls(owner: string, repo: string): Promise<PullRequest[]> {
    const raw = await this.#paged<RawPull>(
      `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc`,
    );
    return raw.map((entry) => toPullRequest(entry, `${owner}/${repo}`));
  }

  async getPull(owner: string, repo: string, number: number): Promise<PullRequest> {
    const raw = await this.#request<RawPull>('GET', `/repos/${owner}/${repo}/pulls/${number}`);
    return toPullRequest(raw, `${owner}/${repo}`);
  }

  /** Returns the comment's URL, which the worker is told so it can refer to it. */
  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<string> {
    const created = await this.#request<{ html_url?: string }>(
      'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body },
    );
    return created?.html_url ?? '';
  }

  async createIssue(owner: string, repo: string, title: string, body: string): Promise<string> {
    const created = await this.#request<{ html_url?: string }>(
      'POST',
      `/repos/${owner}/${repo}/issues`,
      { title, body },
    );
    return created?.html_url ?? '';
  }

  /** Issue comments on a PR, oldest first. What `oj comments` prints. */
  async listIssueComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Array<{ author: string; createdAt: string; body: string }>> {
    const raw = await this.#paged<{
      user?: { login?: string } | null;
      created_at?: string;
      body?: string | null;
    }>(`/repos/${owner}/${repo}/issues/${number}/comments`);
    return raw.map((entry) => ({
      author: entry.user?.login ?? '(unknown)',
      createdAt: entry.created_at ?? '',
      body: entry.body ?? '',
    }));
  }

  /** The files a PR touches. What `oj pr` prints under "changed files". */
  async listPullFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Array<{ filename: string; status: string; additions: number; deletions: number }>> {
    const raw = await this.#paged<{
      filename?: string;
      status?: string;
      additions?: number;
      deletions?: number;
    }>(`/repos/${owner}/${repo}/pulls/${number}/files`);
    return raw.map((entry) => ({
      filename: entry.filename ?? '',
      status: entry.status ?? 'modified',
      additions: entry.additions ?? 0,
      deletions: entry.deletions ?? 0,
    }));
  }

  async removeLabel(owner: string, repo: string, number: number, label: string): Promise<void> {
    try {
      await this.#request(
        'DELETE',
        `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return;
      throw error;
    }
  }

  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.#request('POST', `/repos/${owner}/${repo}/issues/${number}/labels`, { labels });
  }

  async createReview(
    owner: string,
    repo: string,
    number: number,
    event: ReviewEvent,
    body: string,
    commitId?: string,
  ): Promise<void> {
    await this.#request('POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      event,
      body,
      ...(commitId ? { commit_id: commitId } : {}),
    });
  }

  async whoAmI(): Promise<string> {
    if (this.auth.describe().startsWith('GitHub App')) {
      const jwt = this.auth.appJwt?.() ?? null;
      if (!jwt) return '';
      const response = await fetch(`${this.apiBaseUrl}/app`, {
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'oj-review-bot',
        },
      });
      if (!response.ok) {
        throw new GitHubError(response.status, 'GET', '/app', await response.text());
      }
      const app = (await response.json()) as { slug?: string };
      return app.slug ? `${app.slug}[bot]` : '';
    }
    const user = await this.#request<{ login?: string }>('GET', '/user');
    return user.login ?? '';
  }
}

function rateLimitWaitMs(response: Response): number | null {
  if (response.status !== 403 && response.status !== 429) return null;

  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now());
  }

  if (response.status === 429) return 60_000;

  // A 403 with budget left is a permissions problem wearing a similar status
  // code. Do not sleep on it — surface it, so the missing scope gets fixed.
  return null;
}
