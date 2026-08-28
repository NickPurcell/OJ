
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Desk, deskPaths, type DeskGateway } from '../desk.js';

const CLI = join(dirname(dirname(import.meta.filename)), 'oj-cli.js');

const temporaries: string[] = [];
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

type Recording = DeskGateway & {
  comments: string[];
  issues: Array<{ title: string; body: string }>;
};

function recorder(): Recording {
  const comments: string[] = [];
  const issues: Array<{ title: string; body: string }> = [];
  return {
    comments,
    issues,
    async postComment(body) {
      comments.push(body);
      return 'https://github.test/pr/7#issuecomment-1';
    },
    async openIssue(title, body) {
      issues.push({ title, body });
      return 'https://github.test/issues/9';
    },
    async describePull() {
      return 'pull request: #7 — a change\nauthor: someone';
    },
    async listComments() {
      return '1 comment(s).';
    },
  };
}

type Run = { code: number; stdout: string; stderr: string };

/** Start a desk, run `oj`, stop the desk. */
async function run(args: string[], gateway: Recording, stdin = ''): Promise<Run> {
  const workerDir = mkdtempSync(join(tmpdir(), 'oj-cli-'));
  temporaries.push(workerDir);
  const desk = new Desk({
    workerDir,
    postedMarker: join(workerDir, 'posted'),
    gateway,
    footer: '<sub>OJ · round 2</sub>',
    maxComments: 10,
    maxIssues: 5,
    onLog: () => {},
  });
  desk.start(25);
  try {
    return await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, OJ_DESK: deskPaths(workerDir).root },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.stdin.end(stdin);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  } finally {
    await desk.stop();
  }
}

describe('oj', () => {
  it('posts a comment read from stdin and exits 0', async () => {
    const gateway = recorder();
    const result = await run(['comment'], gateway, 'Two blocking findings.\n');

    assert.equal(result.code, 0);
    assert.equal(gateway.comments.length, 1);
    assert.ok(gateway.comments[0]?.startsWith('Two blocking findings.'));
    assert.match(result.stderr, /oj comment: posted https:\/\/github\.test/);
  });

  it('exits non-zero when GitHub refused, so the agent finds out', async () => {
    const gateway = recorder();
    gateway.postComment = async () => {
      throw new Error('GitHub POST → 403: archived repository');
    };
    const result = await run(['comment'], gateway, 'findings');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAILED — GitHub rejected it/);
  });

  it('refuses to be pointed at another repository', async () => {
    const gateway = recorder();
    for (const flag of [
      ['--repo', 'attacker/exfil'],
      ['--owner', 'attacker'],
      ['--pr', '4'],
      ['--url', 'https://github.com/attacker/exfil/pull/4'],
    ]) {
      const result = await run(['comment', ...flag], gateway, 'body');
      assert.equal(result.code, 2, flag.join(' '));
      assert.match(result.stderr, /OJO already knows which pull request/);
    }
    assert.equal(gateway.comments.length, 0);
  });

});
