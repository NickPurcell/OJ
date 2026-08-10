# Setting up OJ

Everything here assumes one host that runs OJO and its workers. Nothing is
distributed and nothing needs an inbound port — the host reaches out to GitHub
on a timer, which is why this works behind NAT.

- [Prerequisites](#prerequisites)
- [Authentication](#authentication)
  - [Creating the GitHub App](#creating-the-github-app)
  - [Personal access token, for a five-minute start](#personal-access-token-for-a-five-minute-start)
- [Install](#install)
- [Configure](#configure)
- [Run it under systemd](#run-it-under-systemd)
- [Branch protection](#branch-protection)
- [Per-repository instructions](#per-repository-instructions)
- [Turning on real verdicts](#turning-on-real-verdicts)
- [Operating it](#operating-it)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Node 22+**. `node --version`.
- **git**, on the PATH of the user the service runs as.
- **The `claude` CLI**, logged in as that same user: `claude auth` or
  `claude setup-token`. Workers inherit that login, so a user who has never run
  `claude` interactively produces workers that fail on authentication — which
  shows up as every review timing out, not as an auth error.
- Disk for the clones. Each open pull request under review gets a full
  checkout under `/var/lib/oj/workers`. Budget repo size × concurrent open PRs.

## Authentication

Two ways in, one interface. The App is strongly preferred and the PAT exists so
you can see a review land before committing to twenty minutes of setup.

### Creating the GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**. For
   an org, that is the org's settings, not yours.

2. **Name**: anything; it becomes the review author, so pick what you want
   people to see. **Homepage URL**: this repository is fine.

3. **Webhook**: untick **Active**. OJ polls. Leaving a webhook configured
   creates an endpoint that fails every delivery and eventually gets disabled
   with an email, which is noise about a thing you were not using.

4. **Repository permissions** — exactly these three:

   | Permission | Level | Why |
   |---|---|---|
   | **Contents** | Read-only | clone the PR head; read `OJ.md` from the base branch |
   | **Pull requests** | Read & write | post reviews and comments; remove the trigger label |
   | **Metadata** | Read-only | mandatory, granted automatically |

   Nothing else. In particular **not** Contents write: OJ does not push, and an
   app that cannot push is an app that cannot be talked into pushing. If you
   ever find yourself adding a permission to make something work, that is worth
   a conversation rather than a checkbox.

   Note what `Pull requests: write` includes — it can post reviews, and a review
   is an approval when it wants to be. That is the permission that makes
   [branch protection](#branch-protection) matter.

5. **Where can this app be installed**: "Only on this account" unless you have
   a reason.

6. Create it. On the app's page:
   - note the **App ID** (top of the page) → `OJ_GITHUB_APP_ID`
   - **Generate a private key**. A `.pem` downloads; this is the only copy.
     Put it somewhere the service user can read and nobody else can:

     ```sh
     sudo install -d -m 0700 -o npurcell -g npurcell /etc/oj
     sudo install -m 0400 -o npurcell -g npurcell ~/Downloads/oj.*.private-key.pem \
       /etc/oj/oj-app.private-key.pem
     ```

     → `OJ_GITHUB_PRIVATE_KEY_PATH`. This key signs the JWT that mints
     installation tokens, so a copy of it is a copy of every permission the app
     has. It is in `.gitignore` as `*.pem`; keep it out of the tree anyway.

7. **Install App** → choose the account → **Only select repositories** → pick
   the ones you want reviewed. Installing on "All repositories" grants the app
   on everything you will ever create, which is a different decision than the
   one you are making today.

8. Get the **installation id**. It is in the URL of the installation's settings
   page — `.../installations/<id>` — or:

   ```sh
   # needs a JWT; easiest is to read it off the settings URL
   ```

   → `OJ_GITHUB_INSTALLATION_ID`.

9. Put all three in `.env`. Partial configuration is a startup error on
   purpose: a typo'd installation id must not silently fall back to a PAT and
   post a month of reviews under a human's name.

**If minting a token fails with a 401**, the two causes are the private key and
the host clock. The JWT is time-sensitive and OJ already backdates `iat` by 60
seconds; if the host is more than a minute out, fix NTP.

### Personal access token, for a five-minute start

Use a **fine-grained** token from
[Settings → Developer settings → Personal access tokens](https://github.com/settings/personal-access-tokens),
scoped to only the repositories you want reviewed, with **Contents: read** and
**Pull requests: read and write**.

```
OJ_GITHUB_TOKEN=github_pat_...
```

The costs, plainly: it does not expire unless you make it, every review is
attributed to you, and its rate limit is shared with everything else you do on
that account. Move to the App when you stop experimenting.

## Install

```sh
git clone https://github.com/NickPurcell/OJ.git /home/npurcell/oj
cd /home/npurcell/oj
npm install
npm run build

sudo install -d -m 0750 -o npurcell -g npurcell /var/lib/oj
cp .env.example .env && chmod 600 .env
$EDITOR .env
```

## Configure

Edit `oj-config.yaml`. The minimum is the repository list:

```yaml
repos:
  - NickPurcell/OJ
```

Then create the label in each watched repository — GitHub will not invent it
for you, and a label that does not exist is one nobody can add:

```sh
gh label create "oj:review" --repo NickPurcell/OJ \
  --color 5319e7 --description "Ask OJ for a code review"
```

Run it in the foreground once before making it a service:

```sh
node dist/index.js
```

The startup banner names the auth mode, the acting account, every watched
repository and its effective policy. If the account is not what you expected,
stop now — that is the account whose approvals will start appearing.

Add the label to a pull request. Within one poll interval you should see an
acknowledgement comment, then a directory appear under `/var/lib/oj/workers`,
then several minutes of `tool …` lines, then a review.

## Run it under systemd

`systemd/oj.service` assumes `/home/npurcell/oj` and the user `npurcell`. Edit
both, plus the `PATH`, which must contain the directory holding your `node` —
systemd's default PATH does not include `~/.local`, and workers spawn bare
`node` and `git` as children.

```sh
sudo cp systemd/oj.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oj
journalctl -u oj -f
```

Why it runs as a human user and not a service account: workers authenticate to
Anthropic with the OAuth credentials in that user's home directory. A service
account with no `claude` login spawns workers that cannot authenticate. Use a
dedicated user only if you also set `ANTHROPIC_API_KEY`.

## Branch protection

Read this before setting `verdictMode: full`.

### Dismiss stale approvals — mandatory

**Settings → Branches → your default branch → Require a pull request before
merging → tick "Dismiss stale pull request approvals when new commits are
pushed."**

This is not a recommendation. It is the setting that makes an automated
approver safe, and here is the sequence it prevents:

1. OJ reviews a pull request, finds nothing blocking, and approves.
2. The author pushes three more commits.
3. The pull request still shows an approval.

That approval is now attached to code no reviewer ever saw — human or
otherwise. It was earned by an earlier revision and is being spent by a later
one. The failure is worse with a bot than with a person, because the bot
approves fast and often, so the window between "approved" and "changed" is
where most of the day's commits land. With the setting on, every push clears
the approval and the label has to be re-added, which is exactly the behaviour
you want: a fix that arrives after a review gets reviewed.

The same argument applies to a human reviewer. Most teams that turn this on
find it should have been on already.

### CODEOWNERS — strongly recommended

Add a `CODEOWNERS` file naming humans, and tick **"Require review from Code
Owners."**

The point is to make OJ's approval never the load-bearing one. With code owners
required, a pull request needs a human's approval regardless of what OJ said;
OJ's review becomes a signal that arrives early and cheaply, not a gate that
can be satisfied by a language model having a good day.

```
# CODEOWNERS
*           @NickPurcell
/src/       @NickPurcell
```

Without this, a repository with "1 approval required" and OJ installed is a
repository where OJ can merge things. That may be what you want on a personal
project. Decide it on purpose.

### Other settings worth having

- **Require status checks to pass.** OJ's review is not a status check and does
  not gate anything by itself.
- **Do not** grant the app "bypass branch protections". It has no reason to
  merge anything.

## Per-repository instructions

Put an `OJ.md` on the **base branch** of a watched repository to give it
specific instructions — the architecture worth knowing, the invariants that
matter, the dimensions to weigh heavily, the things that look like bugs and are
not.

```markdown
# OJ instructions for this repository

Every network call must go through `src/http.ts`; a direct `fetch` is blocking.
The `legacy/` tree is frozen — report problems there as non-blocking.
Migrations in `db/migrate/` must be reversible. Check it.
```

It is read with `git show refs/oj/base:OJ.md` and pasted into the worker's
kickoff inside a `<repo-instructions>` block. Because it comes from the base
branch, a pull request cannot edit the instructions its own reviewer follows —
see README § Security model. A change to `OJ.md` takes effect once it is
merged, which means changes to it get reviewed like any other change. That is
the point.

## Turning on real verdicts

The default is `verdictMode: comment`: every review posts as a COMMENT and the
footer says what the verdict would have been.

Run it that way for a few dozen reviews across real pull requests. Then read
back through them and ask one question — *would I have agreed with the footer?*
Not "was the review useful", which flatters it, but specifically: would you have
been happy for that APPROVE to be real, and would that REQUEST_CHANGES have
been a fair thing to do to someone at 5pm on a Friday.

When the answer is yes:

```yaml
verdictMode: full
```

Per-repository is finer and better. Turn it on for one repository first,
ideally one where you are the only author:

```yaml
repos:
  - slug: NickPurcell/OJ
    verdictMode: full
```

And confirm [branch protection](#branch-protection) is set before you do.

## Operating it

**Ask for a review**: add the label. **Ask again**: add it again — OJ removes it
when it starts, so the label is always a fresh request. The session persists, so
round two knows what round one said and will tell you what got fixed.

**Watch one**: `journalctl -u oj -f`. Lines are prefixed `owner/repo#123`.

**Inspect one**: `/var/lib/oj/workers/<owner>__<repo>__<n>/` holds the clone,
the exact rendered prompt (`oj/kickoff-round-N.md`), and the report
(`oj/report.json`). When a review comes back strange, the kickoff file answers
"what was it actually asked?" without re-deriving it.

**Reset one**: delete the directory. The next round rebuilds it. To also drop
the conversation, delete the Claude Code session — the session id is a UUIDv5
of `owner/repo#number` and the transcript lives under `~/.claude/projects/`
keyed by that directory path.

**Stop reviewing a repo**: remove it from `oj-config.yaml` and restart. To stop
everything, `systemctl stop oj`; in-flight workers die with it, and their PRs
can be re-labelled later.

## Troubleshooting

**Nothing happens when I add the label.** Check the name matches
`reviewLabel` exactly, including the colon. Check the repository is in
`repos:`. Check the App installation includes it — an app installed on "select
repositories" silently returns 404 for the others, and the journal will say
`could not list pull requests`.

**Everything fails with `EAI_AGAIN` or "Could not resolve host: github.com",
but `curl` works.** The host reaches the internet through a proxy and Node's
`fetch` does not read `HTTP_PROXY`/`HTTPS_PROXY` unless told to. Set
`NODE_USE_ENV_PROXY=1` — the systemd unit and `npm start` both do, and OJO
warns at startup when a proxy is configured and this is not set. OJO forwards
the proxy variables to git and to the workers itself, so this is the only knob.

**"could not list pull requests — GitHub GET … → 403"** with rate limit budget
remaining is a permissions problem wearing a rate limit's status code. Check
the installation's repository access.

**Every review times out.** Almost always Anthropic auth. Run
`claude -p "say ok"` as the service user; if that fails, so will every worker.
The journal shows no `tool …` lines at all in this case, which distinguishes it
from a review that is merely slow.

**"the worker exited cleanly without writing …/report.json".** The session ran
and decided it was done without producing the file. Read
`oj/kickoff-round-N.md` and the transcript. Usually the kickoff was edited into
something ambiguous about the output contract.

**Reviews come back empty on a big PR.** Check `notes` in the posted review —
workers are told to say what they could not check. Consider raising
`worker.timeoutMinutes`, or asking for the pull request to be split, which is
also a fair review comment.

**A review posted as COMMENT when I expected APPROVE.** Read the footer. It
says whether the verdict was capped by `verdictMode`, and `verdictMode` is
resolved per repository — a global `full` with a repo-level override loses to
the override.

**Findings have no line numbers.** GitHub rejected them as inline comments
because a line was not part of the diff, and OJ reposted with the locations in
a follow-up comment. The journal line says `inline comments rejected`.
