# 部署到 Cloudflare Pages（公开访问）

本文教你把「周树人 · 脚本工坊」发布成一个公开网址，任何人打开链接就能用。

## 先理解两件事（很重要）

1. **你的 API Key 不会上传，也不会泄露。** 这个工具的设计是：每个访问者在
   自己浏览器里填自己的 API Key（存在他们本机浏览器里）。线上服务器（Cloudflare）
   只做「转发」，全程不保存、不读取任何人的 Key。所以你的 Key 完全不进入线上环境。

2. **访问者要用，得自己有 Key。** 因为不用你的 Key，别人打开网页后需要点右上角
   ⚙ 填入他们自己的豆包 / DeepSeek / ChatGPT / OpenRouter 的 Key 才能生成文案。
   费用由他们自己的账号承担。

> 如果你**希望别人不用填 Key、直接用你的 Key**，那是另一种架构（有被滥用刷爆账单的
> 风险），本文不涵盖，需要时告诉维护同事单独改造。

---

## 这次改造做了什么（给你了解，不用动手）

本地用 `npm run dev` 时，是靠 Vite 开发服务器帮你转发 AI 请求的。发布成静态网页后
这个转发不存在了，所以新增了一个 `functions/` 文件夹，用 **Cloudflare Pages Functions**
在云端做同样的转发。前端代码没变，本地 `npm run dev` 照常能用。

| 网址路径 | 作用 |
|----------|------|
| `/api/doubao/*`、`/api/deepseek/*`、`/api/openai/*`、`/api/openrouter/*` | 转发到各家大模型 |
| `/api/openai-relay/*` | 公司中转地址转发 |
| `/api/openalex`、`/api/crossref`、`/api/wiki-zh` | 信源查证 |
| `/api/topic-search` | 选题搜索 |

> ⚠️ **选题搜索**要去抓科普中国 / 果壳 / B站等网站。Cloudflare 服务器在全球各地，
> 抓国内站点可能时好时坏，这是平台特性。AI 写稿、信源查证不受影响。

---

## 第一步：注册 Cloudflare 账号（免费，只做一次）

1. 打开 https://dash.cloudflare.com/sign-up
2. 用邮箱注册，验证邮箱。
3. 免费套餐（Free）就够用：Pages 静态托管免费，Functions 每天 10 万次请求免费。

---

## 第二步：选一种部署方式

有两条路，**方式 A（连 GitHub）最省心**，推荐没经验的同事用。

### 方式 A：连接 GitHub 仓库，自动部署（推荐）

前提：代码已经在 GitHub 仓库 `wangyanlinbj/script-workshop`，并且本文新增的
`functions/` 文件夹已经推上去了（见文末「推送代码」）。

1. 登录 Cloudflare 控制台，左侧点 **Workers 和 Pages** → **创建** → 选 **Pages** 标签
   → **连接到 Git**。
2. 授权 Cloudflare 访问你的 GitHub，选中 `script-workshop` 仓库。
3. 在「构建设置」里填：

   | 选项 | 填什么 |
   |------|--------|
   | 生产分支 (Production branch) | `main` |
   | 框架预设 (Framework preset) | `None`（无 / 不选） |
   | 构建命令 (Build command) | `npm run build` |
   | 构建输出目录 (Build output directory) | `dist` |
   | 根目录 (Root directory) | 留空（就是仓库根目录） |

4. 点 **保存并部署**。等 1～3 分钟，会得到一个网址，形如
   `https://script-workshop.pages.dev`。
5. 打开这个网址，点右上角 ⚙ 填自己的 API Key，测试写稿即可。

> 以后只要往 GitHub 的 `main` 分支推代码，Cloudflare 会**自动重新部署**，不用手动操作。

### 方式 B：本地用命令行直接上传（Wrangler）

适合不想连 GitHub、只想手动发一次的情况。需要你电脑上已装 Node.js。

在项目根目录打开终端，依次执行：

```bash
# 1. 安装 Cloudflare 命令行工具（只需一次）
npm install -g wrangler

# 2. 登录（会弹出浏览器授权）
wrangler login

# 3. 先在本地构建出 dist/
npm run build

# 4. 上传部署（首次会让你给项目起个名字，例如 script-workshop）
wrangler pages deploy dist --project-name=script-workshop
```

上传完成后，终端会打印一个 `https://xxx.pages.dev` 网址，打开即用。

> `functions/` 文件夹会随 `dist` 一起被 Cloudflare 识别（Wrangler 会自动打包
> 项目根目录的 functions），无需额外配置。

---

## 推送代码到 GitHub（方式 A 的前置步骤）

如果你要用方式 A，得先把本次新增的 `functions/` 和本文推到 GitHub：

```bash
cd 项目根目录
git add functions/ DEPLOY_CLOUDFLARE.md .gitignore
git commit -m "feat: 增加 Cloudflare Pages Functions 用于公开部署"
git push origin main
```

> ⚠️ 项目根目录里那个 `id_ed25519` 是 SSH 私钥，**绝不能提交**。本文已经把它加进
> `.gitignore`，`git add functions/ ...` 这种精确添加也不会带上它。建议尽快把它移到
> `~/.ssh/` 下：`mv id_ed25519 ~/.ssh/ && chmod 600 ~/.ssh/id_ed25519`。

---

## 常见问题

**Q：部署后点「生成脚本」报网络错误？**
先确认右上角 ⚙ 里填了对应引擎的 API Key，并点「测试当前引擎」。豆包 / DeepSeek
国内可直连；ChatGPT 若用官方地址，访问者本地网络需能访问 OpenAI，或改用公司中转地址。

**Q：选题搜索没结果 / 很慢？**
Cloudflare 服务器抓国内站点不稳定属正常现象。可在选题面板里少留几个信源，或关掉部分
国外站点重试。AI 写稿和信源查证不受影响。

**Q：想换个更好记的网址？**
在 Cloudflare Pages 项目的「自定义域」里绑定你自己的域名即可（需要你拥有一个域名）。

**Q：想限制只有内部人能访问？**
Cloudflare 免费版可用 **Cloudflare Access**（零信任）给页面加登录验证，或用付费的
Web Analytics / 访问策略。需要时告诉维护同事配置。

---

## 本地开发不受影响

以上改造只新增了 `functions/` 文件夹，没有改动 `vite.config.js` 和 `server/`。
本地照常 `npm run dev` 即可开发调试。


