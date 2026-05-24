import { defineConfig, loadEnv } from 'vite';
import { HttpsProxyAgent } from 'https-proxy-agent';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { handleTopicSearch } from './server/topicSearchHandler.js';

/** 公司 OpenAI 中转：浏览器 → /api/openai-relay → 请求头 X-OpenAI-Base 指定的地址 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function companyOpenaiRelayPlugin(upstreamAgent, allowInsecureSsl = false) {
  return {
    name: 'company-openai-relay',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/openai-relay')) return next();

        (async () => {
          const baseHeader = req.headers['x-openai-base'];
          if (!baseHeader || typeof baseHeader !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('缺少 X-OpenAI-Base：请在 API Key 弹窗填写「公司中转 API 地址」');
            return;
          }

          let upstreamBase;
          try {
            upstreamBase = new URL(baseHeader.endsWith('/') ? baseHeader : `${baseHeader}/`);
          } catch {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('公司中转 API 地址格式不正确，应为 https://域名/.../v1');
            return;
          }

          const subPath = req.url.replace(/^\/api\/openai-relay\/?/, '') || 'chat/completions';
          let targetUrl;
          try {
            targetUrl = new URL(subPath, upstreamBase);
          } catch {
            res.statusCode = 400;
            res.end('无法拼接中转请求地址');
            return;
          }

          const body = await readRequestBody(req);
          const isHttps = targetUrl.protocol === 'https:';
          const lib = isHttps ? https : http;

          // 只转发必要头；去掉 Origin/Referer 等，避免公司网关/WAF 对 localhost 返回 403
          const headers = {
            host: targetUrl.host,
            'content-type': req.headers['content-type'] || 'application/json',
            accept: req.headers.accept || 'application/json',
            authorization: req.headers.authorization || '',
            'user-agent': 'script-workshop/1.0',
          };
          if (body.length) headers['content-length'] = String(body.length);
          if (!headers.authorization) delete headers.authorization;

          const options = {
            method: req.method || 'POST',
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isHttps ? 443 : 80),
            path: `${targetUrl.pathname}${targetUrl.search}`,
            headers,
            ...(isHttps && upstreamAgent ? { agent: upstreamAgent } : {}),
            ...(isHttps && allowInsecureSsl ? { rejectUnauthorized: false } : {}),
          };

          await new Promise((resolve, reject) => {
            const proxyReq = lib.request(options, (proxyRes) => {
              const status = proxyRes.statusCode || 502;
              if (status >= 400) {
                const chunks = [];
                proxyRes.on('data', c => chunks.push(c));
                proxyRes.on('end', () => {
                  const text = Buffer.concat(chunks).toString();
                  console.warn('[openai-relay]', status, targetUrl.href, text.slice(0, 800));
                  res.writeHead(status, { 'content-type': proxyRes.headers['content-type'] || 'application/json' });
                  res.end(text);
                  resolve();
                });
                return;
              }
              res.writeHead(status, proxyRes.headers);
              proxyRes.pipe(res);
              proxyRes.on('end', resolve);
            });
            proxyReq.on('error', (err) => {
              console.warn('[openai-relay] upstream error:', targetUrl.origin, err?.message || err);
              reject(err);
            });
            proxyReq.end(body);
          });
        })().catch((err) => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          }
          res.end(`Upstream proxy error: ${err?.message || err}`);
        });
      });
    },
  };
}

function topicSearchPlugin(upstreamAgent) {
  return {
    name: 'topic-search',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || req.url !== '/api/topic-search') return next();

        (async () => {
          try {
            const body = JSON.parse((await readRequestBody(req)).toString('utf8') || '{}');
            const result = await handleTopicSearch(body, upstreamAgent);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(result));
          } catch (err) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(err?.message || String(err));
          }
        })().catch((err) => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          }
          res.end(`Topic search error: ${err?.message || err}`);
        });
      });
    },
  };
}

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

  const allowInsecureSsl = env.ALLOW_INSECURE_SSL === 'true';

  return {
    base: '/',
    plugins: [companyOpenaiRelayPlugin(upstreamAgent, allowInsecureSsl), topicSearchPlugin(upstreamAgent)],
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
        '/api/openalex': {
          ...base,
          target: 'https://api.openalex.org',
          rewrite: (p) => p.replace(/^\/api\/openalex/, ''),
        },
        '/api/crossref': {
          ...base,
          target: 'https://api.crossref.org',
          rewrite: (p) => p.replace(/^\/api\/crossref/, ''),
        },
        '/api/wiki-zh': {
          ...base,
          target: 'https://zh.wikipedia.org',
          rewrite: (p) => p.replace(/^\/api\/wiki-zh/, ''),
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
