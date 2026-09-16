import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRupees, isTugOfWarVoteTally, optionPaidFraction, totalPaidAmountPaise } from './tug-of-war-vote-logic';

const validTally = {
  schemaVersion: 'v1' as const,
  votingMode: 'paid' as const,
  options: [
    { optionKey: 'team-a', label: 'Team A', amountPaise: 300000 },
    { optionKey: 'team-b', label: 'Team B', amountPaise: 100000 },
  ],
  resolved: false,
  resolvedOptionKey: null,
};

test('a well-formed two-option paid tally is accepted', () => {
  assert.equal(isTugOfWarVoteTally(validTally), true);
});

test('§6 "two-sided" is enforced structurally: one option is rejected', () => {
  assert.equal(isTugOfWarVoteTally({ ...validTally, options: [validTally.options[0]] }), false);
});

test('§6 "two-sided" is enforced structurally: three options is rejected', () => {
  assert.equal(isTugOfWarVoteTally({ ...validTally, options: [...validTally.options, { optionKey: 'c', label: 'C', amountPaise: 1 }] }), false);
});

test('wrong votingMode is rejected', () => {
  assert.equal(isTugOfWarVoteTally({ ...validTally, votingMode: 'free' }), false);
});

test('a negative or non-integer amount is rejected', () => {
  assert.equal(isTugOfWarVoteTally({ ...validTally, options: [{ ...validTally.options[0], amountPaise: -1 }, validTally.options[1]] }), false);
  assert.equal(isTugOfWarVoteTally({ ...validTally, options: [{ ...validTally.options[0], amountPaise: 1.5 }, validTally.options[1]] }), false);
});

test('an extra/unknown field is rejected — exact-shape guard, same convention as every other overlay type guard in this codebase', () => {
  assert.equal(isTugOfWarVoteTally({ ...validTally, extra: 'field' }), false);
});

test('totalPaidAmountPaise sums both sides', () => {
  assert.equal(totalPaidAmountPaise(validTally), 400000);
});

test('optionPaidFraction is the option\'s share of the total, summing to 1 across both sides', () => {
  const fractionA = optionPaidFraction(validTally.options[0]!, validTally);
  const fractionB = optionPaidFraction(validTally.options[1]!, validTally);
  assert.equal(fractionA, 0.75);
  assert.equal(fractionB, 0.25);
  assert.equal(fractionA + fractionB, 1);
});

test('optionPaidFraction is 0.5/0.5 when nothing has been paid — never a division-by-zero result', () => {
  const zeroTally = { ...validTally, options: [{ ...validTally.options[0], amountPaise: 0 }, { ...validTally.options[1], amountPaise: 0 }] };
  assert.equal(optionPaidFraction(zeroTally.options[0]!, zeroTally), 0.5);
  assert.equal(optionPaidFraction(zeroTally.options[1]!, zeroTally), 0.5);
});

test('formatRupees renders paise as a locale-formatted rupee string', () => {
  assert.equal(formatRupees(150000), '₹1,500');
});
