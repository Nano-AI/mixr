import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, mean } from '../../src/matching/vectors.ts';
import { axis } from '../helpers.ts';

test('cosine of identical and orthogonal unit vectors', () => {
  assert.equal(cosine(axis(0), axis(0)), 1);
  assert.equal(cosine(axis(0), axis(1)), 0);
});

test('mean is normalized and equidistant from its inputs', () => {
  const m = mean([axis(0), axis(1)]);
  assert.ok(Math.abs(cosine(m, axis(0)) - 0.7071) < 1e-3);
  assert.ok(Math.abs(cosine(m, axis(1)) - 0.7071) < 1e-3);
});
