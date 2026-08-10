/**
 * OJO — the orchestrator.
 *
 * It polls GitHub for pull requests that want reviewing, hands each one to a
 * worker, and posts what comes back. Everything that touches a credential
 * happens in this process; everything that reads untrusted code happens in the
 * worker. That division is the product, and the rest is scheduling.
 *
 * Polling rather than webhooks because the host has no inbound route, and a
 * reviewer that only works when someone maintains a tunnel is a reviewer that
 * stops working the week you forget about it. The cost is latency measured in
 * one poll interval, which for code review is not a cost.
 *
 * The loop is single-threaded and deliberately boring: list, decide, queue,
 * drain, sweep. Reviews run concurrently up to a cap because each one is a
 * whole Claude Code process with subagents underneath it; two of those on a
 * small VPS is already a lot of memory.
 */

import { mkdirSync } from 'node:fs';
import { loadAuthEnv, loadConfig, type OjConfig, type RepoConfig } from './config.js';
import {
  createAuth,
  GitHubClient,
  GitHubError,
  type PullRequest,
  type ReviewEvent,
} from './github.js';
import { blockingFindings, inlineCommentsFor, renderReviewBody } from './report.js';
import { prKey, StateStore } from './state.js';
import { removeWorkerDir, runReview, sessionIdFor, workerDirFor } from './worker.js';

const config = loadConfig();
const client = new GitHubClient(createAuth(loadAuthEnv(), config.github.apiBaseUrl), config.github.apiBaseUrl);
const state = new StateStore(config.paths.stateFile);

mkdirSync(config.paths.workersRoot, { recursive: true, mode: 0o700 });

/** The account OJO posts as. Resolved at startup; only used to avoid self-review. */
let identity = '';

/**
 * Node's `fetch` does not read `HTTP_PROXY`/`HTTPS_PROXY` unless it is told to,
 * and on a host where the only route out is a proxy that means every GitHub
 * request fails with `EAI_AGAIN` — a DNS error, which reads as "the network is
 * down" rather than "this process is not using the proxy you configured".
 *
 * `NODE_USE_ENV_PROXY=1` fixes it, and it is set in the systemd unit and the
 * `start` script. The environment variable rather than `--use-env-proxy`
 * deliberately: an unrecognised CLI flag stops Node from starting at all, so a
 * host on an older 22.x would fail to boot the service over something it does
 * not need, whereas an unrecognised variable is ignored.
 *
 * Warned rather than thrown because a host can have both a proxy variable and
 * working direct egress, and refusing to start there would be wrong.
 */
function warnIfProxyIgnored(): void {
  const proxy = process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ?? process.env['HTTP_PROXY'] ?? process.env['http_proxy'];
  if (!proxy) return;
  const enabled =
    process.env['NODE_USE_ENV_PROXY'] === '1' ||
    process.execArgv.includes('--use-env-proxy') ||
    (process.env['NODE_OPTIONS'] ?? '').includes('--use-env-proxy');
  if (enabled) return;
  process.stderr.write(
    `[oj] a proxy is configured (${proxy}) but this process is not using it — Node's fetch ` +
      'ignores the proxy variables by default. Every GitHub request will fail with EAI_AGAIN. ' +
      'Set NODE_USE_ENV_PROXY=1 in the environment (the systemd unit does).\n',
  );
}

const log = (message: string): void => {
  process.stdout.write(`[oj] ${message}\n`);
};
const warn = (message: string): void => {
  process.stderr.write(`[oj] ${message}\n`);
};

let stopping = false;
/** PRs with a review in flight, so a slow round is not started twice by the next tick. */
const inFlight = new Set<string>();

type Trigger = 'label' | 'new';

type QueuedReview = {
  repo: RepoConfig;
  pull: PullRequest;
  trigger: Trigger;
};

// ── deciding ─────────────────────────────────────────────────────────────────

/**
 * Should this PR be reviewed on this tick, and why?
 *
 * Two ways in. The label is the deliberate one — a human asking, including the
 * human asking again after pushing a fix, which is why OJO removes the label
 * when it starts rather than when it finishes. `reviewNewPrs` is the automatic
 * one, and it only ever fires once per PR, above the baseline recorded the
 * first time OJO saw the repository.
 */
function decide(repo: RepoConfig, pull: PullRequest, baseline: number): Trigger | null {
  if (pull.labels.includes(repo.reviewLabel)) return 'label';

  if (!repo.reviewNewPrs) return null;
  if (pull.number <= baseline) return null;
  // Any prior record means this PR has been seen and handled before, so the
  // "new PR" trigger has already fired for it. Further rounds come from the label.
  if (state.get(repo.slug, pull.number)) return null;
  return 'new';
}

/** Reasons to decline a PR outright, with something to say to the humans. */
function declineReason(repo: RepoConfig, pull: PullRequest): string | null {
  if (pull.draft && !repo.reviewDrafts) {
    return 'this pull request is a draft, and OJ is configured to skip drafts (`reviewDrafts: false`).';
  }
  if (pull.fromFork && !repo.reviewForks) {
    return (
      `the head branch lives in a fork (\`${pull.headRepoSlug}\`), and OJ is configured ` +
      'to skip fork pull requests (`reviewForks: false`). Reviewing one means cloning ' +
      'outside code onto the review host, so it is opt-in.'
    );
  }
  return null;
}

// ── posting ──────────────────────────────────────────────────────────────────

/**
 * Post the review, degrading rather than failing.
 *
 * GitHub rejects a whole review for reasons that have nothing to do with its
 * content: an inline comment on a line outside the diff, a `commit_id` that a
 * force-push orphaned mid-review, an APPROVE on a PR the app itself opened.
 * Every one of those would throw away a finished review, which is the most
 * expensive thing this service produces. So each failure drops one requirement
 * and tries again, and the last resort is a plain issue comment — ugly, but
 * the findings reach a human.
 */
async function postReview(
  repo: RepoConfig,
  pull: PullRequest,
  event: ReviewEvent,
  body: string,
  comments: Array<{ path: string; line: number; body: string }>,
  headSha: string,
): Promise<{ event: ReviewEvent; inline: boolean }> {
  const attempts: Array<{
    event: ReviewEvent;
    comments: typeof comments;
    commit: string | undefined;
    note: string;
  }> = [
    { event, comments, commit: headSha, note: 'full' },
    { event, comments: [], commit: headSha, note: 'without inline comments' },
    { event, comments: [], commit: undefined, note: 'without a pinned commit' },
    { event: 'COMMENT', comments: [], commit: undefined, note: 'downgraded to COMMENT' },
  ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    if (attempt.comments.length === 0 && comments.length > 0 && attempt.note === 'full') continue;
    try {
      const result = await client.createReview(
        repo.owner,
        repo.repo,
        pull.number,
        attempt.event,
        body,
        attempt.comments,
        attempt.commit,
      );
      if (attempt.note !== 'full') {
        warn(`${repo.slug}#${pull.number}: review posted ${attempt.note}`);
      }
      return { event: attempt.event, inline: result.inlineCommentsPosted };
    } catch (error) {
      lastError = error;
      if (!(error instanceof GitHubError) || (error.status !== 422 && error.status !== 403)) throw error;
    }
  }

  warn(
    `${repo.slug}#${pull.number}: every review attempt was rejected (${String(lastError)}) — ` +
      'falling back to an issue comment',
  );
  await client.createIssueComment(repo.owner, repo.repo, pull.number, body);
  return { event: 'COMMENT', inline: false };
}

/**
 * Map findings onto a GitHub review event.
 *
 * `verdictMode: comment` caps the result no matter what the mapping says, and
 * the cap is reported in the review footer. That default exists because the
 * first month of running a review bot is spent finding out whether you believe
 * it, and a bot that can block merges while you are still deciding is a bot
 * that gets uninstalled instead of tuned.
 */
function decideVerdict(
  repo: RepoConfig,
  pull: PullRequest,
  blockingCount: number,
): { event: ReviewEvent; downgraded: boolean } {
  const wanted: ReviewEvent =
    blockingCount > 0
      ? repo.requestChangesWhenBlocking
        ? 'REQUEST_CHANGES'
        : 'COMMENT'
      : repo.approveWhenClean
        ? 'APPROVE'
        : 'COMMENT';

  if (repo.verdictMode !== 'full') {
    return { event: 'COMMENT', downgraded: wanted !== 'COMMENT' };
  }
  // GitHub refuses to let an account approve or request changes on its own
  // pull request. Catching it here rather than in the 422 fallback keeps the
  // log readable when OJ reviews a PR that OJ opened.
  if (identity && pull.authorLogin === identity && wanted !== 'COMMENT') {
    return { event: 'COMMENT', downgraded: true };
  }
  return { event: wanted, downgraded: false };
}

// ── one review ───────────────────────────────────────────────────────────────

async function review(queued: QueuedReview): Promise<void> {
  const { repo, pull, trigger } = queued;
  const key = prKey(repo.slug, pull.number);
  const existing = state.get(repo.slug, pull.number);
  const round = (existing?.rounds ?? 0) + 1;

  // Remove the trigger label BEFORE doing any work. The label is the request,
  // so clearing it immediately makes re-adding it a fresh request — a human
  // who pushes a fix and re-labels gets a second round even while the first is
  // still running. Removing it at the end would swallow that.
  if (trigger === 'label') {
    try {
      await client.removeLabel(repo.owner, repo.repo, pull.number, repo.reviewLabel);
    } catch (error) {
      warn(`${key}: could not remove the trigger label — ${String(error)}`);
    }
  }

  // Say something before the long silence starts. A review round takes tens of
  // minutes, and from the outside "thinking" and "crashed" look identical.
  try {
    await client.createIssueComment(
      repo.owner,
      repo.repo,
      pull.number,
      config.review.acknowledgement.replace('{pr}', String(pull.number)),
    );
  } catch (error) {
    // Not fatal. Losing the acknowledgement costs clarity, not the review.
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
      onProgress: (line) => log(`${key} · ${line}`),
    },
    existing?.lastReviewedHeadSha ?? null,
  );

  const seconds = (outcome.durationMs / 1000).toFixed(0);

  state.put({
    slug: repo.slug,
    number: pull.number,
    workerDir: workerDirFor(config, repo.slug, pull.number),
    sessionId: sessionIdFor(repo.slug, pull.number),
    rounds: round,
    // Only a successful round updates the reviewed SHA. A failed one must not
    // claim to have looked at this commit, or the follow-up prompt would tell
    // the next round to diff against something nobody reviewed.
    lastReviewedHeadSha: outcome.ok ? pull.headSha : (existing?.lastReviewedHeadSha ?? null),
    createdAt: existing?.createdAt ?? Date.now(),
    lastActivityAt: Date.now(),
  });

  if (!outcome.ok) {
    warn(`${key}: round ${round} failed after ${seconds}s — ${outcome.reason}: ${outcome.detail}`);
    // Report the failure where the humans are. Silence after an acknowledgement
    // is worse than no acknowledgement at all.
    try {
      await client.createIssueComment(
        repo.owner,
        repo.repo,
        pull.number,
        [
          '## OJ review failed',
          '',
          `The review round did not complete (\`${outcome.reason}\`).`,
          '',
          '```',
          outcome.detail.slice(0, 1500),
          '```',
          '',
          `Re-add the \`${repo.reviewLabel}\` label to try again.`,
        ].join('\n'),
      );
    } catch (error) {
      warn(`${key}: could not report the failure either — ${String(error)}`);
    }
    return;
  }

  const { report, dropped } = outcome;
  const blocking = blockingFindings(report);
  const { event, downgraded } = decideVerdict(repo, pull, blocking.length);

  // The worker was told which SHA it was reviewing. If it says it reviewed a
  // different one, something is wrong with the checkout and the review is
  // about the wrong code — worth a line in the journal, not worth withholding.
  if (report.reviewedHeadSha && !pull.headSha.startsWith(report.reviewedHeadSha.slice(0, 7))) {
    warn(
      `${key}: worker reported reviewing ${report.reviewedHeadSha} but the PR head is ${pull.headSha}`,
    );
  }

  const inline = config.review.inlineComments ? inlineCommentsFor(report) : [];
  // Rendered twice when inline comments are dropped: the body has to carry the
  // file and line in prose in that case, and we do not know whether they were
  // dropped until we have tried. Rendering is free; a review without locations
  // is not.
  const bodyWith = renderReviewBody(report, {
    headSha: pull.headSha,
    round,
    verdictMode: repo.verdictMode,
    downgraded,
    locateInBody: inline.length === 0,
    dropped,
  });

  const posted = await postReview(repo, pull, event, bodyWith, inline, pull.headSha);

  if (inline.length > 0 && !posted.inline) {
    // The locations never made it onto the diff. Post them as a follow-up
    // comment rather than leaving findings pointing at nothing.
    const locations = report.findings
      .filter((finding) => finding.file)
      .map((finding) => `- \`${finding.file}${finding.line ? `:${finding.line}` : ''}\` — ${finding.title}`);
    if (locations.length > 0) {
      try {
        await client.createIssueComment(
          repo.owner,
          repo.repo,
          pull.number,
          ['**Finding locations** (GitHub rejected them as inline comments):', '', ...locations].join('\n'),
        );
      } catch (error) {
        warn(`${key}: could not post finding locations — ${String(error)}`);
      }
    }
  }

  log(
    `${key}: round ${round} ${posted.event} in ${seconds}s — ` +
      `${blocking.length} blocking, ${report.findings.length - blocking.length} non-blocking, ` +
      `${dropped.length} dropped, ${outcome.turns} turns, $${outcome.costUsd.toFixed(4)}` +
      (outcome.hadRepoInstructions ? ', repo OJ.md applied' : ''),
  );
}

// ── the loop ─────────────────────────────────────────────────────────────────

/**
 * Run queued reviews, at most `maxConcurrentReviews` at a time.
 *
 * Each review is a `claude` process with subagents beneath it, so the cap is
 * about memory on the host rather than about GitHub. Failures are contained
 * per-review: one PR blowing up must not cancel the others in the batch.
 */
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

/**
 * Retire the directory for a PR that is no longer open.
 *
 * Confirmed against the API rather than inferred from absence: a PR missing
 * from the open list might have been merged, or the list request might have
 * been truncated, and deleting a live review's session over a paging quirk is
 * the sort of bug that only shows up on the busiest repo.
 */
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

/**
 * Delete directories for PRs that went quiet.
 *
 * Belt to `retireClosed`'s braces. A PR can stay open and untouched for
 * months, and its clone is a full checkout of the repository; without this the
 * workers root grows without bound on exactly the repositories where nobody is
 * watching. The session transcript is not deleted, and the directory path is
 * deterministic, so a later round rebuilds the clone and resumes the same
 * conversation.
 */
function sweepStale(): void {
  if (config.review.workerTtlHours <= 0) return;
  const cutoff = Date.now() - config.review.workerTtlHours * 3600_000;
  for (const record of state.all()) {
    if (record.lastActivityAt > cutoff) continue;
    if (inFlight.has(prKey(record.slug, record.number))) continue;
    removeWorkerDir(config, record.slug, record.number);
    state.remove(record.slug, record.number);
    log(
      `${record.slug}#${record.number}: idle for over ${config.review.workerTtlHours}h — ` +
        'worker directory reclaimed',
    );
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
          // A label on a PR OJ will not review would otherwise be re-detected
          // every tick forever. Clear it and say why, once.
          try {
            await client.removeLabel(repo.owner, repo.repo, pull.number, repo.reviewLabel);
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

  sweepStale();

  if (queue.length > 0) {
    log(`${queue.length} review(s) queued`);
    await drain(queue);
  }
}

async function main(): Promise<void> {
  warnIfProxyIgnored();

  try {
    identity = await client.whoAmI();
  } catch (error) {
    // Not fatal: identity is only used to avoid approving our own PRs, and the
    // 422 fallback in postReview covers the case anyway.
    warn(`could not resolve the acting account — ${String(error)}`);
  }

  log(
    `starting — pid ${process.pid}, ${client.describeAuth()}` +
      (identity ? ` as ${identity}` : '') +
      `, ${config.repos.length} repo(s), poll ${config.pollIntervalSeconds}s, ` +
      `verdictMode ${config.verdictMode}`,
  );
  for (const repo of config.repos) {
    log(
      `  ${repo.slug}: label "${repo.reviewLabel}", newPrs=${repo.reviewNewPrs}, ` +
        `forks=${repo.reviewForks}, drafts=${repo.reviewDrafts}, verdict=${repo.verdictMode}`,
    );
  }
  if (config.verdictMode === 'comment') {
    log(
      'verdictMode is "comment": every review posts as a COMMENT regardless of findings. ' +
        'Set verdictMode: full once you trust it.',
    );
  }

  // Sequential ticks rather than setInterval. A tick can take longer than the
  // interval — it waits for reviews to finish — and overlapping ticks would
  // queue the same PR twice, spawn two workers into one directory, and have
  // them fight over the checkout.
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
        timer.unref();
        // unref'd so a SIGTERM during the idle gap exits promptly instead of
        // holding the process open for the rest of the interval.
        pendingSleep = done;
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
  // A review round can run for the better part of an hour, and systemd will
  // not wait that long. Rather than pretend, exit once the sleep is released:
  // sessions are resumable by their deterministic id, so a round killed
  // mid-flight is re-runnable by re-labelling rather than lost.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  warn(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

await main();
