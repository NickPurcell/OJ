/**
 * OJO's configuration: behaviour from `oj-config.yaml`, secrets from the
 * environment.
 *
 * The split is the same one Clawcius makes and for the same reason — changing
 * which repos are watched, or how a verdict maps onto a GitHub review, should
 * be a diff someone can read in a PR. Credentials must never be in that diff.
 *
 * Every YAML key is optional and falls back to a default below, with one
 * exception: `repos` must name at least one repository, because a reviewer
 * watching nothing is a service that looks healthy and does nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * How a verdict is allowed to reach GitHub.
 *
 * `comment` posts COMMENT reviews no matter what the worker concluded. It is
 * the default, and it should stay the default until an operator has read a
 * few dozen reviews and believes them: a bot that can APPROVE is a bot whose
 * mistakes land in the merge queue, and a bot that can REQUEST_CHANGES is a
 * bot that can block a release at 2am over a hallucinated null deref.
 *
 * `full` honours the mapping in `review` below. Turn it on deliberately.
 */
export type VerdictMode = 'comment' | 'full';

/** Per-repo knobs. Every one of these has a global default. */
export type RepoPolicy = {
  /** Adding this label to a PR asks for a review. OJO removes it when it starts. */
  reviewLabel: string;
  /** Review a PR the first time OJO sees it, without waiting for the label. */
  reviewNewPrs: boolean;
  /** Draft PRs are usually still being written. Off by default. */
  reviewDrafts: boolean;
  /**
   * Review PRs whose head lives in a fork.
   *
   * Safe by construction here — OJO fetches `refs/pull/<n>/head` from the base
   * repo rather than adding the fork as a remote, and the worker never holds a
   * credential — but it is still someone else's code being cloned onto your
   * host, so it is a decision rather than a default.
   */
  reviewForks: boolean;
  /** No blocking findings → post an APPROVE review. */
  approveWhenClean: boolean;
  /** At least one blocking finding → post a REQUEST_CHANGES review. */
  requestChangesWhenBlocking: boolean;
  /** Overrides the global `verdictMode` for this repo. */
  verdictMode: VerdictMode;
};

export type RepoConfig = RepoPolicy & {
  owner: string;
  repo: string;
  /** `owner/repo`, for logs and state keys. */
  slug: string;
};

export type OjConfig = {
  /**
   * Seconds between polls of the GitHub API.
   *
   * Polling rather than webhooks because the host is behind NAT and has no
   * inbound route. The cost is one `GET /repos/:o/:r/pulls` per repo per tick,
   * which against the 5000/hour installation budget means even a 30s interval
   * across ten repos uses under a quarter of it. See `github.ts` for what
   * happens when that estimate turns out to be wrong.
   */
  pollIntervalSeconds: number;
  /** Global ceiling on what a verdict may become. See `VerdictMode`. */
  verdictMode: VerdictMode;
  /** Reviews running at once, across all repos. Each one is a Claude Code process. */
  maxConcurrentReviews: number;

  github: {
    /** Override for GitHub Enterprise Server. Include the `/api/v3` suffix there. */
    apiBaseUrl: string;
    /** Where clones are fetched from. Enterprise installs change this too. */
    gitBaseUrl: string;
  };

  paths: {
    /** One directory per PR lives under here. Deleted when the PR closes. */
    workersRoot: string;
    /** The kickoff prompt handed to every worker. */
    kickoffPrompt: string;
    /** Appended to Claude Code's own system prompt in every worker session. */
    systemPrompt: string;
    /** Which PRs have workers, and what OJO has already reviewed. */
    stateFile: string;
  };

  worker: {
    /** The `claude` binary. An absolute path, because systemd's PATH is minimal. */
    claudePath: string;
    /** Model alias or full name. Empty string means "whatever the CLI defaults to". */
    model: string;
    /**
     * Hard cap on a single review round. The process is killed at this point
     * and the round reported as a failure rather than left to run forever.
     */
    timeoutMinutes: number;
    /**
     * Commits fetched for the PR head and its base. Deep enough that the merge
     * base is usually present; `worker.ts` deepens automatically when it is not.
     */
    fetchDepth: number;
    /**
     * Extra environment variables the worker is allowed to inherit.
     *
     * The worker's environment is built from an allowlist, not filtered by a
     * denylist — see `worker.ts`. Anything you add here you are handing to a
     * process that will read attacker-authored code, so add carefully.
     */
    envPassthrough: string[];
    /**
     * Paths deleted from the clone after checkout, and marked binary in
     * `.git/info/attributes` so they do not surface through `git diff` either.
     *
     * These are the file names that agentic tools treat as instructions. A PR
     * that adds one is a PR trying to write its own review.
     */
    stripPaths: string[];
  };

  review: {
    /** Posted as an issue comment the moment a round starts. `{pr}` is substituted. */
    acknowledgement: string;
    /** Delete a worker directory after this many hours with no activity. 0 disables. */
    workerTtlHours: number;
    /**
     * Try to attach findings as inline review comments on the diff.
     *
     * Best effort: GitHub rejects the whole review if any comment lands on a
     * line outside the diff, so a rejection retries with the findings in the
     * body instead. Nothing is lost when it fails, only located.
     */
    inlineComments: boolean;
  };

  repos: RepoConfig[];
};

const DEFAULT_POLICY: RepoPolicy = {
  reviewLabel: 'oj:review',
  reviewNewPrs: false,
  reviewDrafts: false,
  reviewForks: false,
  approveWhenClean: true,
  requestChangesWhenBlocking: true,
  verdictMode: 'comment',
};

const DEFAULTS = {
  pollIntervalSeconds: 60,
  verdictMode: 'comment' as VerdictMode,
  maxConcurrentReviews: 2,
  github: {
    apiBaseUrl: 'https://api.github.com',
    gitBaseUrl: 'https://github.com',
  },
  paths: {
    workersRoot: '/var/lib/oj/workers',
    kickoffPrompt: 'OJ.md',
    systemPrompt: 'prompts/worker-system-prompt.md',
    stateFile: '/var/lib/oj/state.json',
  },
  worker: {
    claudePath: '/usr/local/bin/claude',
    model: '',
    timeoutMinutes: 45,
    fetchDepth: 100,
    envPassthrough: [] as string[],
    stripPaths: [
      'CLAUDE.md',
      '**/CLAUDE.md',
      '.claude',
      '**/.claude',
      'OJ.md',
      '**/OJ.md',
      'AGENTS.md',
      '**/AGENTS.md',
      '.cursorrules',
      '.cursor',
      '.windsurfrules',
      '.github/copilot-instructions.md',
    ],
  },
  review: {
    acknowledgement:
      '🧬 OJ is reviewing this pull request. I will post findings here when the ' +
      'sweep finishes — if nothing appears within the hour, something broke on my end.',
    workerTtlHours: 72,
    inlineComments: true,
  },
} as const;

class ConfigError extends Error {
  constructor(path: string, message: string) {
    super(`oj-config.yaml: ${path} ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ConfigError(path, 'must be a mapping');
  return raw;
}

function str(raw: unknown, path: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(path, 'must be a string');
  return raw;
}

function bool(raw: unknown, path: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw new ConfigError(path, 'must be true or false');
  return raw;
}

function num(raw: unknown, path: string, fallback: number, min: number, max?: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ConfigError(path, 'must be a number');
  }
  if (raw < min) throw new ConfigError(path, `must be >= ${min}`);
  if (max !== undefined && raw > max) throw new ConfigError(path, `must be <= ${max}`);
  return raw;
}

function strList(raw: unknown, path: string, fallback: readonly string[]): string[] {
  if (raw === undefined || raw === null) return [...fallback];
  if (!Array.isArray(raw)) throw new ConfigError(path, 'must be a list');
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') throw new ConfigError(`${path}[${index}]`, 'must be a string');
    return entry;
  });
}

function verdictMode(raw: unknown, path: string, fallback: VerdictMode): VerdictMode {
  if (raw === undefined || raw === null) return fallback;
  if (raw !== 'comment' && raw !== 'full') {
    throw new ConfigError(path, "must be 'comment' or 'full'");
  }
  return raw;
}

/**
 * Read the per-repo policy block, inheriting anything it does not state.
 *
 * Used twice: once against the top-level `defaults:` mapping to build the
 * house policy, and once per repo entry to override it. Making inheritance a
 * single function is what keeps "the default default" and "this repo's
 * default" from drifting apart as knobs get added.
 */
function policy(raw: Record<string, unknown>, path: string, inherited: RepoPolicy): RepoPolicy {
  return {
    reviewLabel: str(raw['reviewLabel'], `${path}.reviewLabel`, inherited.reviewLabel),
    reviewNewPrs: bool(raw['reviewNewPrs'], `${path}.reviewNewPrs`, inherited.reviewNewPrs),
    reviewDrafts: bool(raw['reviewDrafts'], `${path}.reviewDrafts`, inherited.reviewDrafts),
    reviewForks: bool(raw['reviewForks'], `${path}.reviewForks`, inherited.reviewForks),
    approveWhenClean: bool(
      raw['approveWhenClean'],
      `${path}.approveWhenClean`,
      inherited.approveWhenClean,
    ),
    requestChangesWhenBlocking: bool(
      raw['requestChangesWhenBlocking'],
      `${path}.requestChangesWhenBlocking`,
      inherited.requestChangesWhenBlocking,
    ),
    verdictMode: verdictMode(raw['verdictMode'], `${path}.verdictMode`, inherited.verdictMode),
  };
}

/**
 * `owner/repo`, or an entry that names them separately.
 *
 * The slug form is what people actually type, so it is supported first-class
 * rather than as a convenience — a config file full of `owner:`/`repo:` pairs
 * is harder to scan for "is this repo watched?", which is the only question
 * anyone ever asks of this list.
 */
function repoEntry(raw: unknown, index: number, inherited: RepoPolicy): RepoConfig {
  const path = `repos[${index}]`;
  if (typeof raw === 'string') {
    const [owner, repo, ...rest] = raw.split('/');
    if (!owner || !repo || rest.length > 0) {
      throw new ConfigError(path, `must look like "owner/repo", got "${raw}"`);
    }
    return { ...inherited, owner, repo, slug: `${owner}/${repo}` };
  }
  if (!isRecord(raw)) throw new ConfigError(path, 'must be "owner/repo" or a mapping');

  let owner = str(raw['owner'], `${path}.owner`, '');
  let repo = str(raw['repo'], `${path}.repo`, '');
  const slug = str(raw['slug'], `${path}.slug`, '');
  if (slug) {
    const [slugOwner, slugRepo, ...rest] = slug.split('/');
    if (!slugOwner || !slugRepo || rest.length > 0) {
      throw new ConfigError(`${path}.slug`, `must look like "owner/repo", got "${slug}"`);
    }
    owner = owner || slugOwner;
    repo = repo || slugRepo;
  }
  if (!owner || !repo) {
    throw new ConfigError(path, 'needs either slug: "owner/repo" or both owner: and repo:');
  }

  return { ...policy(raw, path, inherited), owner, repo, slug: `${owner}/${repo}` };
}

export function loadConfig(configPath?: string): OjConfig {
  const path = resolve(configPath ?? process.env['OJ_CONFIG_PATH'] ?? 'oj-config.yaml');

  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Expected oj-config.yaml in the working ` +
        'directory, or set OJ_CONFIG_PATH.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : error}`);
  }

  const root = section(parsed, 'root');
  const github = section(root['github'], 'github');
  const paths = section(root['paths'], 'paths');
  const worker = section(root['worker'], 'worker');
  const review = section(root['review'], 'review');

  const globalMode = verdictMode(root['verdictMode'], 'verdictMode', DEFAULTS.verdictMode);
  // The house policy: DEFAULT_POLICY with the global verdictMode folded in, so
  // `verdictMode: full` at the top level reaches every repo that does not say
  // otherwise. Without this fold a repo would silently keep 'comment'.
  const housePolicy = policy(section(root['defaults'], 'defaults'), 'defaults', {
    ...DEFAULT_POLICY,
    verdictMode: globalMode,
  });

  const rawRepos = root['repos'];
  if (!Array.isArray(rawRepos) || rawRepos.length === 0) {
    throw new ConfigError('repos', 'must list at least one repository');
  }
  const repos = rawRepos.map((entry, index) => repoEntry(entry, index, housePolicy));

  const seen = new Set<string>();
  for (const entry of repos) {
    if (seen.has(entry.slug)) {
      throw new ConfigError('repos', `lists ${entry.slug} more than once`);
    }
    seen.add(entry.slug);
  }

  const config: OjConfig = {
    pollIntervalSeconds: num(
      root['pollIntervalSeconds'],
      'pollIntervalSeconds',
      DEFAULTS.pollIntervalSeconds,
      10,
    ),
    verdictMode: globalMode,
    maxConcurrentReviews: num(
      root['maxConcurrentReviews'],
      'maxConcurrentReviews',
      DEFAULTS.maxConcurrentReviews,
      1,
    ),
    github: {
      apiBaseUrl: str(github['apiBaseUrl'], 'github.apiBaseUrl', DEFAULTS.github.apiBaseUrl).replace(
        /\/+$/,
        '',
      ),
      gitBaseUrl: str(github['gitBaseUrl'], 'github.gitBaseUrl', DEFAULTS.github.gitBaseUrl).replace(
        /\/+$/,
        '',
      ),
    },
    paths: {
      workersRoot: resolve(str(paths['workersRoot'], 'paths.workersRoot', DEFAULTS.paths.workersRoot)),
      kickoffPrompt: resolve(
        str(paths['kickoffPrompt'], 'paths.kickoffPrompt', DEFAULTS.paths.kickoffPrompt),
      ),
      systemPrompt: resolve(
        str(paths['systemPrompt'], 'paths.systemPrompt', DEFAULTS.paths.systemPrompt),
      ),
      stateFile: resolve(str(paths['stateFile'], 'paths.stateFile', DEFAULTS.paths.stateFile)),
    },
    worker: {
      claudePath: str(worker['claudePath'], 'worker.claudePath', DEFAULTS.worker.claudePath),
      model: str(worker['model'], 'worker.model', DEFAULTS.worker.model),
      timeoutMinutes: num(worker['timeoutMinutes'], 'worker.timeoutMinutes', DEFAULTS.worker.timeoutMinutes, 1),
      fetchDepth: num(worker['fetchDepth'], 'worker.fetchDepth', DEFAULTS.worker.fetchDepth, 1),
      envPassthrough: strList(
        worker['envPassthrough'],
        'worker.envPassthrough',
        DEFAULTS.worker.envPassthrough,
      ),
      stripPaths: strList(worker['stripPaths'], 'worker.stripPaths', DEFAULTS.worker.stripPaths),
    },
    review: {
      acknowledgement: str(
        review['acknowledgement'],
        'review.acknowledgement',
        DEFAULTS.review.acknowledgement,
      ),
      workerTtlHours: num(
        review['workerTtlHours'],
        'review.workerTtlHours',
        DEFAULTS.review.workerTtlHours,
        0,
      ),
      inlineComments: bool(
        review['inlineComments'],
        'review.inlineComments',
        DEFAULTS.review.inlineComments,
      ),
    },
    repos,
  };

  // A worker that cannot be told what to do is worse than no worker: it would
  // still clone, still spawn, and produce an unstructured essay. Fail at boot.
  for (const promptPath of [config.paths.kickoffPrompt, config.paths.systemPrompt]) {
    if (!existsSync(promptPath)) {
      throw new Error(
        `Prompt file not found: ${promptPath}. ` +
          'OJ.md and prompts/worker-system-prompt.md ship with this repo — check ' +
          'paths.kickoffPrompt / paths.systemPrompt, or the service working directory.',
      );
    }
  }

  // envPassthrough is the one knob in this file that can hand a credential to
  // an agent reading untrusted code. Refuse the obvious mistake by name.
  const forbidden = config.worker.envPassthrough.filter((name) =>
    /^(GITHUB_TOKEN|GH_TOKEN|OJ_GITHUB_)/.test(name),
  );
  if (forbidden.length > 0) {
    throw new ConfigError(
      'worker.envPassthrough',
      `must not include GitHub credentials (${forbidden.join(', ')}). ` +
        'The worker reviews attacker-authored code and never needs GitHub access — ' +
        'OJO performs every GitHub operation itself.',
    );
  }

  return config;
}

/**
 * Credentials and deployment identity, from the environment.
 *
 * Two ways to authenticate, one interface (see `github.ts`). The App path is
 * strongly preferred: its tokens expire in an hour, its permissions are
 * per-repository, and its actions show up as the app rather than as a human
 * who did not do them.
 */
export type AuthEnv =
  | {
      kind: 'app';
      appId: string;
      installationId: string;
      privateKeyPath: string;
    }
  | {
      kind: 'pat';
      token: string;
    };

export function loadAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  const appId = env['OJ_GITHUB_APP_ID']?.trim();
  const installationId = env['OJ_GITHUB_INSTALLATION_ID']?.trim();
  const privateKeyPath = env['OJ_GITHUB_PRIVATE_KEY_PATH']?.trim();
  const token = env['OJ_GITHUB_TOKEN']?.trim() ?? env['GITHUB_TOKEN']?.trim();

  if (appId || installationId || privateKeyPath) {
    // Partial App config is a misconfiguration, never an intent to fall back.
    // Silently using a PAT because someone typo'd the installation id is how
    // you end up with reviews posted under a human's name for a month.
    const missing = [
      appId ? null : 'OJ_GITHUB_APP_ID',
      installationId ? null : 'OJ_GITHUB_INSTALLATION_ID',
      privateKeyPath ? null : 'OJ_GITHUB_PRIVATE_KEY_PATH',
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      throw new Error(
        `Incomplete GitHub App configuration — missing ${missing.join(', ')}. ` +
          'Set all three, or unset them all to fall back to OJ_GITHUB_TOKEN.',
      );
    }
    if (!existsSync(privateKeyPath as string)) {
      throw new Error(`GitHub App private key not found at ${privateKeyPath}`);
    }
    return {
      kind: 'app',
      appId: appId as string,
      installationId: installationId as string,
      privateKeyPath: privateKeyPath as string,
    };
  }

  if (token) return { kind: 'pat', token };

  throw new Error(
    'No GitHub credentials. Set OJ_GITHUB_APP_ID + OJ_GITHUB_INSTALLATION_ID + ' +
      'OJ_GITHUB_PRIVATE_KEY_PATH (preferred), or OJ_GITHUB_TOKEN for a quick start. ' +
      'See SETUP.md.',
  );
}
