
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PrRecord = {
  slug: string;
  number: number;
  /** Absolute path to the per-PR directory. Deleted when the PR closes. */
  workerDir: string;
  /** Deterministic per PR — see `sessionIdFor` in worker.ts. Stored for the log. */
  sessionId: string;
  rounds: number;
  lastReviewedHeadSha: string | null;
  retryAfter: number | null;
  createdAt: number;
  lastActivityAt: number;
};

export type RepoRecord = {
  baselinePr: number;
  firstSeenAt: number;
};

type StateFile = {
  version: 1;
  prs: Record<string, PrRecord>;
  repos: Record<string, RepoRecord>;
};

export function prKey(slug: string, number: number): string {
  return `${slug}#${number}`;
}

export class StateStore {
  #state: StateFile;

  constructor(private readonly path: string) {
    this.#state = this.#read();
  }

  #read(): StateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StateFile>;
      return {
        version: 1,
        prs: parsed.prs ?? {},
        repos: parsed.repos ?? {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        process.stderr.write(
          `[oj] state file at ${this.path} is unreadable (${String(error)}) — starting empty. ` +
            'reviewNewPrs will re-baseline against the currently open PRs.\n',
        );
      }
      return { version: 1, prs: {}, repos: {} };
    }
  }

  /** Write via a temp file and rename. */
  #write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(slug: string, number: number): PrRecord | undefined {
    return this.#state.prs[prKey(slug, number)];
  }

  put(record: PrRecord): void {
    this.#state.prs[prKey(record.slug, record.number)] = record;
    this.#write();
  }

  /** Bump the activity clock without rewriting the rest of the record. */
  touch(slug: string, number: number): void {
    const record = this.get(slug, number);
    if (!record) return;
    record.lastActivityAt = Date.now();
    this.#write();
  }

  remove(slug: string, number: number): void {
    delete this.#state.prs[prKey(slug, number)];
    this.#write();
  }

  all(): PrRecord[] {
    return Object.values(this.#state.prs);
  }

  forRepo(slug: string): PrRecord[] {
    return this.all().filter((record) => record.slug === slug);
  }

  /** The baseline for `reviewNewPrs`, establishing it on first sight. */
  baselineFor(slug: string, highestOpenPr: number): number {
    const existing = this.#state.repos[slug];
    if (existing) return existing.baselinePr;

    this.#state.repos[slug] = { baselinePr: highestOpenPr, firstSeenAt: Date.now() };
    this.#write();
    process.stdout.write(
      `[oj] ${slug}: first sight — baselining reviewNewPrs at #${highestOpenPr}. ` +
        'Older open PRs need the label.\n',
    );
    return highestOpenPr;
  }
}
