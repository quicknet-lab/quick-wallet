import { Buffer } from 'buffer';
import { signVerify } from '@ton/crypto';
import { compareVersions } from './validation';

/**
 * Where the app looks for firmware releases.
 *
 * VITE_FIRMWARE_MANIFEST_URL. The site serves the current release itself,
 * at /firmware/manifest.json: web/public/firmware links to firmware/release,
 * so every build of the site carries it along. A
 * GitHub release is no substitute — its downloads carry no CORS headers, so
 * the browser refuses to hand them to the app. Unset, the update and
 * flashing UI simply reports that no release feed is configured, which is
 * the right behaviour for a local dev build.
 *
 * The manifest is plain JSON:
 *
 *   { "version": "0.9.1",
 *     "url": "quick_wallet.bin",
 *     "sha256": "<hex of the OTA image>",
 *     "notes": "optional, shown to the user",
 *     "flash": {
 *       "chip": "ESP32-S3",
 *       "parts": [ { "offset": "0x0", "url": "bootloader.bin", "sha256": "…" }, … ]
 *     } }
 *
 * and is accepted only together with manifest.json.sig next to it: a
 * detached ed25519 signature over the manifest's exact bytes, checked
 * against the key pinned in this build (see SIGNING_KEY below). The pinned
 * SHA-256 of every image then carries that signature over to the images.
 *
 * `url` is the OTA image — the app partition on its own, which is all
 * esp_ota_write() wants. The optional `flash` section is the full set of
 * images a factory-fresh device needs over USB (bootloader, partition
 * table, otadata, app), and its absence just means this release can only be
 * installed over the air. Every url may be relative to the manifest's own
 * location, so a release is self-contained: the images sit next to the
 * manifest that lists them.
 */
function resolveManifestUrl(): string | undefined {
  const url = import.meta.env.VITE_FIRMWARE_MANIFEST_URL;
  return typeof url === 'string' && url.trim() !== '' ? url.trim() : undefined;
}

const MANIFEST_URL: string | undefined = resolveManifestUrl();

/**
 * Public half of the release signing key — VITE_FIRMWARE_SIGNING_PUBKEY, 64
 * hex characters of ed25519 public key. The release host is not trusted: a
 * hosting account, a CDN, whoever controls the manifest URL can publish
 * anything, and a malicious image can read the key and phrase straight out
 * of the device. So a manifest is only accepted with a valid signature from
 * the matching private key, which is kept offline and used only to sign a
 * release, and it pins the SHA-256 of every image, so an
 * image swapped on the host is caught too. A build with no key pinned
 * installs nothing at all.
 */
const SIGNING_KEY = parseSigningKey(import.meta.env.VITE_FIRMWARE_SIGNING_PUBKEY);

export function parseSigningKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value.trim())) return undefined;
  return Buffer.from(value.trim(), 'hex');
}

/** Detached ed25519 signature check over the manifest's exact bytes. */
export function verifyManifestSignature(manifest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.byteLength !== 64 || publicKey.byteLength !== 32) return false;
  return signVerify(Buffer.from(manifest), Buffer.from(signature), Buffer.from(publicKey));
}

/** Where the signature lives: next to the manifest, as manifest.json.sig. */
export function signatureUrl(manifestUrl: string): string {
  const url = new URL(manifestUrl);
  url.pathname += '.sig';
  return url.toString();
}

/** One image and the flash offset it belongs at, straight out of the
 * build's `flash_args`, with the SHA-256 it must hash to. */
export type FlashPart = {
  offset: number;
  url: string;
  sha256: string;
};

export type FlashPlan = {
  /** Chip the images were built for, checked against the one actually
   * plugged in before anything is written. */
  chip: string;
  /** The images turn on Secure Boot and Flash Encryption the first time the
   * device starts (set for a secure build). Only
   * changes what the install dialog warns about. */
  secure: boolean;
  parts: FlashPart[];
};

export type FirmwareRelease = {
  version: string;
  url: string;
  /** SHA-256 of the OTA image at `url`, lowercase hex. */
  sha256: string;
  notes?: string;
  flash?: FlashPlan;
};

function parseSha256(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value.trim())) {
    throw new Error(`The manifest pins no valid SHA-256 for ${what}.`);
  }
  return value.trim().toLowerCase();
}

function parseFlashPlan(body: unknown, baseUrl: string): FlashPlan {
  if (typeof body !== 'object' || body === null) {
    throw new Error('The manifest\'s "flash" section is not a JSON object.');
  }
  const { chip, secure, parts } = body as Record<string, unknown>;
  if (typeof chip !== 'string' || chip.trim() === '') {
    throw new Error('The manifest\'s "flash" section names no chip.');
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('The manifest\'s "flash" section lists no images.');
  }
  return {
    chip: chip.trim(),
    secure: secure === true,
    parts: parts.map((entry) => {
      const { offset, url, sha256 } = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
        string,
        unknown
      >;
      // Both "0x20000" and 131072 are accepted: the offsets get copied out
      // of the build's flash_args, where they are written in hex.
      const address = typeof offset === 'number' ? offset : Number(String(offset));
      if (!Number.isInteger(address) || address < 0) {
        throw new Error(`A flash image has an unusable offset: ${String(offset)}.`);
      }
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error('A flash image has no URL.');
      }
      return { offset: address, url: new URL(url, baseUrl).toString(), sha256: parseSha256(sha256, url) };
    }),
  };
}

/** Validates a manifest body. Separate from fetching so it can be tested. */
export function parseManifest(body: unknown, baseUrl: string): FirmwareRelease {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Firmware manifest is not a JSON object.');
  }
  const { version, url, sha256, notes, flash } = body as Record<string, unknown>;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('Firmware manifest has no version.');
  }
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('Firmware manifest has no image URL.');
  }
  return {
    version: version.trim(),
    url: new URL(url, baseUrl).toString(),
    sha256: parseSha256(sha256, 'the OTA image'),
    notes: typeof notes === 'string' ? notes : undefined,
    flash: flash === undefined ? undefined : parseFlashPlan(flash, baseUrl),
  };
}

export function manifestConfigured(): boolean {
  return MANIFEST_URL !== undefined;
}

export async function fetchLatestRelease(): Promise<FirmwareRelease> {
  if (!manifestConfigured()) {
    throw new Error('No firmware release feed is configured for this build.');
  }
  if (!SIGNING_KEY) {
    throw new Error(
      'This build pins no firmware signing key (VITE_FIRMWARE_SIGNING_PUBKEY), so no release can be verified — nothing will be installed.',
    );
  }
  // Absolutised first: a manifest URL is allowed to be a site-relative path
  // ("/firmware/manifest.json" while developing), and that is not a base the
  // URL constructor will resolve anything against.
  const base = new URL(MANIFEST_URL!, location.href).toString();
  const [manifestResponse, signatureResponse] = await Promise.all([
    fetch(base, { cache: 'no-store' }),
    fetch(signatureUrl(base), { cache: 'no-store' }),
  ]);
  if (!manifestResponse.ok) {
    throw new Error(`Firmware manifest request failed (HTTP ${manifestResponse.status}).`);
  }
  if (!signatureResponse.ok) {
    throw new Error(
      `Firmware manifest signature request failed (HTTP ${signatureResponse.status}). An unsigned release is never installed.`,
    );
  }
  // Verified as raw bytes, before any parsing: the signature covers exactly
  // what was published, not a re-serialisation of it.
  const manifest = new Uint8Array(await manifestResponse.arrayBuffer());
  const signature = new Uint8Array(await signatureResponse.arrayBuffer());
  if (!verifyManifestSignature(manifest, signature, SIGNING_KEY)) {
    throw new Error("The firmware manifest is not signed with this project's release key. Refusing to use it.");
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(manifest));
  } catch {
    throw new Error('Firmware manifest is not valid JSON.');
  }
  return parseManifest(body, base);
}

/** Throws unless `data` hashes to `expected` (lowercase hex SHA-256). */
export async function assertSha256(data: ArrayBuffer, expected: string): Promise<void> {
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
  if (digest !== expected) {
    throw new Error('A downloaded firmware image does not match the checksum in the signed manifest. Refusing to install it.');
  }
}

export async function downloadBinary(url: string, sha256: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Firmware download failed (HTTP ${response.status}).`);
  }
  const image = await response.arrayBuffer();
  if (image.byteLength === 0) {
    throw new Error('Firmware download was empty.');
  }
  await assertSha256(image, sha256);
  return image;
}

export function downloadImage(release: FirmwareRelease): Promise<ArrayBuffer> {
  return downloadBinary(release.url, release.sha256);
}

/**
 * Whether `release` is worth offering over what's on the device. Equal or
 * older versions aren't, and neither is an unparseable pair — see
 * compareVersions, which deliberately treats "can't tell" as "no update"
 * rather than pushing an image the user didn't ask for.
 */
export function updateAvailable(deviceVersion: string, release: FirmwareRelease): boolean {
  return compareVersions(release.version, deviceVersion) > 0;
}
