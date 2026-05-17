# 周树人（Web）

知识科普类视频脚本辅助写作工具：上传栏目参考文稿 → 输入大纲 → AI 生成逐字稿 → 段落修改 → 标题/简介 → 导出 Markdown。

从单文件 HTML 拆出的 **Vite** 项目：样式与逻辑分离、`npm` 管理依赖、支持热更新开发与一键构建静态资源。

**仓库地址：** https://github.com/wangyanlinbj/script-workshop

---

## 同事快速开始

适合第一次在本机使用、不需要改代码的同事。按顺序做即可。

### 1. 准备环境

| 需要 | 说明 |
|------|------|
| [Node.js](https://nodejs.org/) | 建议安装 **LTS** 版本（自带 `npm`） |
| Git（可选） | 也可用 GitHub 网页 **Download ZIP** 解压代替 `git clone` |
| 各厂商 API Key | 每人用自己的 Key，**不要**写进代码或提交到 GitHub |

### 2. 获取代码

**方式 A：克隆（推荐）**

```bash
git clone https://github.com/wangyanlinbj/script-workshop.git
cd script-workshop
```

**方式 B：下载 ZIP**

打开 https://github.com/wangyanlinbj/script-workshop → **Code** → **Download ZIP**，解压后进入文件夹。

> 若仓库为**私有**，需仓库管理员在 GitHub **Settings → Collaborators** 邀请你的账号后再克隆。

### 3. 安装并启动

在**仓库根目录**（能看到 `package.json` 的目录）执行：

```bash
npm install
npm run dev
```

终端出现类似下面一行即表示成功：

```text
➜  Local:   http://localhost:5173/
```

浏览器打开 **http://localhost:5173/**（若未自动打开，请手动访问）。

> **必须用 `npm run dev` 启动**，不要直接双击 `index.html`。否则调用 AI 接口会被浏览器跨域拦截。

### 4. 配置 API（每人本地单独保存）

1. 点击右上角 **⚙ API Key**
2. 顶部 **AI 引擎** 下拉选择：**豆包** / **DeepSeek** / **OpenRouter**
3. 在弹窗中填写当前引擎对应的 **API Key** 和 **模型 ID**（具体模型由你填的 ID 决定，不在下拉里选版本）

| 引擎 | API Key 获取 | 模型 ID 示例 |
|------|----------------|--------------|
| **豆包** | [火山引擎 ARK → API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)（须为 ARK 专用 Key，不是通用 AccessKey） | 推荐填推理接入点 `ep-xxxxxxxx-xxxxx`；或公开模型如 `doubao-1-5-pro-32k-250115`（全小写、带版本后缀） |
| **DeepSeek** | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | 如 `deepseek-chat`、`deepseek-reasoner` |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | 如 `anthropic/claude-sonnet-4.5`、`openai/gpt-4o`（见 [模型列表](https://openrouter.ai/models)） |

保存后 Key 仅存在**本机浏览器**，换电脑或换浏览器需重新填写。

### 5. 日常使用流程

1. 左侧 **+ 上传文件夹**：选择含 `.docx` / `.txt` / `.md` 的栏目文件夹（顶层文件夹名 = 栏目名）
2. 点击栏目 → 中间输入 **创作大纲** → 可开关 **参考资料库**（用右侧已导入文稿做风格参考）
3. 点击 **✦ 生成脚本** → 可点击段落做定向修改 → **确认稿件** 生成标题/简介 → **导出 Markdown**

### 6. 常见问题（同事向）

| 现象 | 处理 |
|------|------|
| 浏览器打不开 `localhost:5173` | 确认终端里 `npm run dev` 仍在运行；若端口被占用，看终端是否改用了 `5174` 等，用终端里显示的地址访问 |
| `Failed to fetch` / 网络请求失败 | 先确认是用 `npm run dev` 启动，不是直接打开 html 文件 |
| 豆包 `API key format is incorrect` | 请使用 ARK 控制台创建的 API Key，不要用账号通用 AccessKey |
| 豆包 `model ... does not exist` | 模型 ID 须全小写、用 `-` 分隔；推荐用 `ep-...` 接入点 ID |
| OpenRouter / 部分国外模型失败 | 本机可能需要科学上网；或换豆包 / DeepSeek |
| 栏目、文稿、Key 丢了 | 数据在各自浏览器 `localStorage`，清缓存、换电脑会丢失，需重新上传与配置 |

### 7. 更新到最新版

```bash
cd script-workshop
git pull
npm install
npm run dev
```

---

## 常用命令

在**仓库根目录**执行：

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

浏览器默认不允许直接调用各 AI 厂商域名（CORS 限制）。本项目在本地开发时通过 **Vite dev 代理**转发（界面当前开放 **豆包 / DeepSeek / OpenRouter**）：

| 浏览器请求 | 实际转发到 |
|------------|-----------|
| `/api/doubao/*`      | `https://ark.cn-beijing.volces.com/*` |
| `/api/deepseek/*`    | `https://api.deepseek.com/*` |
| `/api/openrouter/*`  | `https://openrouter.ai/*` |

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
