/**
 * What OJO remembers between ticks, and across restarts.
 *
 * Small enough to be a JSON file rather than a database. The whole state is a
 * few hundred bytes per open PR, it is written a handful of times a minute,
 * and — importantly — a human debugging a stuck review should be able to `cat`
 * it. SQLite would buy durability guarantees that do not matter here, because
 * everything in this file is reconstructible: worst case OJO forgets a session
 * and starts a fresh one, which costs a warm cache and nothing else.
 *
 * The one thing that would be genuinely bad to lose is `baselinePr`, and it is
 * called out below.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PrRecord = {
  slug: string;
  number: number;
  /** Absolute path to the per-PR directory. Deleted when the PR closes. */
  workerDir: string;
  /** Deterministic per PR — see `sessionIdFor` in worker.ts. Stored for the log. */
  sessionId: string;
  /** How many review rounds have run. Round 1 starts the session; later rounds resume it. */
  rounds: number;
  /** Head SHA of the last completed review, so an unchanged PR is not re-reviewed. */
  lastReviewedHeadSha: string | null;
  createdAt: number;
  lastActivityAt: number;
};

export type RepoRecord = {
  /**
   * The highest PR number that existed the first time OJO saw this repo.
   *
   * `reviewNewPrs` means "review PRs that open from now on", and without a
   * baseline the first tick after enabling it would fan out across every open
   * PR in the repo at once. Losing this value re-baselines to whatever is open
   * now, which is a quiet non-event; losing it *and* having it default to zero
   * would be forty simultaneous reviews.
   */
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
        // A corrupt state file is recoverable — everything in it can be
        // rebuilt — but silently starting from empty would re-baseline every
        // repo and, with reviewNewPrs on, review the world. Say it loudly.
        process.stderr.write(
          `[oj] state file at ${this.path} is unreadable (${String(error)}) — starting empty. ` +
            'reviewNewPrs will re-baseline against the currently open PRs.\n',
        );
      }
      return { version: 1, prs: {}, repos: {} };
    }
  }

  /**
   * Write via a temp file and rename.
   *
   * Rename is atomic within a filesystem, so a crash mid-write leaves the old
   * state intact rather than a truncated file that the next boot treats as
   * corrupt — which, per the comment above, is the expensive kind of loss.
   */
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

  /**
   * The baseline for `reviewNewPrs`, establishing it on first sight.
   *
   * `highestOpenPr` is what OJO can see right now. On a repo it has never
   * watched, everything at or below that number is pre-existing and is left
   * for a human to request with the label.
   */
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
