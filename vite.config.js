import { defineConfig, loadEnv } from 'vite';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * 开发代理：浏览器 → localhost:5173/api/<provider>/... → 厂商 API
 *
 * - 豆包 / DeepSeek 在国内可直连，普通 `npm run dev` 即可。
 * - OpenAI / Anthropic 需要科学上网，且终端里跑的 Node 必须自己走代理：
 *   方法一：`HTTPS_PROXY=http://127.0.0.1:7890 npm run dev`
 *   方法二：在 web/ 下新建 .env.development.local，写 DEV_UPSTREAM_PROXY=http://127.0.0.1:7890
 *   或直接用快捷脚本：`npm run dev:clash`
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const upstreamProxy =
    env.DEV_UPSTREAM_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  const upstreamAgent = upstreamProxy
    ? new HttpsProxyAgent(upstreamProxy)
    : undefined;

  /** 单条请求出错时只回 502，不要把整个 dev server 拖崩 */
  const configure = (proxy) => {
    proxy.on('error', (err, _req, res) => {
      console.warn('[proxy] upstream error:', err?.message || err);
      try { if (res && !res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch {}
      try { res?.end?.(`Upstream proxy error: ${err?.message || err}`); } catch {}
    });
  };

  const base = {
    changeOrigin: true,
    secure: true,
    configure,
    ...(upstreamAgent ? { agent: upstreamAgent } : {}),
  };

  return {
    base: './',
    server: {
      port: 5173,
      open: true,
      proxy: {
        '/api/openai': {
          ...base,
          target: 'https://api.openai.com',
          rewrite: (p) => p.replace(/^\/api\/openai/, ''),
        },
        '/api/doubao': {
          ...base,
          target: 'https://ark.cn-beijing.volces.com',
          rewrite: (p) => p.replace(/^\/api\/doubao/, ''),
        },
        '/api/claude': {
          ...base,
          target: 'https://api.anthropic.com',
          rewrite: (p) => p.replace(/^\/api\/claude/, ''),
        },
        '/api/deepseek': {
          ...base,
          target: 'https://api.deepseek.com',
          rewrite: (p) => p.replace(/^\/api\/deepseek/, ''),
        },
        '/api/openrouter': {
          ...base,
          target: 'https://openrouter.ai',
          rewrite: (p) => p.replace(/^\/api\/openrouter/, ''),
        },
      },
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: true,
    },
  };
});
