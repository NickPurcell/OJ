# Setting up OJ

## Prerequisites

- **Node 22+**, **git**, and the **`claude` CLI** logged in as the user the
  service runs as (`claude auth`). Workers inherit that login; a user who has
  never run `claude` produces workers that fail on authentication, which shows
  up as every review timing out.
- Disk for the clones: one full checkout per open pull request under
  `/var/lib/oj/workers`.

## The GitHub App

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (the org's
   settings for an org). Name it; the name is the review author.
2. **Webhook**: untick Active. OJ polls.
3. **Repository permissions**, exactly these:

   | Permission | Level | Why |
   |---|---|---|
   | Contents | Read-only | clone the PR head; read `OJ.md` from the base branch |
   | Pull requests | Read & write | post reviews and comments; remove the trigger label |
   | Issues | Read & write | `oj issue`, for bugs outside the pull request's scope |
   | Metadata | Read-only | mandatory |

   Not Contents write: an app that cannot push cannot be talked into pushing.
4. **Where can this app be installed**: only on this account.
5. Create it. Note the **App ID** → `OJ_GITHUB_APP_ID`. **Generate a private
   key** and put it where only the service user can read it:

   ```sh
   sudo install -d -m 0700 -o npurcell -g npurcell /etc/oj
   sudo install -m 0400 -o npurcell -g npurcell ~/Downloads/oj.*.private-key.pem /etc/oj/oj-app.private-key.pem
   ```

   → `OJ_GITHUB_PRIVATE_KEY_PATH`.
6. **Install App** → only the repositories you want reviewed. The installation
   id is in the URL of the installation's settings page → `OJ_GITHUB_INSTALLATION_ID`.
7. Put all three in `.env`. A missing one is a startup error.

If minting a token fails with a 401, it is the private key or the host clock;
OJ backdates `iat` by 60 s, so more than a minute of skew needs NTP fixed.

## Install

On the Clawcius host, OJ is deployed by the same deployer as Clawcius: `sudo deploy oj`
builds `origin/main` into `/srv/oj/releases/<sha>`, points `/srv/oj/current` at it, installs
`systemd/oj.service` and restarts it. The unit runs from `/srv/oj/current` and reads
`/etc/clawcius/oj.env`. State lives in `/var/lib/oj`.

Elsewhere:

```sh
git clone https://github.com/NickPurcell/OJ.git && cd OJ
npm install && npm run build && npm test
sudo install -d -m 0750 -o npurcell -g npurcell /var/lib/oj
```

## Configure

`oj-config.yaml`:

```yaml
label: "oj:review"
reviewNewPrs: true      # review every newly opened PR; older ones need the label
approve: false          # start here; see Branch protection before flipping it
repos:
  - owner/repo
```

`worker.claudePath` must be the `claude` on the service user's PATH.

## Run it under systemd

```sh
sudo cp systemd/oj.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oj
journalctl -u oj -f
```

The unit runs as `npurcell` from `/srv/oj/current`, reads `/etc/clawcius/oj.env`, and
sets `NODE_USE_ENV_PROXY=1` so Node honours a proxy.

## Branch protection

Read this before `approve: true`.

**Dismiss stale approvals — mandatory.** Settings → Branches → your default
branch → Require a pull request before merging → **Dismiss stale pull request
approvals when new commits are pushed.** Without it, OJ approves, the author
pushes three more commits, and the approval stays attached to code no reviewer
saw. With it, every push clears the approval and the label has to be re-added.

**CODEOWNERS — recommended.** Name humans in a `CODEOWNERS` file and require
review from code owners, so OJ's approval is never the load-bearing one. A
repository with "1 approval required" and OJ installed is a repository where OJ
can merge things; decide that on purpose.

**Also:** require status checks to pass (OJ's review is not one), and do not
grant the app "bypass branch protections".

## Per-repository instructions

Put an `OJ.md` on the base branch of a watched repository. It is read from
there — never from the pull request's head — and handed to the reviewer as
`<repo-instructions>`. This repository's own `OJ.md` is an example.

## Operating it

**Ask for a review**: add the label. **Ask again**: add it again; OJ removes it
when it starts. The session persists, so round two knows what round one said.

**Watch**: `journalctl -u oj -f`; lines are prefixed `owner/repo#123`.

**Inspect**: `/var/lib/oj/workers/<owner>__<repo>__<n>/` holds the clone, the
exact rendered prompt (`oj/kickoff-round-N.md`), the `oj` shim and the Stop
hook (`bin/`), and the desk (`desk/requests`, `desk/results`, empty between
rounds; `desk/posted-round-N` once a comment landed).

**Reset one**: delete the directory. To also drop the conversation, delete the
Claude Code transcript under `~/.claude/projects/` keyed by that directory.

**Stop**: `systemctl stop oj`; in-flight workers die with it and their PRs can
be re-labelled.

## Troubleshooting

**Nothing happens on the label.** The name must match `label` exactly; the repo
must be in `repos`; the App installation must include it (a repo outside the
installation returns 404, and the journal says `could not list pull requests`).

**`EAI_AGAIN` / "Could not resolve host" but `curl` works.** Node ignores the
proxy variables unless `NODE_USE_ENV_PROXY=1` is set; the unit sets it.

**403 with rate-limit budget remaining** is a permissions problem: check the
installation's repository access.

**Every review times out** with no `tool …` lines in the journal: Anthropic
auth. Run `claude -p "say ok"` as the service user.

**`said-nothing`.** The session ended without `oj comment`, even after the Stop
hook told it to post. Read `oj/kickoff-round-N.md` and the transcript. `oj
comment: REFUSED` in the journal names the reason; `tool N Bash FAILED …
requires approval` means the permission system refused the post.

**"OJ is rate-limited"** on the PR: the round hit the API limit before posting.
OJ retries by itself after the reset; no re-label needed.

**`npm run build` prints nothing and exits non-zero.** Look for a
`node_modules` symlink pointing at itself; `rm -rf dist` before trusting a
green run.

**A review posted as COMMENT when APPROVE was expected.** The journal prints
`verdict none` if the worker never ran `oj verdict`; `approve: false` caps
everything; and GitHub refuses to let an account approve its own pull request.
