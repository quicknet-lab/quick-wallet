import { describe, expect, it } from 'vitest';
import { Buffer } from 'buffer';
import { keyPairFromSeed, sign } from '@ton/crypto';
import {
  assertSha256,
  parseManifest,
  parseSigningKey,
  signatureUrl,
  updateAvailable,
  verifyManifestSignature,
} from './firmware';

const BASE = 'https://releases.example.com/firmware/manifest.json';
const SHA = 'ab'.repeat(32);

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const release = parseManifest(
      { version: '0.9.1', url: 'https://cdn.example.com/fw.bin', sha256: SHA, notes: 'Fixes X' },
      BASE,
    );
    expect(release).toEqual({
      version: '0.9.1',
      url: 'https://cdn.example.com/fw.bin',
      sha256: SHA,
      notes: 'Fixes X',
      flash: undefined,
    });
  });

  it('resolves a relative image URL against the manifest location', () => {
    expect(parseManifest({ version: '1.0.0', url: 'fw-1.0.0.bin', sha256: SHA }, BASE).url).toBe(
      'https://releases.example.com/firmware/fw-1.0.0.bin',
    );
  });

  it('leaves notes undefined when absent or not a string', () => {
    expect(parseManifest({ version: '1.0.0', url: 'a.bin', sha256: SHA }, BASE).notes).toBeUndefined();
    expect(parseManifest({ version: '1.0.0', url: 'a.bin', sha256: SHA, notes: 42 }, BASE).notes).toBeUndefined();
  });

  it('normalises the pinned checksum to lowercase', () => {
    expect(parseManifest({ version: '1.0.0', url: 'a.bin', sha256: SHA.toUpperCase() }, BASE).sha256).toBe(SHA);
  });

  it('rejects anything that is not a usable manifest', () => {
    expect(() => parseManifest(null, BASE)).toThrow(/not a JSON object/);
    expect(() => parseManifest('nope', BASE)).toThrow(/not a JSON object/);
    expect(() => parseManifest({ url: 'a.bin' }, BASE)).toThrow(/no version/);
    expect(() => parseManifest({ version: '  ', url: 'a.bin' }, BASE)).toThrow(/no version/);
    expect(() => parseManifest({ version: '1.0.0' }, BASE)).toThrow(/no image URL/);
    expect(() => parseManifest({ version: '1.0.0', url: '' }, BASE)).toThrow(/no image URL/);
  });

  it('rejects an image without a pinned SHA-256', () => {
    expect(() => parseManifest({ version: '1.0.0', url: 'a.bin' }, BASE)).toThrow(/SHA-256/);
    expect(() => parseManifest({ version: '1.0.0', url: 'a.bin', sha256: 'abc' }, BASE)).toThrow(/SHA-256/);
    expect(() => parseManifest({ version: '1.0.0', url: 'a.bin', sha256: 'zz'.repeat(32) }, BASE)).toThrow(/SHA-256/);
  });
});

describe('parseManifest — flash section', () => {
  const flash = {
    chip: 'ESP32-S3',
    parts: [
      { offset: '0x0', url: 'bootloader.bin', sha256: SHA },
      { offset: '0xe000', url: 'partition-table.bin', sha256: SHA },
      { offset: 131072, url: 'quick_wallet.bin', sha256: SHA },
    ],
  };

  it('reads hex and decimal offsets and resolves relative URLs', () => {
    expect(parseManifest({ version: '1.0.0', url: 'app.bin', sha256: SHA, flash }, BASE).flash).toEqual({
      chip: 'ESP32-S3',
      secure: false,
      parts: [
        { offset: 0, url: 'https://releases.example.com/firmware/bootloader.bin', sha256: SHA },
        { offset: 0xe000, url: 'https://releases.example.com/firmware/partition-table.bin', sha256: SHA },
        { offset: 0x20000, url: 'https://releases.example.com/firmware/quick_wallet.bin', sha256: SHA },
      ],
    });
  });

  it('reads the secure flag, and only a literal true counts', () => {
    const secureOf = (secure: unknown) =>
      parseManifest({ version: '1.0.0', url: 'app.bin', sha256: SHA, flash: { ...flash, secure } }, BASE).flash!.secure;
    expect(secureOf(true)).toBe(true);
    expect(secureOf(false)).toBe(false);
    expect(secureOf('true')).toBe(false);
  });

  it('leaves flash undefined for an OTA-only release', () => {
    expect(parseManifest({ version: '1.0.0', url: 'app.bin', sha256: SHA }, BASE).flash).toBeUndefined();
  });

  it('rejects a flash section that cannot be acted on', () => {
    const withFlash = (f: unknown) => () =>
      parseManifest({ version: '1.0.0', url: 'a.bin', sha256: SHA, flash: f }, BASE);
    expect(withFlash('esp32s3')).toThrow(/not a JSON object/);
    expect(withFlash({ parts: flash.parts })).toThrow(/names no chip/);
    expect(withFlash({ chip: 'ESP32-S3' })).toThrow(/lists no images/);
    expect(withFlash({ chip: 'ESP32-S3', parts: [] })).toThrow(/lists no images/);
    expect(withFlash({ chip: 'ESP32-S3', parts: [{ url: 'a.bin' }] })).toThrow(/unusable offset/);
    expect(withFlash({ chip: 'ESP32-S3', parts: [{ offset: 'start', url: 'a.bin' }] })).toThrow(/unusable offset/);
    expect(withFlash({ chip: 'ESP32-S3', parts: [{ offset: -1, url: 'a.bin' }] })).toThrow(/unusable offset/);
    expect(withFlash({ chip: 'ESP32-S3', parts: [{ offset: '0x0' }] })).toThrow(/no URL/);
    expect(withFlash({ chip: 'ESP32-S3', parts: [{ offset: '0x0', url: 'a.bin' }] })).toThrow(/SHA-256/);
  });
});

describe('manifest signature', () => {
  const keys = keyPairFromSeed(Buffer.alloc(32, 7));
  const manifest = Buffer.from('{"version":"1.0.0","url":"a.bin","sha256":"' + SHA + '"}');
  const signature = sign(manifest, keys.secretKey);

  it('accepts the manifest exactly as signed', () => {
    expect(verifyManifestSignature(manifest, signature, keys.publicKey)).toBe(true);
  });

  it('rejects a manifest changed after signing, even by one byte', () => {
    const tampered = Buffer.from(manifest);
    tampered[tampered.length - 3] ^= 1;
    expect(verifyManifestSignature(tampered, signature, keys.publicKey)).toBe(false);
  });

  it('rejects a signature made with another key', () => {
    const other = keyPairFromSeed(Buffer.alloc(32, 8));
    expect(verifyManifestSignature(manifest, sign(manifest, other.secretKey), keys.publicKey)).toBe(false);
  });

  it('rejects a signature or key of the wrong length', () => {
    expect(verifyManifestSignature(manifest, signature.subarray(0, 63), keys.publicKey)).toBe(false);
    expect(verifyManifestSignature(manifest, new Uint8Array(0), keys.publicKey)).toBe(false);
    expect(verifyManifestSignature(manifest, signature, keys.publicKey.subarray(0, 31))).toBe(false);
  });

  it('finds the signature next to the manifest', () => {
    expect(signatureUrl(BASE)).toBe('https://releases.example.com/firmware/manifest.json.sig');
    expect(signatureUrl('https://x.example/m.json?v=2')).toBe('https://x.example/m.json.sig?v=2');
  });
});

describe('parseSigningKey', () => {
  it('takes exactly 32 bytes of hex', () => {
    expect(parseSigningKey('00'.repeat(32))?.length).toBe(32);
    expect(parseSigningKey(` ${'Ab'.repeat(32)} `)?.toString('hex')).toBe('ab'.repeat(32));
  });

  it('pins nothing for anything else', () => {
    expect(parseSigningKey(undefined)).toBeUndefined();
    expect(parseSigningKey('')).toBeUndefined();
    expect(parseSigningKey('00'.repeat(31))).toBeUndefined();
    expect(parseSigningKey('zz'.repeat(32))).toBeUndefined();
  });
});

describe('assertSha256', () => {
  const image = new TextEncoder().encode('firmware').buffer as ArrayBuffer;
  // sha256("firmware")
  const digest = '2ad4b04fdc1a4ce6d0de6d1ad53a9d1bd9e28c36a1d4da1efafdf0e2a3bc4bb4';

  it('passes an image that hashes to the pinned value', async () => {
    const actual = Buffer.from(await crypto.subtle.digest('SHA-256', image)).toString('hex');
    await expect(assertSha256(image, actual)).resolves.toBeUndefined();
  });

  it('refuses one that does not', async () => {
    await expect(assertSha256(image, digest.replace(/^2/, '3'))).rejects.toThrow(/does not match/);
  });
});

describe('updateAvailable', () => {
  const release = (version: string) => ({ version, url: 'https://x/fw.bin', sha256: SHA });

  it('offers a strictly newer version', () => {
    expect(updateAvailable('0.9.0', release('0.9.1'))).toBe(true);
    expect(updateAvailable('0.9.0', release('1.0.0'))).toBe(true);
  });

  it('does not offer the same or an older version', () => {
    expect(updateAvailable('0.9.0', release('0.9.0'))).toBe(false);
    expect(updateAvailable('1.0.0', release('0.9.9'))).toBe(false);
  });

  it('does not offer anything against an unreadable device version', () => {
    // What older firmware without the version characteristic reports.
    expect(updateAvailable('unknown', release('9.9.9'))).toBe(false);
  });
});
