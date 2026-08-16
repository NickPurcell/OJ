/**
 * The desk: how a worker with no credential gets something onto GitHub.
 *
 * ── The failure that motivated this ──────────────────────────────────────
 *
 * Until 2026-08-11 the entire output of a review round was one file. The worker
 * had to write `oj/report.json`, at an exact path, in an exact schema, or the
 * round was thrown away as `no-report`. That failed twice in production and
 * cost hours each time: on 2026-08-10 the permission rules removed the Write
 * tool from the session entirely, so a worker that had finished a sixteen-minute
 * review had no way to hand it over — and exited 0, because from its own side
 * nothing had gone wrong. The review existed, in a transcript, and was lost.
 *
 * The lesson was not "fix the permission rule". It was that a single
 * write-it-perfectly-or-lose-everything handoff is a bad contract to give an
 * agent, because it fails silently, it fails at the end, and the agent cannot
 * see that it failed. So the worker now gets tooling instead of a schema: an
 * `oj` CLI on its PATH which posts its findings, and its errors, itself. Every
 * invocation returns a result the agent can read and react to.
 *
 * ── Why a directory of files and not a tool ──────────────────────────────
 *
 * The worker is a Claude Code process spawned by OJO with an environment built
 * from an allowlist that deliberately contains no credential (see `workerEnv`
 * in worker.ts). There is exactly one channel back to OJO that does not involve
 * giving the worker something: the filesystem. So `oj` writes a small JSON file
 * into `<workerDir>/desk/requests`, OJO drains that directory every half second
 * *while the session is still running*, performs the GitHub call itself, and
 * writes the answer to `<workerDir>/desk/results`. `oj` blocks until the answer
 * appears and then exits 0 or non-zero.
 *
 * This is the mechanism the sibling Clawcius project already uses between a
 * sandboxed session and its privileged executor (`<workDir>/unit-requests` →
 * `unit-results`), with the same defences: implausible file names discarded
 * unread, size checked on the descriptor rather than on the path, `O_NOFOLLOW`
 * so a symlink cannot redirect a read, and the request unlinked BEFORE it is
 * acted on so a request that throws cannot come back on the next drain.
 *
 * ── The property that makes it safe ──────────────────────────────────────
 *
 * THE WORKER NEVER NAMES THE TARGET. It says "post this"; OJO already knows
 * which repository and which pull request it spawned this review for, because
 * it created the desk. A request that carries a repo, an owner, a PR number or
 * a URL is a *rejection*, not an override — there is no field to put one in,
 * and naming one by hand is refused with an explanation rather than ignored.
 *
 * This is the same reasoning as spool provenance in Clawcius: identity comes
 * from which desk the request arrived in, never from the request's contents. A
 * fully prompt-injected worker can therefore post noise onto the pull request
 * it was already reviewing, and open issues on the repository that pull request
 * is against, and reach nothing else. That is a bounded and visible amount of
 * damage, which is the most one can ask of a process whose whole job is reading
 * code written by a stranger.
 *
 * The honest limit, stated here rather than left for someone to discover: the
 * worker runs as the same OS user as OJO, so it could write a request file into
 * *another* pull request's desk by hand, bypassing `oj` entirely. Same-user
 * separation was never a boundary — README § Security model says so about HOME
 * already, and the answer is the same one: a separate user or a container.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';

/** What the worker concluded. Two values, because a third would need a policy. */
export type Verdict = 'blocking' | 'clean';

export const DESK_DIR = 'desk';

export function deskPaths(workerDir: string): {
  root: string;
  requests: string;
  results: string;
} {
  const root = join(workerDir, DESK_DIR);
  return { root, ...deskDirs(root) };
}

/**
 * The two halves of a desk, given its root.
 *
 * Split out because `oj` is handed the root and nothing else — it must not have
 * to know that a desk lives at `<workerDir>/desk`, or it would be one string
 * concatenation away from being able to construct another review's desk from a
 * worker directory it guessed.
 */
export function deskDirs(root: string): { requests: string; results: string } {
  return { requests: join(root, 'requests'), results: join(root, 'results') };
}

/** Largest request file read. A comment body is the big one; GitHub caps at 65536. */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** Longest body forwarded to GitHub, which rejects anything past its own limit. */
export const MAX_BODY_CHARS = 60_000;

/** Largest answer written back. `oj pr` on a thousand-file PR is the case. */
const MAX_RESULT_CHARS = 200_000;

/** Request file names the desk will even look at. Same rule as the Clawcius spool. */
const REQUEST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

export type DeskRequest =
  | { action: 'comment'; body: string }
  | { action: 'verdict'; verdict: Verdict }
  | { action: 'issue'; title: string; body: string }
  | { action: 'pr' }
  | { action: 'comments' };

export type DeskResult = {
  ok: boolean;
  action: string;
  /** One line for the agent and for the journal. Always says what happened, or why not. */
  detail: string;
  /** Payload for the read actions. Printed on stdout by `oj`. */
  data?: string;
};

/**
 * Field names that mean "and do it over there".
 *
 * Unknown fields are rejected anyway — see `parseDeskRequest` — so this list is
 * not the security boundary. It exists so the refusal *explains itself*: an
 * agent told "unknown field: repo" will try `repository`, then `slug`, then
 * three other spellings, and burn ten minutes discovering a rule nobody stated.
 * An agent told "the target is not yours to choose" stops.
 */
const ADDRESSING_KEYS = new Set([
  'repo',
  'repository',
  'owner',
  'org',
  'organization',
  'organisation',
  'slug',
  'pr',
  'prnumber',
  'pull',
  'pullnumber',
  'number',
  'issue',
  'issuenumber',
  'url',
  'htmlurl',
  'html_url',
  'link',
  'target',
  'remote',
  'host',
  'api',
  'apibaseurl',
  'token',
]);

export const ADDRESSING_REFUSAL =
  'a request may not name a repository, an owner, a pull request number, a URL or a ' +
  'credential. OJO already knows which pull request this review is for — it created ' +
  'this desk — and the target comes from that and from nothing you can write. ' +
  'Post to the pull request under review, or not at all.';

export type ParsedRequest = { ok: true; request: DeskRequest } | { ok: false; reason: string };

/**
 * Parse one request. Structural rejection, never repair.
 *
 * Every action has an exact set of fields. An unknown key is a rejection rather
 * than a logged curiosity, because there is no forward-compatibility story to
 * protect here: both ends of this protocol ship in the same commit.
 */
export function parseDeskRequest(body: string): ParsedRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, reason: `not JSON (${String(error)}); discarded whole` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'a desk request must be a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const named = Object.keys(record).filter((key) => ADDRESSING_KEYS.has(key.toLowerCase()));
  if (named.length > 0) {
    return { ok: false, reason: `refused — ${named.join(', ')}: ${ADDRESSING_REFUSAL}` };
  }

  const action = record['action'];
  const allowed: Record<string, string[]> = {
    comment: ['action', 'body'],
    verdict: ['action', 'verdict'],
    issue: ['action', 'title', 'body'],
    pr: ['action'],
    comments: ['action'],
  };
  if (typeof action !== 'string' || allowed[action] === undefined) {
    return {
      ok: false,
      reason:
        `"action" must be one of ${Object.keys(allowed).join(', ')}, not ` +
        `${JSON.stringify(action)}`,
    };
  }
  const permitted = allowed[action] as string[];
  const extra = Object.keys(record).filter((key) => !permitted.includes(key));
  if (extra.length > 0) {
    return {
      ok: false,
      reason: `unknown field(s) for ${action}: ${extra.join(', ')}. Permitted: ${permitted.join(', ')}`,
    };
  }

  if (action === 'pr') return { ok: true, request: { action: 'pr' } };
  if (action === 'comments') return { ok: true, request: { action: 'comments' } };

  if (action === 'verdict') {
    const verdict = record['verdict'];
    if (verdict !== 'blocking' && verdict !== 'clean') {
      return {
        ok: false,
        reason: `"verdict" must be "blocking" or "clean", not ${JSON.stringify(verdict)}`,
      };
    }
    return { ok: true, request: { action: 'verdict', verdict } };
  }

  const body_ = record['body'];
  if (typeof body_ !== 'string' || body_.trim().length === 0) {
    return { ok: false, reason: `"body" must be a non-empty string for ${action}` };
  }
  if (action === 'comment') {
    return { ok: true, request: { action: 'comment', body: clipBody(body_) } };
  }

  const title = record['title'];
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, reason: '"title" must be a non-empty string for an issue' };
  }
  return {
    ok: true,
    request: { action: 'issue', title: title.trim().slice(0, 250), body: clipBody(body_) },
  };
}

/** Exported because `worker.ts` posts a recovered review without going through a request. */
export function clipBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n<sub>…truncated by OJO at ${MAX_BODY_CHARS} characters.</sub>`;
}

// ── The GitHub side of the desk ──────────────────────────────────────────────

/**
 * The four things a desk can ask GitHub for.
 *
 * An interface rather than a `GitHubClient` because the target is baked into
 * the implementation: `index.ts` closes over the owner, repo and PR number when
 * it builds one of these, which is *why* the request cannot name them. It also
 * means the desk is testable without a network — see test/desk.test.ts.
 */
export type DeskGateway = {
  postComment(body: string): Promise<string>;
  openIssue(title: string, body: string): Promise<string>;
  describePull(): Promise<string>;
  listComments(): Promise<string>;
};

export type DeskOptions = {
  workerDir: string;
  gateway: DeskGateway;
  /** Appended to every comment before it is posted. OJO's words, not the worker's. */
  footer: string;
  /** Ceiling on comments in one round. An injected worker should not be able to flood. */
  maxComments: number;
  /** Ceiling on issues in one round. Same reason, and issues are harder to clean up. */
  maxIssues: number;
  onLog: (line: string) => void;
};

/**
 * What one round's worker actually did. This is the round's output now — the
 * comment IS the report.
 */
export type DeskLedger = {
  comments: string[];
  issues: Array<{ title: string; url: string }>;
  verdict: Verdict | null;
  /** Requests that were refused, for the journal and for the failure comment. */
  refusals: string[];
};

export class Desk {
  readonly #options: DeskOptions;
  readonly #ledger: DeskLedger = { comments: [], issues: [], verdict: null, refusals: [] };
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #queued: Promise<void> | null = null;

  constructor(options: DeskOptions) {
    this.#options = options;
    const paths = deskPaths(options.workerDir);
    // 0700: the desk is the worker's inbox and outbox, and nothing else on the
    // host has any business in it.
    for (const dir of [paths.root, paths.requests, paths.results]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // A result left over from the previous round would be read by `oj` as the
    // answer to a request it has not made yet — the ids are random, so this is
    // near-impossible rather than impossible, and clearing costs nothing.
    for (const dir of [paths.requests, paths.results]) {
      for (const name of safeReaddir(dir)) discard(join(dir, name));
    }
  }

  get ledger(): DeskLedger {
    return this.#ledger;
  }

  /** Serve the desk while the session runs. Half a second is imperceptible to an agent. */
  start(intervalMs = 500): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.drain();
    }, intervalMs);
    this.#timer.unref();
  }

  /** Stop serving, after one last drain for whatever was written on the way out. */
  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.drain();
  }

  /**
   * Read every pending request, act on it, write the answer back.
   *
   * Serialised against itself, though NOT for the reason this comment gave until
   * 2026-08-16. It said two overlapping passes would post the same request
   * twice; they would not, and crediting the wrong mechanism is how the right
   * one gets removed by someone tidying up. What prevents the double post is
   * that `#drainOnce` reads and unlinks each request synchronously, before its
   * first `await`, so a second pass cannot list a file the first still holds.
   * Serialisation buys ordering — a comment and the verdict that follows it go
   * to GitHub in the order the worker wrote them — and it keeps one slow,
   * rate-limited call from being joined by five more.
   *
   * AWAITING THIS MEANS EVERYTHING ON DISK HAS BEEN SERVED. Until 2026-08-16 a
   * re-entrant call returned immediately, which made it mutual exclusion wearing
   * a barrier's clothes: `stop()` awaits `drain()`, so a pass already in flight
   * — a comment held up by a rate-limited POST, say — meant `stop()` cleared the
   * timer and returned having drained nothing, and the caller then read a ledger
   * that was missing a comment it went on to conclude had never been posted.
   * Short-circuiting was wrong even for a pass in flight, because that pass may
   * have listed the directory before the caller's request file existed.
   *
   * So a caller that arrives mid-pass waits for a fresh pass afterwards, and at
   * most one such pass is ever queued: the half-second timer must not be able to
   * stack up hundreds of listings behind one slow GitHub call.
   */
  drain(): Promise<void> {
    // Both fields, not just `#running`. `#pass()` nulls `#running` in a `.finally`
    // one microtask before its promise resolves, so a continuation awaiting that
    // promise — `runReview` doing `await desk.drain()` and falling straight into
    // `desk.stop()` — arrives in a window where a queued pass is still scheduled
    // and cannot be unscheduled. Keyed on `#running` alone, both then ran.
    if (this.#running === null && this.#queued === null) return this.#pass();
    // A pass is already scheduled and will list the directory after this call.
    if (this.#queued !== null) return this.#queued;
    this.#queued = (this.#running as Promise<void>).then(
      () => this.#pass(),
      () => this.#pass(),
    );
    return this.#queued;
  }

  #pass(): Promise<void> {
    this.#queued = null;
    const pass = this.#drainOnce().finally(() => {
      if (this.#running === pass) this.#running = null;
    });
    this.#running = pass;
    return pass;
  }

  async #drainOnce(): Promise<void> {
    const paths = deskPaths(this.#options.workerDir);
    const problem = realDirectoryProblem(paths.requests);
    if (problem) {
      if (problem !== 'does not exist') {
        this.#options.onLog(`desk request directory: ${problem}; not drained`);
      }
      return;
    }
    // Sorted so requests are served in the order `oj` created them: the names
    // start with a millisecond timestamp, and an agent that posts a comment
    // and then a verdict means them in that order.
    for (const name of safeReaddir(paths.requests).sort()) {
      const path = join(paths.requests, name);
      if (!REQUEST_NAME_PATTERN.test(name)) {
        this.#options.onLog(`${name}: implausible desk request name, discarded unread`);
        discard(path);
        continue;
      }
      const body = readSmallFile(path, MAX_REQUEST_BYTES, this.#options.onLog);
      // Unlinked before it is acted on. A request that throws must not be
      // retried forever, least of all one that opens an issue.
      discard(path);
      if (body === null) continue;

      const parsed = parseDeskRequest(body);
      const result = parsed.ok
        ? await this.#perform(parsed.request)
        : { ok: false, action: 'unknown', detail: parsed.reason };
      if (!result.ok) this.#ledger.refusals.push(`${result.action}: ${result.detail}`);
      this.#options.onLog(`oj ${result.action}: ${result.ok ? '' : 'REFUSED — '}${result.detail}`);
      writeResult(paths.results, name, result, this.#options.onLog);
    }
  }

  async #perform(request: DeskRequest): Promise<DeskResult> {
    const { gateway, maxComments, maxIssues } = this.#options;
    try {
      switch (request.action) {
        case 'comment': {
          if (this.#ledger.comments.length >= maxComments) {
            return {
              ok: false,
              action: 'comment',
              detail:
                `this round has already posted ${maxComments} comments, which is the ceiling ` +
                '(`review.maxCommentsPerRound`). Put the rest in one of them.',
            };
          }
          const url = await gateway.postComment(
            `${request.body.trimEnd()}\n\n${this.#options.footer}`,
          );
          this.#ledger.comments.push(url);
          return { ok: true, action: 'comment', detail: `posted ${url}` };
        }
        case 'verdict': {
          const previous = this.#ledger.verdict;
          this.#ledger.verdict = request.verdict;
          return {
            ok: true,
            action: 'verdict',
            detail:
              `verdict recorded as ${request.verdict}` +
              (previous && previous !== request.verdict ? ` (was ${previous})` : ''),
          };
        }
        case 'issue': {
          if (this.#ledger.issues.length >= maxIssues) {
            return {
              ok: false,
              action: 'issue',
              detail:
                `this round has already opened ${maxIssues} issues, which is the ceiling ` +
                '(`review.maxIssuesPerRound`). Mention the rest in your review comment instead.',
            };
          }
          const url = await gateway.openIssue(request.title, request.body);
          this.#ledger.issues.push({ title: request.title, url });
          return { ok: true, action: 'issue', detail: `opened ${url}` };
        }
        case 'pr': {
          const data = await gateway.describePull();
          return { ok: true, action: 'pr', detail: 'pull request metadata follows', data };
        }
        case 'comments': {
          const data = await gateway.listComments();
          return { ok: true, action: 'comments', detail: 'existing comments follow', data };
        }
      }
    } catch (error) {
      // The agent is told, in the same breath, so it can say so in its comment
      // rather than assuming the post landed. That is the whole point of this
      // being a call with a return value instead of a file it drops and hopes.
      return {
        ok: false,
        action: request.action,
        detail: `GitHub rejected it: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

// ── Filesystem plumbing, defensive in the same places Clawcius is ────────────

/**
 * Write a file the other side may be watching, atomically.
 *
 * Both directions use this. Without the rename, a drain can list a request that
 * is half-written and reject it as malformed JSON — a race that would show up
 * once a week and look like a model error.
 */
export function writeAtomic(path: string, content: string, mode = 0o600): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

function writeResult(
  resultDir: string,
  name: string,
  result: DeskResult,
  onLog: (line: string) => void,
): void {
  if (realDirectoryProblem(resultDir)) return;
  const payload: DeskResult = {
    ok: result.ok,
    action: result.action,
    detail: result.detail,
    ...(result.data === undefined ? {} : { data: result.data.slice(0, MAX_RESULT_CHARS) }),
  };
  try {
    writeAtomic(join(resultDir, name), `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    // Best effort: the GitHub call already happened and is already in the
    // journal. Losing the reply means `oj` times out, which is visible.
    onLog(`could not write the desk result for ${name}: ${String(error)}`);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.endsWith('.tmp'));
  } catch {
    return [];
  }
}

function readSmallFile(path: string, cap: number, onLog: (line: string) => void): string | null {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink here is not a request, it is an attempt to make the
    // desk read something else (CWE-59). Refused rather than followed.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    onLog(`${path}: could not open as a plain file (${String(error)}), discarded`);
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      onLog(`${path}: not a regular file, discarded unread`);
      return null;
    }
    // Checked on the descriptor, not on the path: the file could be replaced
    // between the two, and the descriptor is the thing about to be read.
    if (stat.size > cap) {
      onLog(`${path}: ${stat.size} bytes exceeds the ${cap}-byte cap, discarded unread`);
      return null;
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    onLog(`${path}: could not read (${String(error)})`);
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[oj] could not remove ${path}: ${String(error)}\n`);
    }
  }
}

function describe(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'a symlink';
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFIFO()) return 'a FIFO';
  if (stat.isSocket()) return 'a socket';
  return 'not a regular file';
}

/** '' if this is a real directory; otherwise what it is instead. */
function realDirectoryProblem(path: string): string {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return 'does not exist';
  }
  if (stat.isSymbolicLink()) {
    return 'it is a symlink, which is refused rather than followed (CWE-59)';
  }
  if (!stat.isDirectory()) return `it is ${describe(stat)}`;
  return '';
}
