/**
 * Cloudflare Pages Function: same-origin proxy to toncenter that adds the API
 * key on the server, so the key never ships in the frontend bundle.
 *
 *   /api/toncenter/<mainnet|testnet>/api/v2/jsonRPC     (POST)
 *   /api/toncenter/<mainnet|testnet>/api/v3/<allowed>   (GET)
 *
 * Keys come from the environment as TONCENTER_API_KEY_MAINNET / _TESTNET.
 * Without a key the request still goes through, unkeyed and rate-limited.
 *
 * Trust is unchanged: toncenter was already trusted for chain data, and the
 * device still parses and shows everything it signs.
 */

interface Env {
  TONCENTER_API_KEY_MAINNET?: string;
  TONCENTER_API_KEY_TESTNET?: string;
}

const UPSTREAM: Record<string, string> = {
  mainnet: 'https://toncenter.com',
  testnet: 'https://testnet.toncenter.com',
};

// Only what wallet.ts calls: this is not a general-purpose relay for the key.
const ALLOWED: Array<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^api\/v2\/jsonRPC$/ },
  { method: 'GET', path: /^api\/v3\/(jetton\/wallets|jetton\/masters|nft\/items)$/ },
];

export const onRequest = async (context: {
  request: Request;
  env: Env;
  params: { path?: string[] };
}): Promise<Response> => {
  const { request, env } = context;
  const [network, ...rest] = context.params.path ?? [];
  const upstream = Object.hasOwn(UPSTREAM, network) ? UPSTREAM[network] : undefined;
  const path = rest.join('/');

  if (!upstream || !ALLOWED.some((a) => a.method === request.method && a.path.test(path))) {
    return new Response('Not found', { status: 404 });
  }
  // Browsers mark cross-site requests and scripts cannot forge this header:
  // other sites can't spend the key through their visitors' browsers.
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const headers = new Headers({ 'Content-Type': request.headers.get('Content-Type') ?? 'application/json' });
  const key = network === 'mainnet' ? env.TONCENTER_API_KEY_MAINNET : env.TONCENTER_API_KEY_TESTNET;
  if (key) headers.set('X-API-Key', key);

  const res = await fetch(`${upstream}/${path}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
  });
  // Served from the wallet's own origin, and public/_headers does not reach
  // Function responses: whatever toncenter (or an error page in front of it)
  // sends back must never render as a page of this site.
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
