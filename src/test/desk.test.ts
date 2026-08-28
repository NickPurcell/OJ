
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  Desk,
  deskPaths,
  parseDeskRequest,
  writeAtomic,
  type DeskGateway,
  type DeskResult,
} from '../desk.js';

const temporaries: string[] = [];
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oj-desk-'));
  temporaries.push(dir);
  return dir;
}

/** A gateway that records instead of posting. */
function fixture(overrides: Partial<DeskGateway> = {}): DeskGateway & {
  comments: string[];
  issues: Array<{ title: string; body: string }>;
} {
  const comments: string[] = [];
  const issues: Array<{ title: string; body: string }> = [];
  return {
    comments,
    issues,
    async postComment(body) {
      comments.push(body);
      return `https://github.test/pr/1#issuecomment-${comments.length}`;
    },
    async openIssue(title, body) {
      issues.push({ title, body });
      return `https://github.test/issues/${issues.length}`;
    },
    async describePull() {
      return 'pull request: #1 — a change';
    },
    async listComments() {
      return 'No comments on this pull request yet.';
    },
    ...overrides,
  };
}

function deskFor(workerDir: string, gateway: DeskGateway, caps: { comments?: number; issues?: number } = {}): Desk {
  return new Desk({
    workerDir,
    postedMarker: join(workerDir, 'posted'),
    gateway,
    footer: '<sub>OJ · round 1</sub>',
    maxComments: caps.comments ?? 10,
    maxIssues: caps.issues ?? 5,
    onLog: () => {},
  });
}

/** Stand in for `oj`: drop a request where the CLI would. */
function submit(workerDir: string, request: unknown, name = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`): string {
  writeAtomic(join(deskPaths(workerDir).requests, name), JSON.stringify(request));
  return name;
}

function result(workerDir: string, name: string): DeskResult {
  return JSON.parse(readFileSync(join(deskPaths(workerDir).results, name), 'utf8')) as DeskResult;
}

describe('the desk round trip', () => {
  it('performs a comment and hands back where it landed', async () => {
    const dir = workspace();
    const gateway = fixture();
    const desk = deskFor(dir, gateway);

    const name = submit(dir, { action: 'comment', body: 'Two blocking findings.' });
    await desk.drain();

    assert.equal(gateway.comments.length, 1);
    // OJO's footer is appended by OJO, at post time, to the worker's own text.
    assert.ok(gateway.comments[0]?.startsWith('Two blocking findings.'));
    assert.ok(gateway.comments[0]?.includes('<sub>OJ · round 1</sub>'));

    const answer = result(dir, name);
    assert.equal(answer.ok, true);
    assert.match(answer.detail, /posted https:\/\/github\.test/);
    assert.deepEqual(desk.ledger.comments, ['https://github.test/pr/1#issuecomment-1']);
  });

  it('tells the worker when GitHub refuses, rather than swallowing it', async () => {
    const dir = workspace();
    const desk = deskFor(
      dir,
      fixture({
        async postComment() {
          throw new Error('GitHub POST /issues/1/comments → 403: archived repository');
        },
      }),
    );

    const name = submit(dir, { action: 'comment', body: 'anything' });
    await desk.drain();

    const answer = result(dir, name);
    assert.equal(answer.ok, false);
    assert.match(answer.detail, /archived repository/);
    assert.equal(desk.ledger.comments.length, 0);
    assert.equal(desk.ledger.refusals.length, 1);
  });

  it('acts on a request exactly once, even if the drain is re-entered', async () => {
    const dir = workspace();
    const gateway = fixture();
    const desk = deskFor(dir, gateway);

    submit(dir, { action: 'comment', body: 'once' });
    await Promise.all([desk.drain(), desk.drain(), desk.drain()]);
    await desk.drain();

    assert.equal(gateway.comments.length, 1);
  });

  it('awaiting a drain means everything on disk has been served', async () => {
    const dir = workspace();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = fixture({
      async postComment(body) {
        await held;
        return `https://github.test/pr/1#issuecomment-${body.length}`;
      },
    });
    const desk = deskFor(dir, gateway);

    submit(dir, { action: 'comment', body: 'first' });
    const slow = desk.drain();
    // Arrives while the first pass is stuck inside GitHub, and writes a request
    // that pass had already looked past.
    submit(dir, { action: 'verdict', verdict: 'clean' });
    const barrier = desk.stop();
    release();
    await Promise.all([slow, barrier]);

    assert.equal(desk.ledger.comments.length, 1);
    assert.equal(desk.ledger.verdict, 'clean');
  });

  it('does not stack a pass per timer tick behind one slow call', async () => {
    const dir = workspace();
    let calls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = fixture({
      async postComment(body) {
        calls += 1;
        await held;
        return `https://github.test/pr/1#issuecomment-${body.length}`;
      },
    });
    const desk = deskFor(dir, gateway);

    submit(dir, { action: 'comment', body: 'first' });
    const first = desk.drain();
    // Ten callers arriving mid-pass share one queued pass between them: the
    // half-second timer must not be able to queue a listing per tick.
    const waiting = Array.from({ length: 10 }, () => desk.drain());
    assert.equal(new Set(waiting).size, 1);
    release();
    await Promise.all([first, ...waiting]);

    assert.equal(calls, 1);
  });

  it('never runs two passes at once, even from the microtask after a pass', async () => {
    const dir = workspace();
    let inside = 0;
    let most = 0;
    let served = 0;
    const gateway = fixture({
      async postComment(body) {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inside -= 1;
        served += 1;
        return `https://github.test/pr/1#issuecomment-${body.length}`;
      },
    });
    const desk = deskFor(dir, gateway);

    submit(dir, { action: 'comment', body: 'one' });
    const first = desk.drain();
    // Registered on the first pass before the queued continuation exists, so it runs first.
    const sneak = first.then(() => desk.drain());
    const queued = desk.drain();
    // Written while the first pass is inside GitHub, so both later passes have
    // something to find.
    submit(dir, { action: 'comment', body: 'two' });
    submit(dir, { action: 'comment', body: 'three' });

    await Promise.all([first, sneak, queued, desk.stop()]);

    assert.equal(most, 1, 'two passes were inside the desk at once');
    assert.equal(served, 3, 'every request written during the pass was served');
  });

  it('discards a request whose name it would not have written', async () => {
    const dir = workspace();
    const gateway = fixture();
    const desk = deskFor(dir, gateway);

    writeFileSync(
      join(deskPaths(dir).requests, 'not a request'),
      JSON.stringify({ action: 'comment', body: 'sneaked in' }),
    );
    await desk.drain();

    assert.equal(gateway.comments.length, 0);
  });
});

describe('the target is never the request’s to choose', () => {
  // The property the whole design rests on: identity comes from which desk the
  // request arrived in. A request that names a target is a rejection, not an
  // override, and the refusal says so rather than reading as a schema quibble.
  for (const named of [
    { action: 'comment', body: 'hi', repo: 'someone/else' },
    { action: 'comment', body: 'hi', owner: 'someone' },
    { action: 'comment', body: 'hi', pr: 4 },
    { action: 'comment', body: 'hi', prNumber: 4 },
    { action: 'comment', body: 'hi', number: 4 },
    { action: 'comment', body: 'hi', url: 'https://github.com/someone/else/pull/4' },
    { action: 'issue', title: 't', body: 'b', repository: 'someone/else' },
    { action: 'comment', body: 'hi', token: 'ghp_x' },
    { action: 'comment', body: 'hi', REPO: 'someone/else' },
  ]) {
    it(`refuses ${JSON.stringify(named).slice(0, 60)}`, () => {
      const parsed = parseDeskRequest(JSON.stringify(named));
      assert.equal(parsed.ok, false);
      assert.match(parsed.ok ? '' : parsed.reason, /may not name a repository/);
    });
  }

  it('refuses an unknown field rather than ignoring it', () => {
    const parsed = parseDeskRequest(JSON.stringify({ action: 'comment', body: 'hi', asUser: 'root' }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /unknown field\(s\) for comment: asUser/);
  });

  it('refuses anything that is not one of the five actions', () => {
    for (const body of ['{"action":"merge"}', '{"action":42}', '[]', 'not json', '{}']) {
      assert.equal(parseDeskRequest(body).ok, false);
    }
  });

});

describe('the caps', () => {
  it('stops opening issues at the ceiling and says why', async () => {
    const dir = workspace();
    const gateway = fixture();
    const desk = deskFor(dir, gateway, { issues: 2 });

    const names = [1, 2, 3, 4].map((n) =>
      submit(dir, { action: 'issue', title: `bug ${n}`, body: 'out of scope' }, `100${n}-x.json`),
    );
    await desk.drain();

    assert.equal(gateway.issues.length, 2);
    assert.equal(desk.ledger.issues.length, 2);
    assert.equal(result(dir, names[0] as string).ok, true);
    assert.equal(result(dir, names[2] as string).ok, false);
    assert.match(result(dir, names[3] as string).detail, /already opened 2 issues/);
  });

  it('stops posting comments at the ceiling', async () => {
    const dir = workspace();
    const gateway = fixture();
    const desk = deskFor(dir, gateway, { comments: 1 });

    submit(dir, { action: 'comment', body: 'one' }, '1001-a.json');
    submit(dir, { action: 'comment', body: 'two' }, '1002-b.json');
    await desk.drain();

    assert.equal(gateway.comments.length, 1);
    assert.equal(desk.ledger.refusals.length, 1);
  });
});
