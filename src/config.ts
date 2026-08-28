
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export type VerdictMode = 'comment' | 'full';

/** Per-repo knobs. Every one of these has a global default. */
export type RepoPolicy = {
  reviewLabel: string;
  /** Review a PR the first time OJO sees it, without waiting for the label. */
  reviewNewPrs: boolean;
  /** Draft PRs are usually still being written. Off by default. */
  reviewDrafts: boolean;
  /** Review PRs whose head lives in a fork. */
  reviewForks: boolean;
  approveWhenClean: boolean;
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
    stateFile: string;
  };

  worker: {
    claudePath: string;
    /** Model alias or full name. Empty string means "whatever the CLI defaults to". */
    model: string;
    timeoutMinutes: number;
    /** Commits fetched for the PR head and its base. */
    fetchDepth: number;
    /** Extra environment variables the worker is allowed to inherit. */
    envPassthrough: string[];
    stripPaths: string[];
  };

  review: {
    acknowledgement: string;
    maxCommentsPerRound: number;
    maxIssuesPerRound: number;
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
    kickoffPrompt: 'prompts/kickoff.md',
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
    maxCommentsPerRound: 10,
    maxIssuesPerRound: 5,
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

/** Read the per-repo policy block, inheriting anything it does not state. */
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

/** `owner/repo`, or an entry that names them separately. */
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
      maxCommentsPerRound: num(
        review['maxCommentsPerRound'],
        'review.maxCommentsPerRound',
        DEFAULTS.review.maxCommentsPerRound,
        1,
      ),
      maxIssuesPerRound: num(
        review['maxIssuesPerRound'],
        'review.maxIssuesPerRound',
        DEFAULTS.review.maxIssuesPerRound,
        0,
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
          'prompts/kickoff.md and prompts/worker-system-prompt.md ship with this repo — check ' +
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
