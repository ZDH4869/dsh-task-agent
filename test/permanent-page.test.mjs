/**
 * Self-check for the permanent-page decision, the tested spec that the client mirrors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPermanentPage } from '../src/permanent-page.js';

test('reuses the remembered session and never creates a second one', async () => {
  const calls = [];
  const result = await openPermanentPage({
    preset: { id: 'expert-a' },
    readMap: async () => ({ 'expert-a': 'session-perm' }),
    writeMap: async () => calls.push('write'),
    createSession: async () => calls.push('create'),
    openSession: id => calls.push(`open:${id}`),
  });
  assert.deepEqual(result, { reused: true, sessionId: 'session-perm' });
  assert.deepEqual(calls, ['open:session-perm'], 'no write, no create');
});

test('creates once when absent, persists the mapping, then opens', async () => {
  const calls = [];
  const result = await openPermanentPage({
    preset: { id: 'expert-a' },
    readMap: async () => ({}),
    writeMap: async map => calls.push(`write:${map['expert-a']}`),
    createSession: async id => { calls.push(`create:${id}`); return 'session-new'; },
    openSession: id => calls.push(`open:${id}`),
  });
  assert.deepEqual(result, { reused: false, sessionId: 'session-new' });
  assert.deepEqual(calls, ['create:expert-a', 'write:session-new', 'open:session-new']);
});

test('keeps other experts in the map when adding one', async () => {
  let written;
  await openPermanentPage({
    preset: { id: 'expert-b' },
    readMap: async () => ({ 'expert-a': 'session-a' }),
    writeMap: async map => { written = map; },
    createSession: async () => ({ sessionId: 'session-b' }),
    openSession: () => {},
  });
  assert.deepEqual(written, { 'expert-a': 'session-a', 'expert-b': 'session-b' });
});

test('a create that yields no session does not persist a bogus mapping', async () => {
  const calls = [];
  const result = await openPermanentPage({
    preset: { id: 'expert-c' },
    readMap: async () => ({}),
    writeMap: async () => calls.push('write'),
    createSession: async () => undefined,
    openSession: () => calls.push('open'),
  });
  assert.deepEqual(result, { reused: false, sessionId: undefined });
  assert.deepEqual(calls, [], 'neither written nor opened');
});
