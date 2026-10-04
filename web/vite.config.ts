import { defineConfig, loadEnv, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/** Hosts the firmware manifest and images are fetched from, if configured. */
function firmwareOrigins(env: Record<string, string>): string[] {
  const manifest = env.VITE_FIRMWARE_MANIFEST_URL?.trim();
  if (manifest) {
    try {
      return [new URL(manifest).origin];
    } catch {
      return []; // site-relative (production: /firmware/ on the site itself): covered by 'self'
    }
  }
  return [];
}

/**
 * Content-Security-Policy for the built app. This page decides what the
 * hardware wallet is asked to sign, so the policy
 * is damage control rather than hygiene: injected markup can't run script,
 * load code from anywhere else, or talk to any host but the few the app
 * needs. Build-only — the dev server's hot reload depends on exactly what
 * the policy forbids.
 *
 * Two things a <meta> tag cannot carry go out as response headers from
 * public/_headers (Cloudflare Pages): `frame-ancestors 'none'`
 * (clickjacking; main.ts also refuses to run inside a frame) and a
 * `Permissions-Policy` allowing only bluetooth and serial.
 */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes in the app's own markup; no third-party sheets.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    // Token and NFT images only ever come through toncenter's proxy (tokens.ts).
    "img-src 'self' data: https://proxy.toncenter.com",
    [
      'connect-src',
      "'self'", // includes /api/toncenter, the key-adding proxy (functions/)
      'wss://omni-ws.ston.fi',
      // TON Connect: the bridge, and the tonconnect-manifest.json of whatever
      // site the user connects to, which can be hosted anywhere. Both carry
      // only what a site already sees; signing still goes through the device.
      'https://bridge.tonapi.io',
      'https:',
      ...firmwareOrigins(env),
    ].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  };
}

// @ton/core reaches for Node's Buffer at module init time; this plugin
// makes it available before any dependent module gets evaluated (a plain
// `window.Buffer = ...` in app code runs too late — ESM hoists imports).
/**
 * Dev-server stand-in for functions/api/toncenter (the Pages Function that
 * adds the toncenter key in production). Keys come from the non-VITE_
 * TONCENTER_API_KEY_* in .env.local, so they never reach the bundle.
 */
function toncenterProxy(env: Record<string, string>) {
  const route = (network: 'mainnet' | 'testnet', target: string, key: string | undefined) => ({
    target,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(`/api/toncenter/${network}`, ''),
    headers: key ? { 'X-API-Key': key } : {},
  });
  return {
    '/api/toncenter/mainnet': route('mainnet', 'https://toncenter.com', env.TONCENTER_API_KEY_MAINNET),
    '/api/toncenter/testnet': route('testnet', 'https://testnet.toncenter.com', env.TONCENTER_API_KEY_TESTNET),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [nodePolyfills({ include: ['buffer'] }), contentSecurityPolicy(loadEnv(mode, process.cwd()))],
  server: { proxy: toncenterProxy(loadEnv(mode, process.cwd(), 'TONCENTER_')) },
}));
