/**
 * Cloudflare Pages Function: same-origin fetch of a site's
 * tonconnect-manifest.json, so the page's connect-src needs no `https:`
 * wildcard (manifests can be hosted anywhere).
 *
 *   GET /api/tc-manifest?url=<https URL of the manifest>
 *
 * Only small JSON comes back, and only to this site's own pages: it is no use
 * as a general relay. Trust is unchanged — the browser fetched the same file
 * before, and the device still shows the domain it signs into a ton_proof.
 */

const MAX_BYTES = 16 * 1024;

function reply(body: BodyInit | null, status: number): Response {
  // public/_headers does not reach Function responses: whatever a site sends
  // back must never render as a page of this origin.
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  const { request } = context;
  if (request.method !== 'GET') return reply(null, 405);
  // Every browser with Web Bluetooth sends this header; scripts can't forge it.
  if (request.headers.get('Sec-Fetch-Site') !== 'same-origin') return reply(null, 403);

  let target: URL;
  try {
    target = new URL(new URL(request.url).searchParams.get('url') ?? '');
  } catch {
    return reply(null, 400);
  }
  if (target.protocol !== 'https:' || target.username || target.password) return reply(null, 400);

  let res: Response;
  try {
    res = await fetch(target.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return reply(null, 504); // unreachable or too slow
  }
  if (!res.ok) return reply(null, res.status);

  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return reply(null, 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  try {
    JSON.parse(new TextDecoder().decode(body));
  } catch {
    return reply(null, 422);
  }
  return reply(body, 200);
};
