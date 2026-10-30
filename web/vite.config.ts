import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

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
  plugins: [nodePolyfills({ include: ['buffer'] })],
  server: { proxy: toncenterProxy(loadEnv(mode, process.cwd(), 'TONCENTER_')) },
}));
