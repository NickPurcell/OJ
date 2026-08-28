# OJ

A pull request reviewer. **OJO** watches your repositories; when a review is
wanted it clones the pull request into its own directory and wakes an **OJ
worker** — a headless Claude Code session that lives as long as the PR does —
which reviews the diff and posts what it found. The worker holds no credential:
it asks, OJO performs.

```
                    OJO (holds the credential)
   GitHub  ───poll──→  │
                       ├─ fetch refs/pull/N/head + refs/heads/<base>
                       ├─ strip instruction files from the checkout
                       ├─ read OJ.md from the BASE branch
                       │
                       ├─ spawn ─→  OJ worker  (no credential, no GitHub)
                       │              │            reviews the diff
                       │   desk ←─────┤  oj comment / verdict / issue / pr
                       │     │        └──── blocks on the answer, reacts to it
   GitHub  ←──post───  └─────┘
```

## Security model

**The worker never gets a credential.** A reviewer reads code written by people
it has no reason to trust, so a prompt-injected worker is the normal case. An
injected worker with no credential can waste tokens and post noise on the pull
request it was already reviewing; one with a token could push.

**The worker cannot name a target.** `oj` says "post this", never "post this
*there*". A request carrying a repository, owner, PR number or URL is refused;
identity comes from which desk the request arrived in, and OJO created that
desk for the review it decided to run.

**Instructions come from the base branch only.** A repository's `OJ.md` is read
with `git show refs/oj/base:OJ.md`, never from the checked-out head, so a pull
request cannot write its own review instructions.

**The checkout is scrubbed.** `CLAUDE.md`, `.claude/`, `OJ.md`, `AGENTS.md` and
friends (`worker.stripPaths`) are deleted after checkout and marked `-diff` in
`.git/info/attributes`, so their contents reach the worker neither on disk nor
through the diff. That such a file changed is itself reportable.

**The worker is spawned narrow.** `--setting-sources user`,
`--strict-mcp-config` with no MCP servers, a permission deny-list for `git push`
and `gh`, an environment built from an allowlist and checked against the live
token, and the standing rules appended as a system prompt so they survive
compaction.

**What this does not protect against.** The worker runs as the same OS user as
OJO, with `HOME`, so same-user separation is not a boundary: if you watch
repositories that accept pull requests from strangers, run the worker as its
own user or in a container. The worker runs the repository's own tooling by
design. An injected worker can post up to ten comments and open up to five
issues on the pull request it is reviewing. The review is a language model's
opinion; what OJO enforces is the verdict: a missing verdict is a COMMENT and
never an APPROVE, and `approve: false` caps everything.

## How it behaves

**Triggers** on the label (`oj:review`), which OJO removes when it starts —
re-adding it after a push asks for another round. Optionally also on any
newly-opened PR (`reviewNewPrs`), baselined on first sight of a repo.

**Acknowledges immediately**, then **stays warm**: one session per pull
request, resumed across rounds by a UUIDv5 of `owner/repo#number`. A later
round gets the measurements of the new diff and is told to read the author's
replies first, re-run the whole checklist on the fix commits, and then say of
each earlier finding whether it was fixed, answered with prose, or is still open.

**Posts or fails.** A Claude Code Stop hook refuses the first attempt to end a
round without a posted review. A round that still posts nothing fails on the
pull request with a reason (`timeout`, `said-nothing`, `spawn-failed`); a round
that hit the API rate limit retries by itself after the reset.

**Files what is out of scope** as issues, as it goes. **Cleans up** the
directory when the PR closes.

## Verdicts

| `oj verdict` | `approve: true` | `approve: false` |
|---|---|---|
| `clean` | APPROVE | COMMENT |
| `blocking` | REQUEST_CHANGES | COMMENT |
| never run | COMMENT | COMMENT |

Read SETUP.md § Branch protection before setting `approve: true`.

## Configuration

| File | Holds |
|---|---|
| `oj-config.yaml` | Watched repos, poll interval, label, `approve`, paths, worker settings |
| `prompts/kickoff.md` | The prompt every round starts from |
| `prompts/worker-system-prompt.md` | Standing rules appended to the system prompt |
| `OJ.md` | This repository's own house rules, read from its base branch like any watched repo's |
| `.env` | GitHub App id, installation id, private key path (not committed) |

## Quickstart

```sh
git clone https://github.com/NickPurcell/OJ.git ~/oj && cd ~/oj
npm install && npm run build   # OJO and the oj CLI the worker uses
npm test
cp .env.example .env           # GitHub App credentials, see SETUP.md
$EDITOR oj-config.yaml         # the repos to watch
node dist/index.js
```

Then add the `oj:review` label to a pull request. Requires Node 22+, git, and a
`claude` CLI logged in as the user running the service.
