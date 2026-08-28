import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_GIT = 'https://github.com';

export type RepoConfig = { owner: string; repo: string; slug: string };

export type OjConfig = {
  pollIntervalSeconds: number;
  /** Reviews running at once, across all repos. Each one is a Claude Code process. */
  maxConcurrentReviews: number;
  /** The label that asks for a round; removed when the round starts. */
  label: string;
  /** Review a PR the first time it is seen, without waiting for the label. */
  reviewNewPrs: boolean;
  /** false: every review posts as a COMMENT. true: clean → APPROVE, blocking → REQUEST_CHANGES. */
  approve: boolean;
  paths: {
    /** One directory per PR lives under here. Deleted when the PR closes. */
    workersRoot: string;
    kickoffPrompt: string;
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
    /** Deleted from the checkout before the reviewer sees it: files that would read as instructions. */
    stripPaths: string[];
  };
  repos: RepoConfig[];
};

const DEFAULTS = {
  pollIntervalSeconds: 60,
  maxConcurrentReviews: 2,
  label: 'oj:review',
  reviewNewPrs: false,
  approve: false,
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

function num(raw: unknown, path: string, fallback: number, min: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new ConfigError(path, 'must be a number');
  if (raw < min) throw new ConfigError(path, `must be >= ${min}`);
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

function repoEntry(raw: unknown, index: number): RepoConfig {
  const path = `repos[${index}]`;
  if (typeof raw !== 'string') throw new ConfigError(path, 'must be "owner/repo"');
  const [owner, repo, ...rest] = raw.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new ConfigError(path, `must look like "owner/repo", got "${raw}"`);
  }
  return { owner, repo, slug: `${owner}/${repo}` };
}

export function loadConfig(configPath?: string): OjConfig {
  const path = resolve(configPath ?? process.env['OJ_CONFIG_PATH'] ?? 'oj-config.yaml');
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}. Expected oj-config.yaml in the working directory, or set OJ_CONFIG_PATH.`);
  }
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : error}`);
  }
  const root = section(parsed, 'root');
  const paths = section(root['paths'], 'paths');
  const worker = section(root['worker'], 'worker');

  const rawRepos = root['repos'];
  if (!Array.isArray(rawRepos) || rawRepos.length === 0) {
    throw new ConfigError('repos', 'must list at least one repository');
  }
  const repos = rawRepos.map(repoEntry);
  const seen = new Set<string>();
  for (const entry of repos) {
    if (seen.has(entry.slug)) throw new ConfigError('repos', `lists ${entry.slug} more than once`);
    seen.add(entry.slug);
  }

  const config: OjConfig = {
    pollIntervalSeconds: num(root['pollIntervalSeconds'], 'pollIntervalSeconds', DEFAULTS.pollIntervalSeconds, 10),
    maxConcurrentReviews: num(root['maxConcurrentReviews'], 'maxConcurrentReviews', DEFAULTS.maxConcurrentReviews, 1),
    label: str(root['label'], 'label', DEFAULTS.label),
    reviewNewPrs: bool(root['reviewNewPrs'], 'reviewNewPrs', DEFAULTS.reviewNewPrs),
    approve: bool(root['approve'], 'approve', DEFAULTS.approve),
    paths: {
      workersRoot: resolve(str(paths['workersRoot'], 'paths.workersRoot', DEFAULTS.paths.workersRoot)),
      kickoffPrompt: resolve(str(paths['kickoffPrompt'], 'paths.kickoffPrompt', DEFAULTS.paths.kickoffPrompt)),
      systemPrompt: resolve(str(paths['systemPrompt'], 'paths.systemPrompt', DEFAULTS.paths.systemPrompt)),
      stateFile: resolve(str(paths['stateFile'], 'paths.stateFile', DEFAULTS.paths.stateFile)),
    },
    worker: {
      claudePath: str(worker['claudePath'], 'worker.claudePath', DEFAULTS.worker.claudePath),
      model: str(worker['model'], 'worker.model', DEFAULTS.worker.model),
      timeoutMinutes: num(worker['timeoutMinutes'], 'worker.timeoutMinutes', DEFAULTS.worker.timeoutMinutes, 1),
      fetchDepth: num(worker['fetchDepth'], 'worker.fetchDepth', DEFAULTS.worker.fetchDepth, 1),
      stripPaths: strList(worker['stripPaths'], 'worker.stripPaths', DEFAULTS.worker.stripPaths),
    },
    repos,
  };

  for (const promptPath of [config.paths.kickoffPrompt, config.paths.systemPrompt]) {
    if (!existsSync(promptPath)) {
      throw new Error(`Prompt file not found: ${promptPath}. Check paths.kickoffPrompt / paths.systemPrompt, or the service working directory.`);
    }
  }
  return config;
}

export type AuthEnv = { appId: string; installationId: string; privateKeyPath: string };

export function loadAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  const appId = env['OJ_GITHUB_APP_ID']?.trim();
  const installationId = env['OJ_GITHUB_INSTALLATION_ID']?.trim();
  const privateKeyPath = env['OJ_GITHUB_PRIVATE_KEY_PATH']?.trim();
  const missing = [
    appId ? null : 'OJ_GITHUB_APP_ID',
    installationId ? null : 'OJ_GITHUB_INSTALLATION_ID',
    privateKeyPath ? null : 'OJ_GITHUB_PRIVATE_KEY_PATH',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(`GitHub App configuration is missing ${missing.join(', ')}. See SETUP.md.`);
  }
  if (!existsSync(privateKeyPath as string)) {
    throw new Error(`GitHub App private key not found at ${privateKeyPath}`);
  }
  return { appId: appId as string, installationId: installationId as string, privateKeyPath: privateKeyPath as string };
}
