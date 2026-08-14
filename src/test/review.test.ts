/**
 * What a verdict is allowed to become.
 *
 * The one rule here that is not a preference: a missing verdict never approves.
 * A worker can fail to run `oj verdict` for a dozen boring reasons, and every
 * one of them must land on COMMENT.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RepoConfig, VerdictMode } from '../config.js';
import type { Verdict } from '../desk.js';
import type { PullRequest } from '../github.js';
import { commentFooter, decideEvent } from '../review.js';

function repoWith(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    owner: 'NickPurcell',
    repo: 'OJ',
    slug: 'NickPurcell/OJ',
    reviewLabel: 'oj:review',
    reviewNewPrs: false,
    reviewDrafts: false,
    reviewForks: false,
    approveWhenClean: true,
    requestChangesWhenBlocking: true,
    verdictMode: 'full' as VerdictMode,
    ...overrides,
  };
}

const pull = { number: 7, authorLogin: 'someone', headSha: 'abcdef1234' } as PullRequest;

describe('decideEvent', () => {
  it('never approves without a verdict', () => {
    for (const mode of ['full', 'comment'] as VerdictMode[]) {
      const decision = decideEvent(null, repoWith({ verdictMode: mode }), pull, 'oj[bot]');
      assert.equal(decision.event, 'COMMENT');
      assert.equal(decision.wanted, 'COMMENT');
      // Nothing was capped: COMMENT is what a missing verdict *means*, not a
      // downgrade of something the worker asked for.
      assert.equal(decision.downgraded, false);
    }
  });

  it('maps the two verdicts it does understand', () => {
    assert.equal(decideEvent('clean', repoWith(), pull, '').event, 'APPROVE');
    assert.equal(decideEvent('blocking', repoWith(), pull, '').event, 'REQUEST_CHANGES');
  });

  it('honours the per-repo mapping switches', () => {
    assert.equal(decideEvent('clean', repoWith({ approveWhenClean: false }), pull, '').event, 'COMMENT');
    assert.equal(
      decideEvent('blocking', repoWith({ requestChangesWhenBlocking: false }), pull, '').event,
      'COMMENT',
    );
  });

  it('caps everything under verdictMode: comment, and says it capped it', () => {
    for (const verdict of ['clean', 'blocking'] as Verdict[]) {
      const decision = decideEvent(verdict, repoWith({ verdictMode: 'comment' }), pull, '');
      assert.equal(decision.event, 'COMMENT');
      assert.equal(decision.downgraded, true);
      assert.notEqual(decision.wanted, 'COMMENT');
    }
  });

  it('does not try to approve a pull request OJ opened itself', () => {
    const decision = decideEvent('clean', repoWith(), { ...pull, authorLogin: 'oj[bot]' }, 'oj[bot]');
    assert.equal(decision.event, 'COMMENT');
    assert.equal(decision.downgraded, true);
  });
});

describe('commentFooter', () => {
  it('says which round and which commit, always', () => {
    const footer = commentFooter(3, 'abcdef1234567890', 'full');
    assert.match(footer, /round 3/);
    assert.match(footer, /abcdef12/);
    assert.doesNotMatch(footer, /cannot approve/);
  });

  it('warns the reader when the verdict was capped before it was reached', () => {
    assert.match(commentFooter(1, 'abcdef1234567890', 'comment'), /cannot approve or block/);
  });
});
