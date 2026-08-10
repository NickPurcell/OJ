/**
 * Every byte OJO exchanges with GitHub goes through this file.
 *
 * That concentration is the point rather than tidiness. The credential lives
 * here and nowhere else: it is never written into a clone's `.git/config`,
 * never placed in a worker's environment, and never passed on a command line
 * where another process on the host could read it out of `ps`. If you are
 * adding a feature that needs GitHub, add a method here — do not hand the
 * token to the thing that needs it.
 *
 * No SDK. `fetch` is in Node 22 and the API surface OJO uses is eight
 * endpoints, so a dependency would mostly buy us a rate-limiter we would still
 * have to understand. Understanding it is cheaper than trusting it.
 */

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

/**
 * A source of bearer tokens.
 *
 * Both implementations expose exactly this, so nothing downstream knows or
 * cares whether it is talking to an App installation or a PAT. That matters
 * for the quick-start path: someone who begins with a PAT and later creates
 * the App changes `.env` and restarts, and no other code moves.
 */
export interface GitHubAuth {
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

/**
 * GitHub App installation auth.
 *
 * Two credentials in a trench coat: a private key signs a short JWT proving
 * "I am this app", which buys an installation token proving "and I may act on
 * these repositories". Only the second one is ever sent to the REST API or
 * used for git.
 *
 * Installation tokens last an hour. We refresh at fifty minutes, because a
 * review round can easily run for twenty and a token that expires mid-round
 * fails at the worst possible moment — after the work is done, while posting.
 */
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

// ── The shapes OJO actually reads ────────────────────────────────────────────
// Deliberately partial. GitHub's PR object has ninety fields; naming the nine
// that matter documents what this service depends on, and makes an API change
// that removes one a type error rather than an `undefined` in a template.

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
  /** `owner/repo` of the head, for the review body. May be a fork. */
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

export type ReviewComment = {
  path: string;
  line: number;
  body: string;
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * The client. One per process; it holds the auth and the backoff state.
 */
export class GitHubClient {
  /**
   * Retries for transient failures. Not a general retry loop — 4xx other than
   * the rate-limit family is a bug or a permission problem, and retrying it
   * just makes the same mistake three times before reporting it.
   */
  static readonly #RETRY_DELAYS_MS = [1_000, 4_000, 12_000] as const;

  /**
   * Longest OJO will sit waiting for a rate limit to reset.
   *
   * Past this it gives up and lets the poll loop try again later. Blocking a
   * single-threaded poll loop for forty minutes would stall every other repo
   * and every cleanup sweep — the reset is not worth that, since nothing here
   * is urgent enough to justify going deaf.
   */
  static readonly #MAX_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

  constructor(
    private readonly auth: GitHubAuth,
    private readonly apiBaseUrl: string,
  ) {}

  describeAuth(): string {
    return this.auth.describe();
  }

  /**
   * A token for git operations, handed out only to `worker.ts`'s fetch step.
   *
   * It is exposed rather than used there because cloning is git's job, not
   * fetch's. See `worker.ts` for how it reaches git without being written to
   * disk or to a command line.
   */
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
        // Both flavours land here: the primary hourly budget (403/429 with
        // x-ratelimit-remaining: 0) and the secondary abuse limits (Retry-After
        // on writes made too quickly). They want the same response — wait
        // exactly as long as GitHub says and no longer.
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
        // A rate-limit wait is not a retry attempt: it is the same request,
        // deferred. Charging it against the budget would mean three sleeps and
        // then a failure, when the first sleep was all that was needed.
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

  /** Follows `Link: rel="next"` until exhausted. */
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

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    await this.#request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  /**
   * Remove the trigger label.
   *
   * A 404 is success: the label was already gone, which happens when a human
   * removes it in the second between OJO listing the PR and acting on it.
   * Treating that as an error would fail a review that is about to work fine.
   */
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

  /**
   * Post a review.
   *
   * `comments` is best effort by contract: GitHub validates every inline
   * comment against the diff and rejects the *entire* review with a 422 if one
   * line is not in it, which would throw away a finished review over a
   * misremembered line number. So a 422 retries once with the comments
   * dropped, and the caller is told they were dropped so the body can carry
   * the locations instead.
   *
   * Returns whether the inline comments survived.
   */
  async createReview(
    owner: string,
    repo: string,
    number: number,
    event: ReviewEvent,
    body: string,
    comments: ReviewComment[] = [],
    commitId?: string,
  ): Promise<{ inlineCommentsPosted: boolean }> {
    const path = `/repos/${owner}/${repo}/pulls/${number}/reviews`;
    const base = {
      event,
      body,
      // Pinning the review to the SHA that was actually reviewed is what keeps
      // a review from silently attaching to a commit pushed while it ran.
      ...(commitId ? { commit_id: commitId } : {}),
    };

    if (comments.length > 0) {
      try {
        await this.#request('POST', path, {
          ...base,
          comments: comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: 'RIGHT',
            body: comment.body,
          })),
        });
        return { inlineCommentsPosted: true };
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 422) throw error;
        process.stderr.write(
          `[oj] ${owner}/${repo}#${number}: inline comments rejected (${error.body.slice(0, 160)}) — ` +
            'reposting with locations in the body\n',
        );
      }
    }

    await this.#request('POST', path, base);
    return { inlineCommentsPosted: false };
  }

  /** The account OJO is acting as. Used to notice self-review, which GitHub forbids. */
  async whoAmI(): Promise<string> {
    if (this.auth.describe().startsWith('GitHub App')) {
      // Apps have no /user. The bot login is `<app slug>[bot]`, which /app
      // gives us without needing the installation.
      const app = await this.#request<{ slug?: string }>('GET', '/app');
      return app.slug ? `${app.slug}[bot]` : '';
    }
    const user = await this.#request<{ login?: string }>('GET', '/user');
    return user.login ?? '';
  }
}

/**
 * How long to wait, or null if this response is not a rate limit.
 *
 * Three signals, checked in the order GitHub documents them: `retry-after` on
 * secondary limits, `x-ratelimit-reset` when the primary budget is exhausted,
 * and a bare 429 with neither (treated as a minute, because something is
 * throttling us even if it will not say for how long).
 */
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
