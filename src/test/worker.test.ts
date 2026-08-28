/**
 * The two worker properties that must not drift.
 *
 * `workerEnv` is the credential boundary. It is an allowlist, and an allowlist
 * is only as good as the last person who edited it, so the assertion that no
 * variable reaching the worker contains the live GitHub token is checked here
 * rather than trusted to a code comment.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { OjConfig, RepoConfig } from '../config.js';
import { deskPaths } from '../desk.js';
import type { PullRequest } from '../github.js';
import {
  createStreamMonitor,
  installOjCli,
  kickoffValues,
  render,
  sessionIdFor,
  workerEnv,
  type CloneResult,
  type ReviewRequest,
} from '../worker.js';

const temporaries: string[] = [];
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function configWith(envPassthrough: string[]): OjConfig {
  // Only `worker.envPassthrough` is read by workerEnv; the rest of an OjConfig
  // is irrelevant to it and inventing a whole one would hide that.
  return { worker: { envPassthrough } } as unknown as OjConfig;
}

function withEnv<T>(overrides: Record<string, string>, body: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('workerEnv', () => {
  const token = 'ghs_liveTokenValue0123456789';

  it('does not pass GITHUB_TOKEN, whatever else is in the environment', () => {
    const env = withEnv({ GITHUB_TOKEN: token, GH_TOKEN: token, OJ_GITHUB_TOKEN: token }, () =>
      workerEnv(configWith([]), token, '/tmp/bin'),
    );

    assert.equal(env['GITHUB_TOKEN'], undefined);
    assert.equal(env['GH_TOKEN'], undefined);
    assert.equal(env['OJ_GITHUB_TOKEN'], undefined);
    for (const value of Object.values(env)) {
      assert.ok(!String(value).includes(token), 'no variable may carry the token');
    }
  });

  it('drops an allowlisted variable that happens to embed the token', () => {
    // The case the allowlist cannot catch by name: an operator passes through a
    // variable whose *value* is a git URL with the credential inlined.
    const env = withEnv(
      { GITHUB_TOKEN: token, OJ_TEST_MIRROR: `https://x-access-token:${token}@github.com/a/b.git` },
      () => workerEnv(configWith(['OJ_TEST_MIRROR']), token, '/tmp/bin'),
    );

    assert.equal(env['OJ_TEST_MIRROR'], undefined);
  });

  it('passes through what it was told to, when that is harmless', () => {
    const env = withEnv({ GITHUB_TOKEN: token, OJ_TEST_PLAIN: 'harmless' }, () =>
      workerEnv(configWith(['OJ_TEST_PLAIN']), token, '/tmp/bin'),
    );

    assert.equal(env['OJ_TEST_PLAIN'], 'harmless');
  });

  it('puts oj first on PATH and forbids a git credential prompt', () => {
    const env = withEnv({ GITHUB_TOKEN: token }, () => workerEnv(configWith([]), token, '/tmp/ojbin'));

    assert.ok(env['PATH']?.startsWith('/tmp/ojbin:'));
    assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(env['OJ_WORKER'], '1');
  });

  it('does not hand the worker its grandparent’s Claude Code session', () => {
    const env = withEnv(
      { GITHUB_TOKEN: token, CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDE_CONFIG_DIR: '/etc/claude' },
      () => workerEnv(configWith([]), token, '/tmp/bin'),
    );

    assert.equal(env['CLAUDE_CODE_SESSION_ID'], undefined);
    assert.equal(env['CLAUDE_CONFIG_DIR'], '/etc/claude');
  });
});

describe('installOjCli', () => {
  it('writes a shim that names this review’s desk and nothing else', () => {
    const workerDir = mkdtempSync(join(tmpdir(), 'oj-worker-'));
    temporaries.push(workerDir);

    const binDir = installOjCli(workerDir, join(workerDir, 'posted'));
    const script = readFileSync(join(binDir, 'oj'), 'utf8');

    assert.ok(existsSync(join(binDir, 'oj')));
    assert.ok(script.includes(`OJ_DESK='${deskPaths(workerDir).root}'`));
    // The desk is passed as an environment variable, not an argument: there is
    // no documented way to aim `oj` at another pull request's desk.
    assert.doesNotMatch(script, /--desk/);
  });
  it('writes a Stop hook that refuses once, then yields', () => {
    const workerDir = mkdtempSync(join(tmpdir(), 'oj-worker-'));
    temporaries.push(workerDir);
    const marker = join(workerDir, 'posted');
    const binDir = installOjCli(workerDir, marker);
    const hook = join(binDir, 'oj-stop-check');
    const run = (input: string): number => spawnSync('/bin/sh', [hook], { input }).status ?? -1;
    assert.equal(run('{"stop_hook_active":false}'), 2);
    assert.equal(run('{"stop_hook_active":true}'), 0);
    writeFileSync(marker, 'https://example.test/1\n');
    assert.equal(run('{"stop_hook_active":false}'), 0);
  });
});

describe('the shipped kickoff', () => {
  it('renders against exactly the values a round supplies', () => {
    // `render` refuses an unknown placeholder rather than passing `{{...}}`
    // through to the model as literal text. Catching that here is the
    // difference between a failed build and a review that reads as though the
    // reviewer has lost its place — which is how `{{reportPath}}` would have
    // surfaced if it had been left behind when the report was retired.
    const request = {
      repo: { slug: 'NickPurcell/OJ' } as RepoConfig,
      pull: {
        number: 7,
        title: 'a change',
        body: 'why',
        htmlUrl: 'https://github.test/pr/7',
        authorLogin: 'someone',
        baseRef: 'main',
        headRef: 'branch',
        headSha: 'abcdef1234',
        fromFork: false,
        headRepoSlug: 'NickPurcell/OJ',
      } as PullRequest,
      round: 1,
      config: { worker: { timeoutMinutes: 45 } },
    } as unknown as ReviewRequest;
    const clone: CloneResult = {
      repoDir: '/var/lib/oj/workers/x/repo',
      mergeBase: '0123456789',
      repoInstructions: null,
      strippedPaths: ['CLAUDE.md'],
    };

    // dist/test/worker.test.js → the repository root, so this does not depend
    // on which directory the tests were started from.
    const repoRoot = dirname(dirname(dirname(import.meta.filename)));
    const rendered = render(readFileSync(join(repoRoot, 'prompts', 'kickoff.md'), 'utf8'), kickoffValues(request, clone, '(measurements)'));

    assert.doesNotMatch(rendered, /\{\{[a-zA-Z]/, 'no placeholder may survive rendering');
    assert.match(rendered, /oj comment/, 'the worker must be told how to post its review');
    assert.doesNotMatch(rendered, /report\.json/, 'the report file is retired');
  });
});

describe('createStreamMonitor', () => {
  // The message shapes below were taken from a real `claude --output-format
  // stream-json --verbose` run rather than from documentation, including the
  // second `result` with an `origin` — which is what a subagent's completion
  // looks like, and what used to be reported as the round's total.
  function monitorOver(lines: unknown[]): { logged: string[]; totals: ReturnType<typeof createStreamMonitor>['totals'] } {
    const logged: string[] = [];
    const monitor = createStreamMonitor((line) => logged.push(line));
    for (const line of lines) monitor.handleLine(JSON.stringify(line));
    monitor.finish();
    return { logged, totals: monitor.totals };
  }

  const toolUse = (id: string, name: string, input: unknown): unknown => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
  const toolResult = (id: string, isError: boolean, content: unknown): unknown => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
  });

  it('logs what a Bash call ran, and that it came back', () => {
    const { logged } = monitorOver([
      toolUse('t1', 'Bash', { command: 'git -C /w/repo diff a..b', description: 'the diff' }),
      toolResult('t1', false, 'diff --git'),
    ]);

    assert.match(logged[0] ?? '', /tool 1 Bash started — git -C \/w\/repo diff a\.\.b/);
    assert.match(logged[1] ?? '', /tool 1 Bash ok in \d/);
  });

  it('shows a refused call as a failure, which used to be invisible', () => {
    // The exact case: a denied tool call arrives as a tool_result with
    // is_error, and the old log printed `tool Bash` for it and nothing more.
    const { logged } = monitorOver([
      toolUse('t1', 'Bash', { command: 'git push origin HEAD' }),
      toolResult('t1', true, [{ type: 'text', text: 'This command requires approval' }]),
    ]);

    assert.match(logged[1] ?? '', /tool 1 Bash FAILED in .* — This command requires approval/);
  });

  it('names the call a round went silent inside', () => {
    const { logged } = monitorOver([
      toolUse('t1', 'Bash', { command: 'ugrep -a -o -E .{0,60}' }),
      toolUse('t2', 'Write', { file_path: '/w/review.md', content: 'secret contents' }),
      toolResult('t2', false, 'ok'),
    ]);

    const summary = logged.find((line) => line.startsWith('session ended:'));
    assert.match(summary ?? '', /2 tool call\(s\), 1 never returned/);
    assert.ok(logged.some((line) => /never returned: tool 1 Bash — ugrep/.test(line)));
    // A Write is logged as its path. Its text is the reviewed repository's
    // content and has no business in the journal.
    assert.ok(logged.some((line) => line.includes('/w/review.md')));
    assert.ok(!logged.some((line) => line.includes('secret contents')));
  });

  it('does not let a result with no usage fields report the round as free', () => {
    const { logged, totals } = monitorOver([
      { type: 'result', subtype: 'success', session_id: 'abcdef01-1111' },
      {
        type: 'result',
        subtype: 'success',
        num_turns: 17,
        total_cost_usd: 4.4044,
        session_id: 'abcdef01-1111',
        stop_reason: 'end_turn',
        terminal_reason: 'completed',
        duration_ms: 897_000,
      },
    ]);

    assert.equal(totals.results, 2);
    assert.equal(totals.turns, 17);
    assert.equal(totals.costUsd, 4.4044);
    // The unexplained one is printed whole rather than as zeros.
    assert.match(logged[0] ?? '', /carries no num_turns\/total_cost_usd/);
    assert.match(logged[1] ?? '', /result #2 success turns=17 \$4\.4044 session=abcdef01/);
    assert.match(logged[1] ?? '', /stop=end_turn\/completed/);
  });

  it('reports the round, not the subagent turn that finished after it', () => {
    const { totals } = monitorOver([
      { type: 'result', subtype: 'success', num_turns: 17, total_cost_usd: 4.4044 },
      {
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        total_cost_usd: 0.0374,
        origin: { kind: 'task-notification' },
      },
    ]);

    assert.equal(totals.turns, 17);
    assert.equal(totals.costUsd, 4.4044);
  });

  it('says when the session was denied something, or made to wait', () => {
    const { logged } = monitorOver([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      { type: 'system', subtype: 'thinking_tokens' },
      { type: 'system', subtype: 'compact_boundary' },
      {
        type: 'result',
        subtype: 'success',
        num_turns: 2,
        total_cost_usd: 1,
        permission_denials: [{ tool_name: 'Bash' }],
      },
    ]);

    assert.ok(logged.some((line) => line === 'rate limit: rejected'));
    // `allowed` is the steady state and would be one line per session for nothing.
    assert.ok(!logged.some((line) => line.includes('allowed')));
    assert.ok(!logged.some((line) => line.includes('thinking_tokens')));
    assert.ok(logged.some((line) => line === 'session compact_boundary'));
    assert.ok(logged.some((line) => line.includes('1 permission denial(s): Bash')));
  });

  it('reads resetsAt as unix seconds, which is what the CLI sends', () => {
    // 1786910400 is a real value from a 2.1.220 `rate_limit_event`, and it is a
    // five-hour window boundary in 2026. Read as milliseconds it is 1970; the
    // reverse mistake prints the year 58000. Either way the journal would be
    // stating a wrong fact confidently, so the unit is pinned here.
    const { logged } = monitorOver([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1786910400 } },
    ]);

    assert.equal(logged[0], 'rate limit: rejected, resets 2026-08-16T20:00:00.000Z');
  });
});

describe('sessionIdFor', () => {
  it('is a pure function of the pull request, so a later round resumes it', () => {
    const first = sessionIdFor('NickPurcell/OJ', 7);
    assert.equal(first, sessionIdFor('NickPurcell/OJ', 7));
    assert.notEqual(first, sessionIdFor('NickPurcell/OJ', 8));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
