import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlEncode,
  base64UrlDecode,
  base32Encode,
  base32Decode,
} from '../src/encoding.js';

test('base64url round-trips strings and buffers', () => {
  for (const value of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'RoutePilot 🚚']) {
    assert.equal(base64UrlDecode(base64UrlEncode(value)).toString('utf8'), value);
  }
});

test('base64url output is url-safe and unpadded', () => {
  const encoded = base64UrlEncode(Buffer.from([0xff, 0xff, 0xfe, 0xff]));
  assert.ok(!encoded.includes('+'));
  assert.ok(!encoded.includes('/'));
  assert.ok(!encoded.includes('='));
});

test('base64url decodes unpadded input', () => {
  assert.equal(base64UrlDecode('Zg').toString('utf8'), 'f');
  assert.equal(base64UrlDecode('Zm9vYmFy').toString('utf8'), 'foobar');
});

test('base32 matches RFC 4648 test vectors', () => {
  const vectors = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(base32Encode(Buffer.from(input, 'utf8')), expected, `encode ${input}`);
    assert.equal(base32Decode(expected).toString('utf8'), input, `decode ${expected}`);
  }
});

test('base32 decode tolerates case, padding and whitespace', () => {
  assert.equal(base32Decode('mzxw6ytboi').toString('utf8'), 'foobar');
  assert.equal(base32Decode('MZXW6YTBOI======').toString('utf8'), 'foobar');
  assert.equal(base32Decode('MZXW 6YTB OI').toString('utf8'), 'foobar');
});

test('base32 decode rejects invalid characters', () => {
  assert.throws(() => base32Decode('MZXW0!'), /Invalid base32/);
});
