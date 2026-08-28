
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

export function deskDirs(root: string): { requests: string; results: string } {
  return { requests: join(root, 'requests'), results: join(root, 'results') };
}

/** Largest request file read. A comment body is the big one; GitHub caps at 65536. */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** Longest body forwarded to GitHub, which rejects anything past its own limit. */
export const MAX_BODY_CHARS = 60_000;

/** Largest answer written back. `oj pr` on a thousand-file PR is the case. */
const MAX_RESULT_CHARS = 200_000;

/** Request file names the desk will even look at. */
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
  detail: string;
  /** Payload for the read actions. Printed on stdout by `oj`. */
  data?: string;
};

/** Field names that mean "and do it over there". */
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

export function clipBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n<sub>…truncated by OJO at ${MAX_BODY_CHARS} characters.</sub>`;
}

// ── The GitHub side of the desk ──────────────────────────────────────────────

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
  /** Written when a comment lands; the worker's Stop hook checks for it. */
  postedMarker: string;
  maxComments: number;
  maxIssues: number;
  onLog: (line: string) => void;
};

export type DeskLedger = {
  comments: string[];
  issues: Array<{ title: string; url: string }>;
  verdict: Verdict | null;
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

  drain(): Promise<void> {
    // Both fields, not just `#running`.
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
          writeFileSync(this.#options.postedMarker, `${url}\n`);
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
      // The agent is told in the same breath, so it can say so in its comment
      // rather than assuming the post landed.
      return {
        ok: false,
        action: request.action,
        detail: `GitHub rejected it: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

// ── Filesystem plumbing ──────────────────────────────────────────────────────

/** Write a file the other side may be watching, atomically. */
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
