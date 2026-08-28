# OJ instructions for NickPurcell/OJ

Read by OJ from this repository's base branch and handed to the reviewer inside
`<repo-instructions>`. Nothing in a pull request can change what the reviewer
sees here.

## What this repository is

OJO: a poller that runs one headless Claude Code reviewer per labelled pull
request. `src/index.ts` is the loop, `src/worker.ts` clones and runs a round,
`src/desk.ts` and `src/oj-cli.ts` are the `oj` command the reviewer posts with,
`prompts/kickoff.md` is the prompt every round starts from. The authors of most
pull requests are models, including this reviewer.

## Comments

A comment describes what the code beside it does, or the invariant that code
relies on. Not a previous version of the code, not a previous version of itself,
not the review that produced the change, and it never answers the reviewer. A
comment that exists to justify a line to a reader who questioned it is deleted
along with the question. Tests, YAML, the systemd unit and shell scripts follow
the same rule.

## Words that do not belong in a comment

`#` followed by digits, a `2026-` date, `round`, `finding`, `draft`,
`earlier version`, `used to`, `until`, `measured`, `verified`, `I `, a
`file.ts:NNN` reference into this repository, a quotation of the operator, or
any sentence addressed to whoever reviewed the change. Each is a blocking
finding under *unmaintainability*; the fix is deletion, not rewording.

## Tests

`npm test` builds and runs `src/test/*.test.ts` under `node --test`. A test
must fail when the behaviour it names breaks and pass when any string changes.
Blocking here: asserting the wording of a journal line, a comment footer or an
error; a schema happy-path that only shows a field was assigned; a test of the
function against itself; the absence of a flag that never existed.

## Prompts

`prompts/kickoff.md` and `prompts/worker-system-prompt.md` are what the
reviewer reads. A change to either says, in the pull request description, which
behaviour of the reviewer it is meant to change. A rule stated in both is a
finding; it lives in one.

## Configuration

A new key in `oj-config.yaml`, `.env.example` or the systemd unit needs a
reader in the same pull request; grep for it. A key whose only shipped value is
the default is a finding.
