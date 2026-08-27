/**
 * 通用透明代理（Cloudflare Pages Functions 版）
 *
 * 作用：把浏览器发到 /api/<provider>/* 的请求原样转发给厂商真实域名，
 * 绕开浏览器的跨域（CORS）限制。等价于本地开发时 vite.config.js 里的 server.proxy。
 *
 * 安全要点：本函数【不持有任何 API Key】。
 * 用户在自己浏览器里填的 Key 会随 Authorization / x-api-key 请求头一起带上来，
 * 我们只做转发，不读取、不存储、不写入任何环境变量。
 */

// 允许透传给厂商的请求头（白名单，避免把 Origin/Referer/CF-* 等带过去触发 WAF）
const FORWARD_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'authorization',
  'x-api-key',
  'anthropic-version',
  'http-referer',
  'x-title',
  'openai-organization',
  'openai-beta',
];

function buildForwardHeaders(reqHeaders) {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = reqHeaders.get(name);
    if (v) headers.set(name, v);
  }
  if (!headers.has('user-agent')) headers.set('user-agent', 'script-workshop/1.0');
  return headers;
}

/**
 * @param {Request} request  原始请求
 * @param {string}  prefix   要剥掉的前缀，如 '/api/doubao'
 * @param {string}  target   厂商真实基地址，如 'https://ark.cn-beijing.volces.com'
 */
export async function proxyTo(request, prefix, target) {
  const url = new URL(request.url);
  const subPath = url.pathname.slice(prefix.length); // 保留 /... 部分
  const targetUrl = `${target}${subPath}${url.search}`;

  const method = request.method || 'GET';
  const init = {
    method,
    headers: buildForwardHeaders(request.headers),
    redirect: 'follow',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    return new Response(
      `上游请求失败：${err?.message || err}`,
      { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  // 直接把上游响应（含流式 SSE）透传回浏览器
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
