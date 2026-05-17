# 脚本工坊（Web）

从单文件 HTML 拆出的 **Vite** 项目：样式与逻辑分离、`npm` 管理依赖、支持热更新开发与一键构建静态资源。

## 常用命令

在项目目录 `web/` 下执行：

```bash
npm install    # 首次或依赖变更后
npm run dev    # 本地开发（默认 http://localhost:5173）
npm run build  # 输出到 dist/，可部署到任意静态托管
npm run preview # 本地预览构建结果
```

## 与旧版单文件的关系

桌面上的 `脚本工坊 (1).html` 可作为备份保留；日常开发请使用本目录，功能与数据（`localStorage` 键名）保持一致，但 **域名/端口变化会导致浏览器视为不同站点**，密钥与栏目数据不会自动迁移；若需沿用，请在同一域名下使用或自行导出/迁移。

## 近期代码层面的调整

- **Word 解析**：通过 `import('mammoth')` 按需加载，首屏主脚本体积显著减小。
- **标题/简介选择**：改为在 `#metaWrap` 上委托点击，从内存数组读取文案，避免把标题写进 `onclick` 带来的引号与特殊字符问题。

## 关于「Load failed」与 CORS

浏览器默认不允许直接调用 OpenAI / Anthropic / DeepSeek / 火山引擎 ARK 这几个域名（CORS 限制）。本项目通过 **Vite dev 代理**解决：

| 浏览器请求 | 实际转发到 |
|------------|-----------|
| `/api/openai/*`   | `https://api.openai.com/*` |
| `/api/doubao/*`   | `https://ark.cn-beijing.volces.com/*` |
| `/api/claude/*`   | `https://api.anthropic.com/*` |
| `/api/deepseek/*` | `https://api.deepseek.com/*` |

> 也就是说**必须用 `npm run dev` 启动**，直接双击打开 `index.html` 或 `dist/index.html` 仍会被浏览器拒绝。

### 已开 VPN，但 Claude / OpenAI 仍报 HTTP 500 或 `ENOTFOUND`

终端里跑的 **Vite（Node）默认不会自动走你在浏览器里用的代理**。代理转发到 `api.anthropic.com` 时，若本机 DNS 解析不到该域名，日志里会出现 `getaddrinfo ENOTFOUND api.anthropic.com`，浏览器侧则常表现为 **HTTP 500**。

任选其一即可：

1. **用环境变量**（Clash 等「混合端口」常见为 `7890`）再启动：

   ```bash
   HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npm run dev
   ```

   或直接使用仓库里的快捷脚本（同样假定本机 HTTP 代理在 7890）：

   ```bash
   npm run dev:clash
   ```

   若你的客户端端口不是 7890，把地址改成实际端口即可。

2. **用项目本地配置**（不落盘到 git，推荐）：在 `web/` 下新建 `.env.development.local`，写入一行：

   ```bash
   DEV_UPSTREAM_PROXY=http://127.0.0.1:7890
   ```

   然后照常 `npm run dev`。`vite.config.js` 会用它作为 **访问厂商 API 时的 upstream 代理**。

> 上述代理地址必须是 **HTTP 代理 URL**（`http://127.0.0.1:端口`）。若客户端只开 **SOCKS5**、没有 HTTP 端口，请在客户端里打开「系统代理 / 混合端口」或换用带 HTTP 入站的模式。

若出现 **HTTP 403**：请先**重启** `npm run dev`（当前配置会在转发到厂商时去掉 `Origin` / `Referer` 等浏览器头，避免被误判为「浏览器直连 API」而拒绝）。若仍为 403，多为 **API Key、账号权限或出口 IP** 被厂商拦截；生成失败时页面会尽量显示接口返回的详细文案，便于对照官方文档排查。

部署到生产时有两种选择：

1. **托管层加同样路径的反向代理**（Nginx、Vercel rewrites、Cloudflare Workers 等），保留 `/api/<provider>/*` 路径风格即可。
2. **改用自建后端代理**（推荐，把 Key 放服务端，前端不再持有 Key）。

## 后续可演进方向（按需）

- 将 `main.js` 按「存储 / API / UI」拆成多模块。
- 用环境变量 + 自建后端代理隐藏 Key（更安全）。
- 为栏目与文稿增加「导出/导入 JSON」便于换机备份。
