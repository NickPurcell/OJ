
import { mkdirSync } from 'node:fs';
import { GITHUB_API, loadAuthEnv, loadConfig, type RepoConfig } from './config.js';
import type { DeskGateway } from './desk.js';
import {
  createAuth,
  GitHubClient,
  GitHubError,
  type PullRequest,
  type ReviewEvent,
} from './github.js';
import {
  ACKNOWLEDGEMENT,
  decideEvent,
  failureComment,
  rateLimitedComment,
  renderComments,
  renderPullFacts,
  verdictBody,
} from './review.js';
import { prKey, StateStore } from './state.js';
import { removeWorkerDir, runReview, workerDirFor } from './worker.js';

const config = loadConfig();
const client = new GitHubClient(createAuth(loadAuthEnv()), GITHUB_API);
const state = new StateStore(config.paths.stateFile);

mkdirSync(config.paths.workersRoot, { recursive: true, mode: 0o700 });

let identity = '';

const log = (message: string): void => {
  process.stdout.write(`[oj] ${message}\n`);
};
const warn = (message: string): void => {
  process.stderr.write(`[oj] ${message}\n`);
};

let stopping = false;
const inFlight = new Set<string>();

type Trigger = 'label' | 'new' | 'retry';

type QueuedReview = {
  repo: RepoConfig;
  pull: PullRequest;
  trigger: Trigger;
};

// ── deciding ─────────────────────────────────────────────────────────────────

function decide(repo: RepoConfig, pull: PullRequest, baseline: number): Trigger | null {
  if (pull.labels.includes(config.label)) return 'label';
  const existing = state.get(repo.slug, pull.number);
  if (existing?.retryAfter && Date.now() >= existing.retryAfter) return 'retry';
  if (!config.reviewNewPrs) return null;
  if (pull.number <= baseline) return null;
  // A prior record means the "new PR" trigger already fired; further rounds come from the label.
  if (existing) return null;
  return 'new';
}

/** Reasons to decline a PR outright, with something to say to the humans. */
function declineReason(repo: RepoConfig, pull: PullRequest): string | null {
  if (pull.draft) return 'this pull request is a draft; mark it ready for review and re-label it.';
  if (pull.fromFork) {
    return (
      `the head branch lives in a fork (\`${pull.headRepoSlug}\`), and OJ is configured ` +
      'OJ does not review pull requests from forks: the reviewer runs the head in its own checkout.'
    );
  }
  return null;
}

// ── posting ──────────────────────────────────────────────────────────────────

function gatewayFor(repo: RepoConfig, pull: PullRequest): DeskGateway {
  return {
    postComment: (body) => client.createIssueComment(repo.owner, repo.repo, pull.number, body),
    openIssue: (title, body) => client.createIssue(repo.owner, repo.repo, title, body),
    describePull: async () =>
      renderPullFacts(pull, await client.listPullFiles(repo.owner, repo.repo, pull.number)),
    listComments: async () =>
      renderComments(await client.listIssueComments(repo.owner, repo.repo, pull.number)),
  };
}

async function postVerdict(
  repo: RepoConfig,
  pull: PullRequest,
  event: ReviewEvent,
  body: string,
): Promise<ReviewEvent | null> {
  const attempts: Array<{ event: ReviewEvent; commit: string | undefined; note: string }> = [
    { event, commit: pull.headSha, note: 'full' },
    { event, commit: undefined, note: 'without a pinned commit' },
  ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      await client.createReview(repo.owner, repo.repo, pull.number, attempt.event, body, attempt.commit);
      if (attempt.note !== 'full') {
        warn(`${repo.slug}#${pull.number}: verdict posted ${attempt.note}`);
      }
      return attempt.event;
    } catch (error) {
      lastError = error;
      if (!(error instanceof GitHubError) || (error.status !== 422 && error.status !== 403)) throw error;
    }
  }

  warn(
    `${repo.slug}#${pull.number}: the ${event} review was rejected (${String(lastError)}) — ` +
      'the review comment stands on its own',
  );
  return null;
}

async function review(queued: QueuedReview): Promise<void> {
  const { repo, pull, trigger } = queued;
  const key = prKey(repo.slug, pull.number);
  const existing = state.get(repo.slug, pull.number);
  const round = (existing?.rounds ?? 0) + 1;

  if (trigger === 'label') {
    try {
      await client.removeLabel(repo.owner, repo.repo, pull.number, config.label);
    } catch (error) {
      warn(`${key}: could not remove the trigger label — ${String(error)}`);
    }
  }

  try {
    await client.createIssueComment(
      repo.owner,
      repo.repo,
      pull.number,
      ACKNOWLEDGEMENT,
    );
  } catch (error) {
    warn(`${key}: could not post the acknowledgement — ${String(error)}`);
  }

  log(`${key}: round ${round} starting (${trigger}, head ${pull.headSha.slice(0, 8)})`);

  const outcome = await runReview(
    {
      config,
      repo,
      pull,
      round,
      gitToken: await client.gitToken(),
      gateway: gatewayFor(repo, pull),
      onProgress: (line) => log(`${key} · ${line}`),
    },
    existing?.lastReviewedHeadSha ?? null,
  );

  const seconds = (outcome.durationMs / 1000).toFixed(0);

  state.put({
    slug: repo.slug,
    number: pull.number,
    rounds: round,
    lastReviewedHeadSha: outcome.ok ? pull.headSha : (existing?.lastReviewedHeadSha ?? null),
    retryAfter: !outcome.ok && outcome.reason === 'rate-limited' ? outcome.retryAfter : null,
    createdAt: existing?.createdAt ?? Date.now(),
    lastActivityAt: Date.now(),
  });

  if (!outcome.ok) {
    warn(`${key}: round ${round} failed after ${seconds}s — ${outcome.reason}: ${outcome.detail}`);
    if (outcome.ledger.issues.length > 0) {
      warn(`${key}: the failed round had already opened ${outcome.ledger.issues.length} issue(s)`);
    }
    try {
      await client.createIssueComment(
        repo.owner,
        repo.repo,
        pull.number,
        outcome.reason === 'rate-limited'
          ? rateLimitedComment(outcome.retryAfter)
          : failureComment(outcome.reason, outcome.detail, config.label),
      );
    } catch (error) {
      warn(`${key}: could not report the failure either — ${String(error)}`);
    }
    return;
  }

  const { ledger } = outcome;
  const decision = decideEvent(ledger.verdict, config.approve, pull, identity);

  let postedEvent: ReviewEvent | null = null;
  if (decision.event !== 'COMMENT') {
    postedEvent = await postVerdict(
      repo,
      pull,
      decision.event,
      verdictBody(decision, round, pull.headSha, ledger.comments[0] ?? null),
    );
  }

  log(
    `${key}: round ${round} ${postedEvent ?? 'COMMENT'} in ${seconds}s — ` +
      `verdict ${ledger.verdict ?? 'none'}` +
      (decision.downgraded ? ` (capped from ${decision.wanted})` : '') +
      `, ${ledger.comments.length} comment(s), ${ledger.issues.length} issue(s), ` +
      `${outcome.turns} turns, $${outcome.costUsd.toFixed(4)}` +
      (outcome.hadRepoInstructions ? ', repo OJ.md applied' : '') +
      (outcome.caveat ? ` — ${outcome.caveat}` : ''),
  );
}

// ── the loop ─────────────────────────────────────────────────────────────────

async function drain(queue: QueuedReview[]): Promise<void> {
  const runners: Array<Promise<void>> = [];
  const next = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item || stopping) return;
      const key = prKey(item.repo.slug, item.pull.number);
      inFlight.add(key);
      try {
        await review(item);
      } catch (error) {
        warn(`${key}: review threw — ${error instanceof Error ? error.stack : String(error)}`);
      } finally {
        inFlight.delete(key);
      }
    }
  };
  for (let i = 0; i < Math.min(config.maxConcurrentReviews, queue.length); i += 1) {
    runners.push(next());
  }
  await Promise.all(runners);
}

async function retireClosed(repo: RepoConfig, openNumbers: Set<number>): Promise<void> {
  for (const record of state.forRepo(repo.slug)) {
    if (openNumbers.has(record.number)) continue;
    if (inFlight.has(prKey(repo.slug, record.number))) continue;

    let disposition = 'gone';
    try {
      const pull = await client.getPull(repo.owner, repo.repo, record.number);
      if (pull.state === 'open') continue;
      disposition = pull.merged ? 'merged' : 'closed';
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) {
        warn(`${repo.slug}#${record.number}: could not confirm state — ${String(error)}`);
        continue;
      }
    }

    removeWorkerDir(config, repo.slug, record.number);
    state.remove(repo.slug, record.number);
    log(`${repo.slug}#${record.number}: ${disposition} — worker directory removed`);
  }
}

async function tick(): Promise<void> {
  const queue: QueuedReview[] = [];

  for (const repo of config.repos) {
    let pulls: PullRequest[];
    try {
      pulls = await client.listOpenPulls(repo.owner, repo.repo);
    } catch (error) {
      // One unreachable repository must not stop the others. A missing repo or
      // a revoked installation is a standing condition, and the loop reporting
      // it once per tick is the correct amount of noise.
      warn(`${repo.slug}: could not list pull requests — ${String(error)}`);
      continue;
    }

    const openNumbers = new Set(pulls.map((pull) => pull.number));
    const highest = pulls.reduce((max, pull) => Math.max(max, pull.number), 0);
    const baseline = state.baselineFor(repo.slug, highest);

    for (const pull of pulls) {
      const key = prKey(repo.slug, pull.number);
      if (inFlight.has(key)) continue;

      const trigger = decide(repo, pull, baseline);
      if (!trigger) continue;

      const declined = declineReason(repo, pull);
      if (declined) {
        if (trigger === 'label') {
          try {
            await client.removeLabel(repo.owner, repo.repo, pull.number, config.label);
            await client.createIssueComment(
              repo.owner,
              repo.repo,
              pull.number,
              `OJ is not reviewing this: ${declined}`,
            );
          } catch (error) {
            warn(`${key}: could not decline cleanly — ${String(error)}`);
          }
        }
        continue;
      }

      queue.push({ repo, pull, trigger });
    }

    await retireClosed(repo, openNumbers);
  }


  if (queue.length > 0) {
    log(`${queue.length} review(s) queued`);
    await drain(queue);
  }
}

async function main(): Promise<void> {

  try {
    identity = await client.whoAmI();
  } catch (error) {
    warn(`could not resolve the acting account — ${String(error)}`);
  }

  log(
    `starting — pid ${process.pid}, ${client.describeAuth()}` +
      (identity ? ` as ${identity}` : '') +
      `, poll ${config.pollIntervalSeconds}s, label "${config.label}", newPrs=${config.reviewNewPrs}, ` +
      `approve=${config.approve}: ${config.repos.map((repo) => repo.slug).join(', ')}`,
  );
  if (!config.approve) log('approve is false: every review posts as a COMMENT regardless of findings.');

  // Sequential ticks rather than setInterval.
  while (!stopping) {
    const startedAt = Date.now();
    try {
      await tick();
    } catch (error) {
      warn(`tick failed — ${error instanceof Error ? error.stack : String(error)}`);
    }
    const remaining = config.pollIntervalSeconds * 1000 - (Date.now() - startedAt);
    if (remaining > 0 && !stopping) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, remaining);
        pendingSleep = () => {
          clearTimeout(timer);
          done();
        };
      });
    }
  }

  log('stopped');
}

let pendingSleep: (() => void) | null = null;

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(
    `${signal} received — finishing ${inFlight.size} in-flight review(s) before exit. ` +
      'Workers are child processes and will be killed with this one.',
  );
  pendingSleep?.();
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  warn(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

await main();
