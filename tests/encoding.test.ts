import {
  base32Decode,
  base32Encode,
  base64UrlDecode,
  base64UrlEncode,
} from '../src/crypto/encoding';

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding or unsafe chars', () => {
    const data = Buffer.from([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(data);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded).equals(data)).toBe(true);
  });

  it('encodes utf-8 strings', () => {
    expect(base64UrlDecode(base64UrlEncode('héllo')).toString('utf8')).toBe('héllo');
  });
});

describe('base32', () => {
  it('encodes RFC 4648 test vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
  });

  it('round-trips random buffers', () => {
    const data = Buffer.from('the quick brown fox');
    expect(base32Decode(base32Encode(data)).equals(data)).toBe(true);
  });

  it('tolerates lower case, whitespace and padding on decode', () => {
    expect(base32Decode('mzxw6ytboi').toString()).toBe('foobar');
    expect(base32Decode('MZXW 6YTB OI').toString()).toBe('foobar');
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('0189')).toThrow(/Invalid base32/);
  });
});
