/**
 * 公司 OpenAI 中转：浏览器 → /api/openai-relay/* → 请求头 X-OpenAI-Base 指定的地址
 *
 * 等价于本地 vite.config.js 里的 companyOpenaiRelayPlugin。
 * 同样【不持有任何 Key】：用户的 Authorization 头原样转发。
 */

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'authorization'];

export const onRequest = async ({ request }) => {
  const baseHeader = request.headers.get('x-openai-base');
  if (!baseHeader) {
    return new Response(
      '缺少 X-OpenAI-Base：请在 API Key 弹窗填写「公司中转 API 地址」',
      { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  let upstreamBase;
  try {
    upstreamBase = new URL(baseHeader.endsWith('/') ? baseHeader : `${baseHeader}/`);
  } catch {
    return new Response(
      '公司中转 API 地址格式不正确，应为 https://域名/.../v1',
      { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const url = new URL(request.url);
  const subPath = url.pathname.replace(/^\/api\/openai-relay\/?/, '') || 'chat/completions';

  let targetUrl;
  try {
    targetUrl = new URL(subPath, upstreamBase);
  } catch {
    return new Response('无法拼接中转请求地址', { status: 400 });
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('user-agent', 'script-workshop/1.0');

  const method = request.method || 'POST';
  const init = { method, headers, redirect: 'follow' };
  if (method !== 'GET' && method !== 'HEAD') init.body = request.body;

  let upstream;
  try {
    upstream = await fetch(targetUrl.href, init);
  } catch (err) {
    return new Response(
      `Upstream proxy error: ${err?.message || err}`,
      { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
};
