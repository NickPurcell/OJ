/**
 * `oj` — the review worker's only channel to GitHub.
 *
 * This file runs *inside* the worker: same OS user, no credential, reading a
 * repository written by whoever opened the pull request. It therefore does
 * exactly one thing that could be called privileged, and it does it by asking:
 * it writes a small JSON file into the desk directory OJO created for this
 * review, waits for OJO to write an answer back, prints it and exits.
 *
 * Two consequences worth stating, because both are load-bearing.
 *
 * IT HOLDS NO CREDENTIAL. There is no token in this process, in its
 * environment, or in any file it reads. `oj` cannot talk to GitHub; OJO can,
 * and does, on its behalf. Nothing here needs auditing for leaks because there
 * is nothing to leak.
 *
 * IT CANNOT NAME A TARGET. There is no `--repo`, no `--pr`, no URL argument,
 * and passing something that looks like one is a refusal with an explanation
 * rather than an unrecognised flag. The desk this process writes to *is* the
 * addressing: OJO knows which pull request it created that desk for. See
 * `desk.ts` for why identity comes from the channel and never from the message.
 *
 * `oj` blocks until the answer arrives and exits non-zero when the operation
 * failed, so the agent can react — say so in its review, retry, or fall back —
 * instead of discovering after the fact that its work went nowhere. That is the
 * whole reason this replaced `oj/report.json`, which could fail silently, at the
 * end, in a way the agent had no way to see.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deskDirs, MAX_BODY_CHARS, writeAtomic, type DeskResult } from './desk.js';

/**
 * How long `oj` waits for OJO before giving up.
 *
 * Generous: OJO drains twice a second, but a GitHub call underneath can sit out
 * a rate limit for minutes, and the worst outcome is an agent that concludes
 * its comment was lost and posts it twice. Shorter than the round timeout so
 * that a dead OJO surfaces as a failed command rather than a hung session.
 */
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 200;

const USAGE = `oj — post the findings of this review. OJO performs the GitHub call; you have no credential.

  oj comment [--file PATH]        post a comment on the pull request under review
  oj verdict <blocking|clean>     record this round's verdict
  oj issue --title T [--file P]   open an issue on the repository under review
  oj pr                           print this pull request's metadata
  oj comments                     print the comments already on this pull request

Bodies are read from stdin unless --file is given. Every command blocks until
OJO has done the thing and exits non-zero if it did not.

You cannot choose the repository, the pull request or the URL: OJO already knows
which review this is, and a request that names a target is refused.`;

/** Argument shapes that mean "and do it over there". Refused by name, like the desk's. */
const ADDRESSING_FLAGS =
  /^--?(repo|repository|owner|org|slug|pr|pull|number|issue|url|link|target|remote|host|api|token)(=|$)/i;

function fail(message: string, code = 1): never {
  process.stderr.write(`oj: ${message}\n`);
  process.exit(code);
}

function readStdin(): string {
  // A terminal on stdin means nobody piped anything in, and reading it would
  // block forever waiting for a human who — by construction — is not there.
  if (process.stdin.isTTY) {
    fail('nothing on stdin. Pipe the body in, or pass --file PATH.', 2);
  }
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** `--file PATH` / `--file=PATH` / `--title T`. Everything else is an error. */
function takeOptions(argv: string[], known: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('-')) fail(`unexpected argument "${token}"\n\n${USAGE}`, 2);
    if (ADDRESSING_FLAGS.test(token)) {
      fail(
        `${token} is refused. OJO already knows which pull request this review is for — it ` +
          'spawned you for it — and the target is not something a review can choose. Post to ' +
          'the pull request under review, or not at all.',
        2,
      );
    }
    const [flag, inline] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];
    const name = flag.replace(/^--?/, '');
    if (!known.includes(name)) fail(`unknown option "${flag}"\n\n${USAGE}`, 2);
    const value = inline ?? argv[++i];
    if (value === undefined) fail(`${flag} needs a value`, 2);
    options[name] = value;
  }
  return options;
}

function bodyFrom(options: Record<string, string>): string {
  const path = options['file'];
  const body = path === undefined ? readStdin() : readFileOrFail(path);
  if (body.trim().length === 0) {
    fail(
      'the body is empty. Pass --file PATH, or pipe the text in — a comment with nothing in ' +
        'it is the same as saying nothing, and a round that says nothing is a failed round.',
    );
  }
  if (body.length > MAX_BODY_CHARS) {
    process.stderr.write(
      `oj: body is ${body.length} characters; OJO will truncate it at ${MAX_BODY_CHARS}.\n`,
    );
  }
  return body;
}

function readFileOrFail(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return fail(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Hand the request over and wait for the answer.
 *
 * The name carries a millisecond timestamp so the desk serves requests in the
 * order they were made, and random bytes so two `oj` calls in the same
 * millisecond cannot collide. Written with rename-into-place, because a drain
 * that lists a half-written file would reject it as malformed JSON.
 */
function submit(request: Record<string, unknown>): DeskResult {
  const deskRoot = process.env['OJ_DESK'];
  if (!deskRoot) {
    fail(
      'OJ_DESK is not set, so there is no desk to hand this to. `oj` only works inside a ' +
        'review session started by OJO.',
    );
  }
  const paths = deskDirs(deskRoot);
  if (!existsSync(paths.requests) || !existsSync(paths.results)) {
    fail(`the desk at ${deskRoot} is missing its requests/ or results/ directory.`);
  }

  const name = `${Date.now()}-${randomBytes(6).toString('hex')}.json`;
  const resultPath = join(paths.results, name);
  writeAtomic(join(paths.requests, name), `${JSON.stringify(request)}\n`);

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    if (existsSync(resultPath)) {
      const raw = readFileSync(resultPath, 'utf8');
      // Read once and remove: the desk never reuses a name, and leaving results
      // behind would turn the directory into a slow leak over a long review.
      rmSync(resultPath, { force: true });
      try {
        return JSON.parse(raw) as DeskResult;
      } catch {
        return { ok: false, action: 'unknown', detail: `OJO wrote an unreadable result: ${raw.slice(0, 200)}` };
      }
    }
    if (Date.now() > deadline) {
      return {
        ok: false,
        action: 'unknown',
        detail:
          `OJO did not answer within ${WAIT_TIMEOUT_MS / 60000} minutes. It may have been ` +
          'restarted, in which case this round is already over and nothing you post will land.',
      };
    }
    // Synchronous sleep. `oj` is a one-shot command whose entire job is to
    // block, and Atomics.wait is the only way to do that without an event loop.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      process.exit(command === undefined ? 2 : 0);
      break;

    case 'comment': {
      const options = takeOptions(rest, ['file']);
      report(submit({ action: 'comment', body: bodyFrom(options) }));
      break;
    }

    case 'verdict': {
      const [verdict, ...extra] = rest;
      if (verdict !== 'blocking' && verdict !== 'clean') {
        fail(`verdict must be "blocking" or "clean", not ${JSON.stringify(verdict ?? '')}`, 2);
      }
      if (extra.length > 0) fail(`unexpected argument "${extra[0]}"`, 2);
      report(submit({ action: 'verdict', verdict }));
      break;
    }

    case 'issue': {
      const options = takeOptions(rest, ['file', 'title']);
      const title = options['title'];
      if (title === undefined || title.trim().length === 0) {
        fail('an issue needs --title', 2);
      }
      report(submit({ action: 'issue', title, body: bodyFrom(options) }));
      break;
    }

    case 'pr':
    case 'comments': {
      if (rest.length > 0) takeOptions(rest, []);
      report(submit({ action: command }));
      break;
    }

    default:
      fail(`unknown command "${command}"\n\n${USAGE}`, 2);
  }
}

/**
 * Print the answer and exit accordingly.
 *
 * Payload on stdout, prose on stderr, so `oj pr > facts.md` is a file of facts
 * rather than a file of facts with a status line stapled to the end.
 */
function report(result: DeskResult): never {
  if (result.data !== undefined) process.stdout.write(result.data.endsWith('\n') ? result.data : `${result.data}\n`);
  process.stderr.write(`oj ${result.action}: ${result.ok ? '' : 'FAILED — '}${result.detail}\n`);
  process.exit(result.ok ? 0 : 1);
}

main();
