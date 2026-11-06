import { defineConfig, loadEnv, type Plugin } from 'vite';
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

/** Dev-server stand-in for functions/api/tc-manifest (no size or type checks). */
const tcManifestProxy: Plugin = {
  name: 'tc-manifest-proxy',
  configureServer(server) {
    server.middlewares.use('/api/tc-manifest', async (req, res) => {
      const target = new URL(req.url ?? '', 'http://dev').searchParams.get('url') ?? '';
      try {
        const upstream = await fetch(target);
        res.statusCode = upstream.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.statusCode = 504;
        res.end();
      }
    });
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [nodePolyfills({ include: ['buffer'] }), tcManifestProxy],
  server: { proxy: toncenterProxy(loadEnv(mode, process.cwd(), 'TONCENTER_')) },
}));
