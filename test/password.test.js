import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/password.js';

// Use low cost parameters to keep the suite fast; production uses the defaults.
const FAST = { N: 1024, r: 8, p: 1 };

test('hash is not the plaintext and encodes its parameters', async () => {
  const hash = await hashPassword('correct horse battery staple', FAST);
  assert.ok(!hash.includes('correct horse'));
  assert.ok(hash.startsWith('scrypt$1024$8$1$'));
  assert.equal(hash.split('$').length, 6);
});

test('verifyPassword is true for the right password, false otherwise', async () => {
  const hash = await hashPassword('s3cr3t-passw0rd', FAST);
  assert.equal(await verifyPassword('s3cr3t-passw0rd', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('the same password hashes differently each time (random salt)', async () => {
  const a = await hashPassword('same-password', FAST);
  const b = await hashPassword('same-password', FAST);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('malformed stored hashes verify to false instead of throwing', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', 'scrypt$bad$params$here$x$y'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword(null, 'scrypt$1024$8$1$aaaa$bbbb'), false);
});

test('empty passwords are rejected at hash time', async () => {
  await assert.rejects(() => hashPassword(''), /non-empty/);
});
