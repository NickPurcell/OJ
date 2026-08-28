import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Verdict } from '../desk.js';
import type { PullRequest } from '../github.js';
import { commentFooter, decideEvent } from '../review.js';

const pull = { number: 7, authorLogin: 'someone', headSha: 'abcdef1234' } as PullRequest;

describe('decideEvent', () => {
  it('never approves without a verdict', () => {
    for (const approve of [true, false]) {
      const decision = decideEvent(null, approve, pull, 'oj[bot]');
      assert.equal(decision.event, 'COMMENT');
      assert.equal(decision.downgraded, false);
    }
  });

  it('maps the two verdicts it does understand', () => {
    assert.equal(decideEvent('clean', true, pull, '').event, 'APPROVE');
    assert.equal(decideEvent('blocking', true, pull, '').event, 'REQUEST_CHANGES');
  });

  it('posts everything as a COMMENT when approve is off, and says it did', () => {
    for (const verdict of ['clean', 'blocking'] as Verdict[]) {
      const decision = decideEvent(verdict, false, pull, '');
      assert.equal(decision.event, 'COMMENT');
      assert.equal(decision.downgraded, true);
      assert.notEqual(decision.wanted, 'COMMENT');
    }
  });

  it('does not try to approve a pull request OJ opened itself', () => {
    const decision = decideEvent('clean', true, { ...pull, authorLogin: 'oj[bot]' }, 'oj[bot]');
    assert.equal(decision.event, 'COMMENT');
    assert.equal(decision.downgraded, true);
  });
});

describe('commentFooter', () => {
  it('names the round and the commit, and says when it could not approve', () => {
    assert.match(commentFooter(3, 'abcdef1234567890', true), /round 3.*abcdef12/);
    assert.doesNotMatch(commentFooter(3, 'abcdef1234567890', true), /cannot approve/);
    assert.match(commentFooter(1, 'abcdef1234567890', false), /cannot approve or block/);
  });
});
