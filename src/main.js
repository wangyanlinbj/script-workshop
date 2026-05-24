import { Document, Packer, Paragraph, TextRun } from 'docx';
import { fetchGroundedSources } from './sourceLookup.js';

/** 标题/简介候选项（用于点击选择，避免把文案写进 onclick 造成引号与特殊字符问题） */
let __metaTitles = [];
let __metaDescs = [];

const DEFAULT_CREATOR_IDENTITY = `你是一个擅长将复杂知识转化为短视频脚本的内容专家，
擅长用拟人化、生活化表达，让内容有趣但不失科学严谨。

请严格按照以下结构生成脚本：

1. Hook引入（制造兴趣/误解/反常识）
2. 角色或对象登场（可拟人化）
3. 抛出核心问题
4. 机制解释（必须清晰、通俗、完整）
5. 类比或拟人强化理解
6. 扩展或对比（可选）
7. 收尾总结（回扣主题或提问）

风格要求：
- 像聊天，不书面
- 解释清晰、科学
- 可加入拟人对话
- 多用短句
- 避免废话

内容策略：
- 必须有钩子
- 必须讲清一个核心知识点
- 必须有“为什么”
- 尽量用生活化类比`;

let __creatorIdentityTimer;

// State & Provider Config
// ═══════════════════════════════════════════
const S = {
  columns: [],
  docs: {},
  expandedCols: new Set(),
  activeCol: null,
  script: '',
  selection: null,      // { start, end, text } 鼠标拖选范围（相对 S.script）
  chatHistory: [],      // multi-turn chat for current selection
  selTitle: '',
  selDesc: '',
  currentProvider: 'doubao', // 'doubao' | 'deepseek'
  useRef: true,         // whether to inject reference docs into prompt
  sourceEntries: [],    // { id, sentence, content, createdAt }
  activeSourceId: null,
};

/**
 * provider 接口配置：
 * - endpoint 走 Vite dev 代理（见 vite.config.js）以绕开浏览器 CORS 限制。
 * - 具体调用哪个模型，由 API Key 弹窗里的「模型 ID」决定（modelKey 对应 localStorage 的字段）。
 * - 生产环境需要由托管层提供 /api/<provider>/* 的反向代理；否则只能改回厂商真实域名。
 */
const PROVIDER_CFG = {
  doubao:   {
    endpoint: '/api/doubao/api/v3',
    keyId: 'doubaoKey',
    modelKey: 'doubaoModelId',
    format: 'openai',
    name: '豆包',
  },
  deepseek: {
    endpoint: '/api/deepseek/v1',
    keyId: 'deepseekKey',
    modelKey: 'deepseekModelId',
    format: 'openai',
    name: 'DeepSeek',
  },
  openai: {
    endpoint: '/api/openai/v1',
    relayEndpoint: '/api/openai-relay',
    baseUrlKey: 'openaiBaseUrl',
    keyId: 'openaiKey',
    modelKey: 'openaiModelId',
    format: 'openai',
    name: 'ChatGPT',
  },
  openrouter: {
    endpoint: '/api/openrouter/api/v1',
    keyId: 'openrouterKey',
    modelKey: 'openrouterModelId',
    format: 'openai',
    name: 'OpenRouter',
    extraHeaders: {
      'HTTP-Referer': 'http://localhost:5173/',
      'X-Title': '周树人',
    },
  },
};

function currentProvider() { return PROVIDER_CFG[S.currentProvider] ? S.currentProvider : 'doubao'; }

function ls(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lss(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ═══════════════════════════════════════════
// Init
// ═══════════════════════════════════════════
/** 已开放的 provider key（用于 saveApiKeys/init 同步 localStorage 与表单） */
const KEY_FIELDS = [
  'doubaoKey', 'doubaoModelId',
  'deepseekKey', 'deepseekModelId',
  'openaiKey', 'openaiModelId', 'openaiBaseUrl',
  'openrouterKey', 'openrouterModelId',
];

/** 读取配置：优先表单当前值，其次 localStorage（便于未点「保存」也能用） */
function fieldValue(key) {
  const el = document.getElementById(key);
  const fromInput = (el?.value || '').trim();
  if (fromInput) return fromInput;
  return (ls(key) || '').trim();
}

/** 将 API 设置写入 localStorage；clearEmpty 为 true 时允许清空已删字段 */
function persistApiSettings({ clearEmpty = false, silent = true } = {}) {
  KEY_FIELDS.forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    const v = el.value.trim();
    if (v) lss(k, v);
    else if (clearEmpty) { try { localStorage.removeItem(k); } catch {} }
  });
  lss('currentProvider', S.currentProvider);
  if (!silent) showToast('✓ 已保存');
}

let __apiPersistTimer;
function bindApiSettingsPersistence() {
  const modal = document.getElementById('apiKeyModal');
  if (!modal || modal.dataset.persistBound) return;
  modal.dataset.persistBound = '1';
  KEY_FIELDS.forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    el.addEventListener('input', () => {
      clearTimeout(__apiPersistTimer);
      __apiPersistTimer = setTimeout(() => persistApiSettings(), 500);
    });
    el.addEventListener('change', () => persistApiSettings());
  });
  const testBtn = document.getElementById('apiTestBtn');
  if (testBtn && !testBtn.dataset.bound) {
    testBtn.dataset.bound = '1';
    testBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      testCurrentProvider();
    });
  }
}

function init() {
  S.currentProvider = ls('currentProvider') || 'doubao';
  if (!PROVIDER_CFG[S.currentProvider]) S.currentProvider = 'doubao';
  S.useRef = ls('useRef') !== 'false';
  updateProviderUI();
  updateRefToggleUI();

  const savedCols = ls('columns');
  if (savedCols) {
    try { S.columns = JSON.parse(savedCols); } catch {}
  }
  const savedDocs = ls('docs');
  if (savedDocs) {
    try { S.docs = JSON.parse(savedDocs); } catch {}
  }

  loadExpandedCols();
  loadSourceEntries();
  renderColumns();
  renderCitationsPanel();

  KEY_FIELDS.forEach(k => {
    const v = ls(k);
    const el = document.getElementById(k);
    if (el && v) el.value = v;
  });
  bindApiSettingsPersistence();
  initCreatorIdentity();

  const metaWrap = document.getElementById('metaWrap');
  if (metaWrap && !metaWrap.dataset.metaClickBound) {
    metaWrap.dataset.metaClickBound = '1';
    metaWrap.addEventListener('click', (e) => {
      const el = e.target.closest('.meta-opt');
      if (!el) return;
      const kind = el.dataset.kind;
      const idx = Number(el.dataset.idx);
      if (kind === 'title') pickMeta('title', idx, __metaTitles[idx]);
      else if (kind === 'desc') pickMeta('desc', idx, __metaDescs[idx]);
    });
  }
}

// ═══════════════════════════════════════════
// Folder Upload
// ═══════════════════════════════════════════
function openFolderUpload() {
  document.getElementById('folderInput').value = '';
  document.getElementById('folderInput').click();
}

async function handleFolderUpload(e) {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  // Group by top-level folder name
  const folders = {};
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 2) continue;
    const folderName = parts[0];
    const isTopLevel = parts.length === 2;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!isTopLevel) continue;
    if (!['docx', 'doc', 'txt', 'md'].includes(ext)) continue;
    if (!folders[folderName]) folders[folderName] = [];
    folders[folderName].push(file);
  }

  const folderNames = Object.keys(folders);
  if (folderNames.length === 0) {
    showToast('未在文件夹中找到 Word / txt 文档');
    return;
  }

  const prog = document.getElementById('uploadProgress');
  const progTxt = document.getElementById('uploadProgressTxt');
  prog.classList.add('show');

  for (const folderName of folderNames) {
    const folderFiles = folders[folderName];
    progTxt.textContent = `正在解析「${folderName}」(${folderFiles.length} 个文件)…`;

    // Check if a column with the same name already exists
    let col = S.columns.find(c => c.name === folderName);
    if (!col) {
      col = { id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name: folderName, emoji: guessEmoji(folderName), source: 'local' };
      S.columns.push(col);
    }
    if (!S.docs[col.id]) S.docs[col.id] = [];

    for (const file of folderFiles) {
      progTxt.textContent = `解析「${file.name}」…`;
      let content = '';
      const ext = file.name.split('.').pop().toLowerCase();
      try {
        if (ext === 'txt' || ext === 'md') {
          content = await readTextFile(file);
        } else if (ext === 'docx') {
          content = await readDocxFile(file);
        } else {
          content = `[${ext.toUpperCase()} 文件，暂不支持预览]`;
        }
      } catch (err) {
        content = `[解析失败：${err.message}]`;
      }

      // Avoid duplicates by file name
      const existing = S.docs[col.id].findIndex(d => d.name === file.name);
      const docEntry = {
        id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: file.name,
        content,
        size: formatSize(file.size),
        date: new Date().toLocaleDateString('zh-CN'),
        source: 'local',
        loaded: true,
      };
      if (existing >= 0) S.docs[col.id][existing] = docEntry;
      else S.docs[col.id].push(docEntry);
    }
    S.expandedCols.add(col.id);
  }

  prog.classList.remove('show');

  try { lss('columns', JSON.stringify(S.columns)); } catch {}
  try { lss('docs', JSON.stringify(S.docs)); } catch {}
  persistExpandedCols();

  renderColumns();
  showToast(`✓ 已导入 ${folderNames.length} 个栏目`);
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('读取失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

async function readDocxFile(file) {
  const { default: mammothMod } = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammothMod.extractRawText({ arrayBuffer });
  return result.value || '';
}

function guessEmoji(name) {
  const map = [['科普','🔬'],['问答','💬'],['知识','📚'],['解析','🔭'],['故事','📖'],['文化','🏛'],['科技','⚡'],['自然','🌱'],['历史','🏛'],['生活','🌿'],['美食','🍜'],['动物','🦁'],['健康','💊'],['旅行','✈️'],['财经','📈'],['教育','🎓']];
  for (const [k, e] of map) if (name.includes(k)) return e;
  return '📁';
}

// ═══════════════════════════════════════════
// UI: 栏目列表（含参考文稿）
// ═══════════════════════════════════════════
function loadExpandedCols() {
  S.expandedCols = new Set();
  try {
    const raw = ls('expandedCols');
    if (raw) JSON.parse(raw).forEach(id => S.expandedCols.add(id));
  } catch {}
}

function persistExpandedCols() {
  try { lss('expandedCols', JSON.stringify([...S.expandedCols])); } catch {}
}

function toggleColExpand(e, colId) {
  e.stopPropagation();
  if (S.expandedCols.has(colId)) S.expandedCols.delete(colId);
  else S.expandedCols.add(colId);
  persistExpandedCols();
  renderColumns();
}

function renderColDocsHtml(colId) {
  const docs = S.docs[colId] || [];
  if (docs.length === 0) {
    return '<div class="col-docs-empty">暂无参考文稿</div>';
  }
  return docs.map(doc => `
    <div class="doc-item" id="di_${colId}_${doc.id}" onclick="previewDoc(event,'${colId}','${doc.id}')">
      <div class="doc-icon">${docIcon(doc.name)}</div>
      <div class="doc-info">
        <div class="doc-name">${escHtml(doc.name)}</div>
        <div class="doc-meta"><span>${doc.size}</span><span>${doc.date}</span></div>
      </div>
    </div>`).join('');
}

function renderColumns() {
  const list = document.getElementById('colList');
  if (!list) return;
  if (S.columns.length === 0) {
    list.innerHTML = `<div style="padding:28px 12px;text-align:center;color:var(--ink-faint);font-size:13px;line-height:2">
      <div style="font-size:28px;margin-bottom:8px">📁</div>
      点击「+ 上传文件夹」<br>添加栏目与参考文稿
    </div>`;
    return;
  }
  list.innerHTML = S.columns.map(col => {
    const cnt = (S.docs[col.id] || []).length;
    const expanded = S.expandedCols.has(col.id);
    const active = S.activeCol === col.id;
    return `<div class="col-group${active ? ' active' : ''}">
      <div class="col-row">
        <button type="button" class="col-expand${expanded ? ' open' : ''}" onclick="toggleColExpand(event,'${col.id}')" title="${expanded ? '收起文稿' : '展开文稿'}" aria-expanded="${expanded}">▸</button>
        <div class="col-main" onclick="selectCol('${col.id}')">
          <div class="col-icon">${col.emoji}</div>
          <div class="col-info">
            <div class="col-name">${escHtml(col.name)}</div>
            <div class="col-sub">${cnt > 0 ? cnt + ' 篇参考文稿' : '暂无参考文稿'}</div>
          </div>
        </div>
        <button type="button" class="col-del" onclick="deleteCol(event,'${col.id}')" title="删除栏目">✕</button>
      </div>
      <div class="col-docs${expanded ? ' open' : ''}">${renderColDocsHtml(col.id)}</div>
    </div>`;
  }).join('');
}

function deleteCol(e, colId) {
  e.stopPropagation();
  S.columns = S.columns.filter(c => c.id !== colId);
  delete S.docs[colId];
  S.expandedCols.delete(colId);
  persistExpandedCols();
  if (S.activeCol === colId) {
    S.activeCol = null;
    resetEditor();
  }
  try { lss('columns', JSON.stringify(S.columns)); } catch {}
  try { lss('docs', JSON.stringify(S.docs)); } catch {}
  renderColumns();
  showToast('已删除栏目');
}

function selectCol(id) {
  S.activeCol = id;
  S.expandedCols.add(id);
  persistExpandedCols();
  const col = S.columns.find(c => c.id === id);
  renderColumns();
  showEditorArea(col);
  document.getElementById('outlineInput').value = '';
  updateCC();
  document.getElementById('scriptCard').classList.remove('show');
  document.getElementById('scriptLabel').style.display = 'none';
  document.getElementById('metaWrap').classList.remove('show');
  document.getElementById('exportBar').classList.remove('show');
  S.script = ''; S.selection = null; S.chatHistory = [];
  S.selTitle = ''; S.selDesc = '';
  document.getElementById('chatCard').style.display = 'none';
  document.getElementById('paraHint').style.display = 'none';
  closePrev();
}

function showEditorArea(col) {
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('edActive').style.display = 'flex';
  document.getElementById('edToolbar').innerHTML = `
    <div class="col-badge"><div class="badge-dot"></div>${col.emoji} ${escHtml(col.name)}</div>
  `;
}

function resetEditor() {
  document.getElementById('emptyState').style.display = 'flex';
  document.getElementById('edActive').style.display = 'none';
  document.getElementById('edToolbar').innerHTML = `<span style="font-size:12px;color:var(--ink-faint)">← 选择栏目开始创作</span>`;
  closePrev();
}

function docIcon(n) {
  if (n.endsWith('.pdf')) return '📕';
  if (n.endsWith('.docx') || n.endsWith('.doc')) return '📘';
  if (n.endsWith('.md')) return '📋';
  return '📄';
}

function previewDoc(e, colId, docId) {
  e?.stopPropagation?.();
  const doc = (S.docs[colId] || []).find(d => d.id === docId);
  if (!doc) return;
  document.querySelectorAll('.doc-item').forEach(el => el.classList.remove('active-ref'));
  document.getElementById(`di_${colId}_${docId}`)?.classList.add('active-ref');
  document.getElementById('prevTitle').textContent = doc.name;
  const preview = (doc.content || '（无内容）').slice(0, 2000) + (doc.content?.length > 2000 ? '\n…（仅显示前2000字）' : '');
  document.getElementById('prevBody').textContent = preview;
  document.getElementById('prevPanel').classList.add('show');
}

function closePrev() { document.getElementById('prevPanel')?.classList.remove('show'); }

// ═══════════════════════════════════════════
// AI Generation
// ═══════════════════════════════════════════
function getCreatorIdentity() {
  const el = document.getElementById('creatorIdentityInput');
  const v = (el?.value || ls('creatorIdentity') || DEFAULT_CREATOR_IDENTITY).trim();
  return v || DEFAULT_CREATOR_IDENTITY;
}

function updateIdentityCC() {
  const el = document.getElementById('identityCcNum');
  const input = document.getElementById('creatorIdentityInput');
  if (el && input) el.textContent = input.value.length;
}

function persistCreatorIdentity() {
  const el = document.getElementById('creatorIdentityInput');
  if (!el) return;
  lss('creatorIdentity', el.value);
}

function onCreatorIdentityInput() {
  updateIdentityCC();
  clearTimeout(__creatorIdentityTimer);
  __creatorIdentityTimer = setTimeout(persistCreatorIdentity, 500);
}

function toggleCreatorIdentity() {
  const block = document.getElementById('identityBlock');
  const btn = document.getElementById('identityToggle');
  if (!block) return;
  const collapsed = block.classList.toggle('collapsed');
  lss('creatorIdentityCollapsed', collapsed ? 'true' : 'false');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function resetCreatorIdentity() {
  const el = document.getElementById('creatorIdentityInput');
  if (!el) return;
  el.value = DEFAULT_CREATOR_IDENTITY;
  updateIdentityCC();
  persistCreatorIdentity();
  showToast('已恢复默认创作者身份');
}

function initCreatorIdentity() {
  const el = document.getElementById('creatorIdentityInput');
  if (!el) return;
  el.value = ls('creatorIdentity') || DEFAULT_CREATOR_IDENTITY;
  updateIdentityCC();
  const block = document.getElementById('identityBlock');
  if (block && ls('creatorIdentityCollapsed') === 'true') {
    block.classList.add('collapsed');
    document.getElementById('identityToggle')?.setAttribute('aria-expanded', 'false');
  }
}

function hasReferenceDocs() {
  if (!S.useRef || !S.activeCol) return false;
  return (S.docs[S.activeCol] || []).some(d => (d.content || '').trim());
}

function buildRefsBlock() {
  if (!S.useRef) return '';
  const docs = (S.docs[S.activeCol] || []).filter(d => (d.content || '').trim());
  if (docs.length === 0) return '';
  const refs = docs
    .map((d, i) => `【参考文稿${i + 1}：${d.name}】\n${d.content.slice(0, 2500)}`)
    .join('\n\n---\n\n');
  return `

---

【参考资料库 · 风格仿写要求】
以下文稿来自当前栏目，是你写本期脚本时的风格范本。请先通读，再动笔。

你必须在语言风格与文字结构上与参考文稿保持一致，包括但不限于：
- 用词口气：口语/书面程度、人称、幽默或严肃调性、惯用说法
- 句式节奏：短句长句比例、设问/反问频率、排比或递进等修辞习惯
- 段落结构：开场方式、分段习惯、转折衔接、举例位置、收尾收束
- 信息展开：先抛问题再解释、先现象再机理等讲述顺序

可以替换为本期大纲的主题与事实，但不要写成另一种频道语气；禁止明显偏离参考文稿的叙述框架。

【参考文稿正文】
${refs}`;
}

function buildSystemPrompt() {
  const refsBlock = buildRefsBlock();
  const mimicNote = refsBlock
    ? '\n\n继续执行上方的风格仿写要求：成稿的语言风格与段落结构须让人听出是「同一栏目」。'
    : '';
  return `${getCreatorIdentity()}${refsBlock}${mimicNote}

直接输出脚本正文，不要标注格式说明或结构标题。`;
}

function buildGenerateUserPrompt(outline) {
  const refHint = hasReferenceDocs()
    ? '\n\n本期须严格模仿 system 中参考文稿的语言风格与文字结构（口气、句式、段落编排、讲述顺序），仅替换为本期大纲的主题内容。'
    : '';
  return `【创作大纲】
${outline}

请根据上方的「创作者身份」要求与本期创作大纲，生成约500字的视频逐字稿，适合对镜头直接口播。
内容须基于科学事实，不要瞎编：不得虚构数据、研究结论、机构观点或文献；不确定处用谨慎表述或省略，勿捏造。${refHint}`;
}

/** 从非 2xx 响应里尽量读出可读错误（兼容 JSON / HTML / 纯文本） */
async function _readApiErrorMessage(res) {
  const raw = await res.text().catch(() => '');
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const tryJson = raw.trim().startsWith('{') || ct.includes('application/json');
  if (tryJson && raw) {
    try {
      const j = JSON.parse(raw);
      const msg = j?.error?.message || j?.error?.type || j?.message || j?.detail;
      if (msg) return `${msg}（HTTP ${res.status}）`;
    } catch { /* fall through */ }
  }
  const trimmed = raw.replace(/\s+/g, ' ').trim().slice(0, 600);
  if (trimmed) return `${trimmed}（HTTP ${res.status}）`;
  return `HTTP ${res.status}`;
}

/** 网络层错误的友好包装：把 fetch 抛出的 TypeError("Load failed") 等转成可读提示 */
async function _safeFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const detail = [err?.name, err?.message].filter(Boolean).join(': ') || String(err);
    throw new Error(`网络请求失败：${detail}（若使用公司中转，请核对 API 地址并重启 npm run dev）`);
  }
}

// ── 核心请求函数（接受完整 messages 数组）──
async function _callAnthropicStream(endpoint, key, system, messages, onChunk) {
  const res = await _safeFetch(`${endpoint}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: resolveModelId(), max_tokens: 1500, stream: true, system, messages }),
  });
  if (!res.ok) throw new Error(await _readApiErrorMessage(res));
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue;
      const d = ln.slice(6).trim(); if (d === '[DONE]') return;
      try { const ev = JSON.parse(d); if (ev.delta?.text) onChunk(ev.delta.text); } catch {}
    }
  }
}

/** 根据 HTTP 状态与文案，给出可操作的排查提示（尤其 OpenAI / 代理） */
function enrichApiError(message, provider = currentProvider()) {
  const msg = String(message || '未知错误');
  const cfg = PROVIDER_CFG[provider];
  const name = cfg?.name || provider;

  if (provider !== 'openai' && fieldValue('openaiKey') && !fieldValue(cfg?.keyId || '')) {
    return `当前 AI 引擎是「${name}」，但未配置其 API Key。你已填写 ChatGPT 的 Key 时，请先在右上角 AI 引擎切换为 ChatGPT。`;
  }

  if (/ENOTFOUND|Upstream proxy error|502|503|504|网络请求失败|Load failed|Type error|TypeError|Failed to fetch|fetch failed/i.test(msg)) {
    if (provider === 'openai' && fieldValue('openaiBaseUrl')) {
      const base = fieldValue('openaiBaseUrl');
      return `${msg}\n\n【公司中转网络排查】请求将发往：${base}\n1. 地址须以 https:// 开头，完整复制（含 /v1），前后不要有空格\n2. 若是公司内网域名，请先连公司 VPN 再测试\n3. 必须 Ctrl+C 停掉 dev 后重新 npm run dev（加载中转代理）\n4. 看运行 dev 的终端是否出现 [openai-relay] upstream error\n5. 若为公司自签证书，可在 web/.env.development.local 写 ALLOW_INSECURE_SSL=true 后重启 dev`;
    }
    if (provider === 'openai' || provider === 'openrouter') {
      return `${msg}\n\n【ChatGPT 网络排查】走 OpenAI 官方时需本机 Node 能访问 api.openai.com：\n1. npm run dev:clash 或 HTTPS_PROXY=http://127.0.0.1:7890 npm run dev\n2. 公司中转 Key 请填写「公司中转 API 地址」，不要留空\n3. 确认用 npm run dev 打开，不是双击 html`;
    }
  }

  if (/403|Forbidden|permission|not allowed|denied/i.test(msg)) {
    if (provider === 'openai' && fieldValue('openaiBaseUrl')) {
      const model = fieldValue('openaiModelId') || '（未填）';
      return `${msg}\n\n【403 公司中转】请求已到达 ${fieldValue('openaiBaseUrl')}，但被拒绝。常见原因：\n1. 模型「${model}」不在你的 Key 权限内 → 到公司网页查可用模型名并原样填写\n2. Key 过期、无余额、或账号未开通该模型\n3. 公司要求 IP 白名单（需 IT 添加你当前出口 IP）\n4. 看运行 npm run dev 的终端里 [openai-relay] 403 后面的详细报错`;
    }
  }

  if (/401|invalid_api_key|Incorrect API key|authentication/i.test(msg)) {
    if (provider === 'openai' && fieldValue('openaiBaseUrl')) {
      return `${msg}\n\n【公司中转排查】Key 已走公司中转地址。请核对：\n1. 「公司中转 API 地址」是否与网页文档一致（常含 /v1）\n2. 模型 ID 是否用公司文档里的名称\n3. Key 是否过期、是否有额度`;
    }
    if (provider === 'openai' && /^sk-mg/i.test(fieldValue('openaiKey') || '')) {
      return `${msg}\n\n【公司中转 Key】检测到 sk-mg- 开头 Key，不能走 OpenAI 官方。请在 ChatGPT 配置里填写「公司中转 API 地址」。`;
    }
    return `${msg}\n\n【Key 排查】请检查 ${name} 的 API Key 是否完整、未过期，账户是否有余额。`;
  }

  if (/model.*(not|exist|found|invalid)|unsupported.*model|404/i.test(msg)) {
    return `${msg}\n\n【模型排查】请检查模型 ID 拼写。ChatGPT 常用：gpt-4o、gpt-4o-mini。`;
  }

  if (/max_tokens|max_completion_tokens|unsupported_parameter/i.test(msg)) {
    return `${msg}\n\n【参数排查】部分 OpenAI 新模型不支持 max_tokens，请换 gpt-4o / gpt-4o-mini，或联系维护同事升级接口。`;
  }

  return msg;
}

function setApiTestStatus(text, kind = '') {
  const el = document.getElementById('apiTestStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'api-test-status' + (kind ? ` is-${kind}` : '');
}

async function testCurrentProvider() {
  const provider = currentProvider();
  const cfg = PROVIDER_CFG[provider];
  const btn = document.getElementById('apiTestBtn');
  if (btn?.disabled) return;

  persistApiSettings();
  setApiTestStatus('', '');

  try {
    _getProviderKey();
    resolveModelId();
    if (provider === 'openai' && /^sk-mg/i.test(fieldValue('openaiKey') || '') && !fieldValue('openaiBaseUrl')) {
      throw new Error('检测到公司中转 Key（sk-mg-…），请填写「公司中转 API 地址」。');
    }
    if (provider === 'openai' && fieldValue('openaiBaseUrl')) {
      normalizeOpenAIBaseUrl(fieldValue('openaiBaseUrl'));
    }
  } catch (e) {
    const msg = enrichApiError(e.message, provider);
    setApiTestStatus(msg, 'err');
    showToast('❌ ' + msg.split('\n')[0], 5000);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  setApiTestStatus(`正在测试「${cfg.name}」连接，请稍候…`, 'info');
  showToast(`正在测试 ${cfg.name}…`, 4000);

  try {
    let got = false;
    await callStream('只回复一个字：好', '你只输出一个字，不要解释。', t => { got = got || !!t; });
    persistApiSettings();
    const okMsg = got ? `✓ ${cfg.name} 连接成功，可以正常生成脚本。` : `✓ ${cfg.name} 已响应（返回内容为空，可再试一次）。`;
    setApiTestStatus(okMsg, 'ok');
    showToast(got ? `✓ ${cfg.name} 连接成功` : `✓ ${cfg.name} 已响应`, 4000);
  } catch (e) {
    const msg = enrichApiError(e.message, provider);
    setApiTestStatus(msg, 'err');
    showToast('❌ ' + msg.split('\n')[0], 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '测试当前引擎'; }
  }
}

async function _callOpenAIStream(cfg, key, system, messages, onChunk) {
  const allMsgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const { endpoint, relayBase } = cfg.keyId === 'openaiKey'
    ? resolveOpenAIEndpoint(cfg)
    : { endpoint: cfg.endpoint, relayBase: '' };
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
    ...(relayBase ? { 'X-OpenAI-Base': relayBase } : {}),
    ...(cfg.extraHeaders || {}),
  };
  const model = resolveModelId();
  const bodyBase = { model, stream: true, messages: allMsgs };
  const tryBodies = [
    { ...bodyBase, max_tokens: 1500 },
    { ...bodyBase, max_completion_tokens: 1500 },
  ];

  let lastErr = '';
  for (const body of tryBodies) {
    const res = await _safeFetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      lastErr = await _readApiErrorMessage(res);
      if (/max_tokens|max_completion_tokens|unsupported_parameter/i.test(lastErr) && body === tryBodies[0]) {
        continue;
      }
      throw new Error(enrichApiError(lastErr));
    }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const ln of lines) {
        if (!ln.startsWith('data: ')) continue;
        const d = ln.slice(6).trim(); if (d === '[DONE]') return;
        try { const ev = JSON.parse(d); const t = ev.choices?.[0]?.delta?.content || ''; if (t) onChunk(t); } catch {}
      }
    }
    return;
  }
  throw new Error(enrichApiError(lastErr || 'OpenAI 请求失败'));
}

/** OpenAI 官方 vs 公司中转：填了 Base URL 则走 /api/openai-relay */
function normalizeOpenAIBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  try {
    const u = new URL(s);
    if (!u.hostname) throw new Error('invalid');
    let path = u.pathname.replace(/\/+$/, '') || '';
    path = path.replace(/\/chat\/completions$/i, '');
    // 只填域名时（如 https://model.zhenguanyu.com）自动补 /v1
    if (!path || path === '/') path = '/v1';
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    throw new Error('公司中转 API 地址格式不正确，请填写如 https://域名/v1');
  }
}

function resolveOpenAIEndpoint(cfg) {
  const customBase = normalizeOpenAIBaseUrl(fieldValue(cfg.baseUrlKey || 'openaiBaseUrl'));
  if (customBase) {
    return { endpoint: cfg.relayEndpoint || '/api/openai-relay', relayBase: customBase };
  }
  return { endpoint: cfg.endpoint, relayBase: '' };
}

function resolveModelId() {
  persistApiSettings();
  const cfg = PROVIDER_CFG[currentProvider()];
  const id = fieldValue(cfg.modelKey);
  if (!id) throw new Error(`请先在 ⚙ API Key 弹窗里填写 ${cfg.name} 的「模型 ID」`);
  return id;
}

function _getProviderKey() {
  persistApiSettings();
  const provider = currentProvider();
  const cfg = PROVIDER_CFG[provider];
  const key = fieldValue(cfg.keyId);
  if (!key) {
    if (provider !== 'openai' && fieldValue('openaiKey')) {
      throw new Error(`你已填写 ChatGPT 的 API Key，但当前 AI 引擎是「${cfg.name}」。请在右上角切换为 ChatGPT 后再试。`);
    }
    throw new Error(`请先在 ⚙ API Key 弹窗里填写 ${cfg.name} 的 API Key，并确认右上角 AI 引擎已选 ${cfg.name}`);
  }
  return { cfg, key };
}

// 单轮：prompt + system → stream
async function callStream(prompt, system, onChunk) {
  const { cfg, key } = _getProviderKey();
  const messages = [{ role: 'user', content: prompt }];
  if (cfg.format === 'anthropic') await _callAnthropicStream(cfg.endpoint, key, system, messages, onChunk);
  else await _callOpenAIStream(cfg, key, system, messages, onChunk);
}

// 多轮：messages history → stream（用于段落对话修改）
async function callStreamWithHistory(system, messages, onChunk) {
  const { cfg, key } = _getProviderKey();
  if (cfg.format === 'anthropic') await _callAnthropicStream(cfg.endpoint, key, system, messages, onChunk);
  else await _callOpenAIStream(cfg, key, system, messages, onChunk);
}

async function generate() {
  const outline = document.getElementById('outlineInput').value.trim();
  if (!outline) { showToast('请先输入大纲内容'); return; }
  persistCreatorIdentity();

  S.script = '';
  S.selection = null;
  S.chatHistory = [];
  const body = document.getElementById('scriptBody');
  const card = document.getElementById('scriptCard');
  document.getElementById('scriptLabel').style.display = 'flex';
  card.classList.add('show');
  body.innerHTML = '';
  body.style.whiteSpace = 'pre-wrap';
  body.classList.add('streaming');
  document.getElementById('paraHint').style.display = 'none';
  document.getElementById('chatCard').style.display = 'none';
  document.getElementById('metaWrap').classList.remove('show');
  document.getElementById('exportBar').classList.remove('show');

  const btn = document.getElementById('genBtn');
  btn.disabled = true;
  document.getElementById('genBtnTxt').textContent = '生成中…';

  const onChunk = t => {
    S.script += t;
    body.textContent = S.script;
    document.getElementById('wordCt').textContent = S.script.replace(/\s/g, '').length;
  };

  try {
    const sys = buildSystemPrompt();
    const prompt = buildGenerateUserPrompt(outline);
    await callStream(prompt, sys, onChunk);
    persistApiSettings();
    showToast('✓ 脚本生成完成');
  } catch (e) {
    const errMsg = enrichApiError(e.message);
    body.style.whiteSpace = '';
    body.innerHTML = `<div style="padding:16px 8px;color:var(--accent);font-size:13px;line-height:1.9">
      <strong>生成失败</strong><br>${escHtml(errMsg).replace(/\n/g, '<br>')}
    </div>`;
    document.getElementById('wordCt').textContent = '0';
    showToast('❌ ' + errMsg.split('\n')[0]);
  } finally {
    body.classList.remove('streaming');
    btn.disabled = false;
    document.getElementById('genBtnTxt').textContent = '✦ 生成脚本';
    body.style.whiteSpace = '';
    renderScriptContent();
    if (S.script.trim()) {
      document.getElementById('paraHint').style.display = 'block';
    }
    updateSourceReqBtn();
    body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

const META_SYS = '你是短视频标题与简介策划专家。只返回纯JSON，不加任何解释或代码块标记。';
const META_ENGAGE = '风格要求：要吸引人点击，趣味性强，可用悬念、反差、提问或巧妙比喻，避免平淡说明书口吻。';

const META_FALLBACK_TITLES = ['熬夜后大脑在偷偷补课？', '你以为在发呆，其实在记东西', '记忆为啥睡一觉就变牢了'];
const META_FALLBACK_DESCS = ['看完这条，再也不敢随便熬夜了', '原来睡觉才是记忆的隐藏技能'];

async function callMetaJson(prompt) {
  let raw = '';
  await callStream(prompt, META_SYS, t => { raw += t; });
  persistApiSettings();
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

function setMetaLoading(kind, loading) {
  const optsId = kind === 'title' ? 'titleOpts' : 'descOpts';
  const btnId = kind === 'title' ? 'regenTitleBtn' : 'regenDescBtn';
  const opts = document.getElementById(optsId);
  const btn = document.getElementById(btnId);
  if (loading) {
    if (opts) opts.innerHTML = '<div class="meta-loading">生成中…</div>';
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  } else if (btn) {
    btn.disabled = false;
    btn.textContent = '重新生成';
  }
}

function clearMetaSelection(kind) {
  if (kind === 'title') {
    S.selTitle = null;
    document.querySelectorAll('#titleOpts .meta-opt').forEach(el => el.classList.remove('selected'));
    const exp = document.getElementById('expTitle');
    if (exp) exp.textContent = '—';
  } else {
    S.selDesc = null;
    document.querySelectorAll('#descOpts .meta-opt').forEach(el => el.classList.remove('selected'));
    const exp = document.getElementById('expDesc');
    if (exp) exp.textContent = '—';
  }
  if (!S.selTitle || !S.selDesc) document.getElementById('exportBar')?.classList.remove('show');
}

function renderMeta(titles, descs, { restoreSelection = true } = {}) {
  __metaTitles = titles;
  __metaDescs = descs;
  const prevTitle = S.selTitle;
  const prevDesc = S.selDesc;
  document.getElementById('titleOpts').innerHTML = titles.map((t, i) => `
    <div class="meta-opt" data-kind="title" data-idx="${i}">
      <span class="meta-opt-text">${escHtml(t)}</span><span class="meta-opt-ct">${t.length}字</span>
    </div>`).join('');
  document.getElementById('descOpts').innerHTML = descs.map((d, i) => `
    <div class="meta-opt" data-kind="desc" data-idx="${i}">
      <span class="meta-opt-text">${escHtml(d)}</span><span class="meta-opt-ct">${d.length}字</span>
    </div>`).join('');
  if (!restoreSelection) return;
  if (prevTitle) {
    const ti = titles.indexOf(prevTitle);
    if (ti >= 0) pickMeta('title', ti, prevTitle);
    else clearMetaSelection('title');
  }
  if (prevDesc) {
    const di = descs.indexOf(prevDesc);
    if (di >= 0) pickMeta('desc', di, prevDesc);
    else clearMetaSelection('desc');
  }
}

async function regenerateMetaTitles() {
  if (!S.script) { showToast('还没有脚本内容'); return; }
  document.getElementById('metaWrap')?.classList.add('show');
  setMetaLoading('title', true);
  try {
    const prompt = `根据以下视频脚本，生成3条短视频标题备选。返回格式：{"titles":["标题1","标题2","标题3"]}\n每条12字以内。${META_ENGAGE}\n\n脚本：\n${S.script.slice(0, 800)}`;
    const parsed = await callMetaJson(prompt);
    clearMetaSelection('title');
    renderMeta(parsed.titles || META_FALLBACK_TITLES, __metaDescs.length ? __metaDescs : META_FALLBACK_DESCS, { restoreSelection: true });
    showToast('✓ 标题已重新生成');
  } catch (e) {
    renderMeta(__metaTitles.length ? __metaTitles : META_FALLBACK_TITLES, __metaDescs, { restoreSelection: true });
    showToast('❌ ' + e.message);
  } finally {
    setMetaLoading('title', false);
  }
}

async function regenerateMetaDescs() {
  if (!S.script) { showToast('还没有脚本内容'); return; }
  document.getElementById('metaWrap')?.classList.add('show');
  setMetaLoading('desc', true);
  try {
    const prompt = `根据以下视频脚本，生成2条短视频简介备选。返回格式：{"descs":["简介1","简介2"]}\n每条20字以内。${META_ENGAGE}\n\n脚本：\n${S.script.slice(0, 800)}`;
    const parsed = await callMetaJson(prompt);
    clearMetaSelection('desc');
    renderMeta(__metaTitles.length ? __metaTitles : META_FALLBACK_TITLES, parsed.descs || META_FALLBACK_DESCS, { restoreSelection: true });
    showToast('✓ 简介已重新生成');
  } catch (e) {
    renderMeta(__metaTitles, __metaDescs.length ? __metaDescs : META_FALLBACK_DESCS, { restoreSelection: true });
    showToast('❌ ' + e.message);
  } finally {
    setMetaLoading('desc', false);
  }
}

async function confirmScript() {
  if (!S.script) { showToast('还没有脚本内容'); return; }
  const mw = document.getElementById('metaWrap');
  mw.classList.add('show');
  S.selTitle = null;
  S.selDesc = null;
  document.getElementById('exportBar')?.classList.remove('show');
  setMetaLoading('title', true);
  setMetaLoading('desc', true);
  mw.scrollIntoView({ behavior: 'smooth' });

  const prompt = `根据以下视频脚本，生成标题和简介备选。返回格式：{"titles":["标题1","标题2","标题3"],"descs":["简介1","简介2"]}\n标题每条12字以内，简介每条20字以内。${META_ENGAGE}\n\n脚本：\n${S.script.slice(0, 800)}`;

  try {
    const parsed = await callMetaJson(prompt);
    renderMeta(parsed.titles || META_FALLBACK_TITLES, parsed.descs || META_FALLBACK_DESCS, { restoreSelection: false });
    showToast('✓ 标题与简介已生成');
  } catch {
    renderMeta(META_FALLBACK_TITLES, META_FALLBACK_DESCS, { restoreSelection: false });
    showToast('生成失败，已显示示例备选');
  } finally {
    setMetaLoading('title', false);
    setMetaLoading('desc', false);
  }
}

function pickMeta(type, idx, val) {
  if (type === 'title') { S.selTitle = val; document.querySelectorAll('#titleOpts .meta-opt').forEach((el, i) => el.classList.toggle('selected', i === idx)); }
  else { S.selDesc = val; document.querySelectorAll('#descOpts .meta-opt').forEach((el, i) => el.classList.toggle('selected', i === idx)); }
  if (S.selTitle && S.selDesc) {
    document.getElementById('expTitle').textContent = S.selTitle;
    document.getElementById('expDesc').textContent = S.selDesc;
    const bar = document.getElementById('exportBar');
    bar.classList.add('show');
    bar.scrollIntoView({ behavior: 'smooth' });
  }
}

function copyScript() {
  if (!S.script) return;
  navigator.clipboard.writeText(S.script).then(() => showToast('✓ 已复制脚本'));
}

function copyFull() {
  const text = `${S.selTitle}\n${S.selDesc}\n\n${S.script}`;
  navigator.clipboard.writeText(text).then(() => showToast('✓ 已复制全文'));
}

function exportMd() {
  if (!S.selTitle || !S.script) { showToast('请先选择标题和简介'); return; }
  const col = S.columns.find(c => c.id === S.activeCol);
  const date = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
  const md = `# ${S.selTitle}\n\n> ${S.selDesc}\n\n---\n\n${S.script}\n\n---\n\n*栏目：${col?.name || ''}*  \n*字数：${S.script.replace(/\s/g, '').length}字*  \n*生成日期：${date}*`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' })), download: `${S.selTitle.slice(0, 6)}-script.md` });
  a.click();
  showToast('✓ 已导出 Markdown');
}

function sanitizeFilePart(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || '未命名';
}

function getWordExportFilename() {
  const col = S.columns.find(c => c.id === S.activeCol);
  const topic = document.getElementById('outlineInput')?.value.trim() || S.selTitle || '主题';
  return `${sanitizeFilePart(col?.name || '栏目')}-${sanitizeFilePart(topic)}.docx`;
}

async function buildWordBlob() {
  const col = S.columns.find(c => c.id === S.activeCol);
  const outline = document.getElementById('outlineInput')?.value.trim() || '';
  const date = new Date().toLocaleDateString('zh-CN');
  const children = [];

  if (S.selTitle) {
    children.push(new Paragraph({ children: [new TextRun({ text: S.selTitle, bold: true, size: 32 })] }));
  } else if (outline) {
    children.push(new Paragraph({ children: [new TextRun({ text: outline, bold: true, size: 32 })] }));
  }
  if (S.selDesc) {
    children.push(new Paragraph({ children: [new TextRun({ text: S.selDesc, italics: true, size: 24 })] }));
  }
  children.push(new Paragraph({ text: '' }));

  for (const line of S.script.split('\n')) {
    children.push(new Paragraph({
      children: [new TextRun({ text: line, size: 24 })],
      spacing: { after: 120, line: 360 },
    }));
  }

  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({ children: [new TextRun({ text: `栏目：${col?.name || ''}`, size: 20, color: '666666' })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: `字数：${S.script.replace(/\s/g, '').length}字`, size: 20, color: '666666' })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: `生成日期：${date}`, size: 20, color: '666666' })] }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportWord() {
  if (!S.script) { showToast('还没有脚本内容'); return; }
  const blob = await buildWordBlob();
  downloadBlob(blob, getWordExportFilename());
  showToast('✓ 已导出 Word：' + getWordExportFilename());
}

// ═══════════════════════════════════════════
// Ref Toggle
// ═══════════════════════════════════════════
function toggleRefMode() {
  S.useRef = !S.useRef;
  lss('useRef', String(S.useRef));
  updateRefToggleUI();
  showToast(S.useRef ? '✓ 已开启：生成时将模仿参考文稿的风格与结构' : '已关闭参考资料库（自由创作模式）');
}

function updateRefToggleUI() {
  document.getElementById('refTrack')?.classList.toggle('on', S.useRef);
}

// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// Script display & free text selection
// ═══════════════════════════════════════════
function renderScriptContent() {
  const body = document.getElementById('scriptBody');
  if (!body) return;
  body.textContent = S.script;
  body.classList.add('script-selectable');
  document.getElementById('wordCt').textContent = S.script.replace(/\s/g, '').length;
  bindScriptSelectionEditor();
}

function bindScriptSelectionEditor() {
  const body = document.getElementById('scriptBody');
  if (!body || body.dataset.selectionBound) return;
  body.dataset.selectionBound = '1';
  body.addEventListener('mouseup', onScriptMouseUp);
}

function getSelectionInScript() {
  const body = document.getElementById('scriptBody');
  const sel = window.getSelection();
  if (!body || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return null;
  const measure = document.createRange();
  measure.selectNodeContents(body);
  measure.setEnd(range.startContainer, range.startOffset);
  const start = measure.toString().length;
  measure.setEnd(range.endContainer, range.endOffset);
  const end = measure.toString().length;
  if (start === end) return null;
  const text = S.script.slice(start, end);
  if (!text.trim()) return null;
  return { start, end, text };
}

function onScriptMouseUp() {
  if (document.getElementById('scriptBody')?.classList.contains('streaming')) return;
  requestAnimationFrame(() => {
    const hit = getSelectionInScript();
    if (!hit) return;
    openSelectionFeedback(hit);
  });
}

function openSelectionFeedback({ start, end, text }) {
  const changed = !S.selection || S.selection.start !== start || S.selection.end !== end;
  S.selection = { start, end, text };
  if (changed) {
    S.chatHistory = [];
    document.getElementById('chatMsgs').innerHTML = '';
  }
  const preview = text.length > 280 ? text.slice(0, 280) + '…' : text;
  document.getElementById('chatCardTitle').textContent = `修改选中（${text.length} 字）`;
  document.getElementById('chatParaQuote').textContent = preview;
  document.getElementById('chatParaQuote').title = text;
  document.getElementById('chatCard').style.display = 'block';
  document.getElementById('chatCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('chatInput').focus();
  updateSourceReqBtn();
}

function closeChat() {
  S.selection = null;
  S.chatHistory = [];
  document.getElementById('chatCard').style.display = 'none';
  try { window.getSelection()?.removeAllRanges(); } catch {}
  updateSourceReqBtn();
}

// ═══════════════════════════════════════════
// Selection feedback chat
// ═══════════════════════════════════════════
function appendChatMsg(role, text) {
  const msgs = document.getElementById('chatMsgs');
  const el = document.createElement('div');
  el.className = 'chat-msg ' + role;
  const label = role === 'user' ? '你' : 'AI';
  el.innerHTML = `<div class="chat-msg-role">${label}</div><div class="chat-msg-body">${escHtml(text)}</div>`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

async function sendParaChat() {
  const inputEl = document.getElementById('chatInput');
  const input = inputEl.value.trim();
  if (!input) return;
  if (!S.selection) {
    showToast('请先在脚本草稿中拖选要修改的文字');
    return;
  }
  inputEl.value = '';

  appendChatMsg('user', input);

  const { text } = S.selection;
  const isFirst = S.chatHistory.length === 0;
  const userContent = isFirst
    ? `完整脚本供参考：\n${S.script}\n\n需要修改的选中内容：\n${text}\n\n修改要求：${input}`
    : input;
  S.chatHistory.push({ role: 'user', content: userContent });

  const btn = document.getElementById('chatSendBtn');
  btn.disabled = true;

  let aiText = '';
  const aiEl = appendChatMsg('ai', '');
  const aiBody = aiEl.querySelector('.chat-msg-body');
  aiBody.classList.add('streaming');

  try {
    const sys = '你是专业视频脚本编辑。根据用户的修改要求，对脚本中被选中的片段进行改写。只返回改写后的片段正文，不添加任何解释、前缀或引号，不要输出未被选中的其他内容。';
    await callStreamWithHistory(sys, [...S.chatHistory], chunk => {
      aiText += chunk;
      aiBody.textContent = aiText;
      document.getElementById('chatMsgs').scrollTop = 99999;
    });
    S.chatHistory.push({ role: 'assistant', content: aiText });
    persistApiSettings();

    const applyBtn = document.createElement('button');
    applyBtn.className = 'chat-apply-btn';
    applyBtn.textContent = '✓ 应用到脚本';
    const capturedStart = S.selection.start;
    const capturedEnd = S.selection.end;
    const capturedText = aiText;
    applyBtn.onclick = () => applySelectionEdit(capturedStart, capturedEnd, capturedText, applyBtn);
    aiEl.appendChild(applyBtn);
  } catch (e) {
    aiBody.textContent = '❌ ' + e.message;
  } finally {
    aiBody.classList.remove('streaming');
    btn.disabled = false;
  }
}

function applySelectionEdit(start, end, newText, applyBtn) {
  S.script = S.script.slice(0, start) + newText + S.script.slice(end);
  const newEnd = start + newText.length;
  S.selection = { start, end: newEnd, text: newText };
  renderScriptContent();
  const preview = newText.length > 280 ? newText.slice(0, 280) + '…' : newText;
  document.getElementById('chatParaQuote').textContent = preview;
  document.getElementById('chatParaQuote').title = newText;
  document.getElementById('chatCardTitle').textContent = `修改选中（${newText.length} 字）`;
  if (applyBtn) {
    applyBtn.textContent = '✓ 已应用';
    applyBtn.disabled = true;
    applyBtn.style.background = 'var(--success)';
  }
  showToast('✓ 已应用修改');
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendParaChat(); }
}


// ═══════════════════════════════════════════
// Citations / 信源请求
// ═══════════════════════════════════════════
function loadSourceEntries() {
  try {
    const raw = ls('sourceEntries');
    if (raw) S.sourceEntries = JSON.parse(raw);
  } catch { S.sourceEntries = []; }
  if (!Array.isArray(S.sourceEntries)) S.sourceEntries = [];
}

function persistSourceEntries() {
  try { lss('sourceEntries', JSON.stringify(S.sourceEntries.slice(0, 30))); } catch {}
}

function updateSourceReqBtn() {
  const btn = document.getElementById('sourceReqBtn');
  if (!btn) return;
  const ok = S.script.trim() && S.selection?.text?.trim();
  btn.style.display = ok ? 'inline-flex' : 'none';
  btn.disabled = false;
}

function renderCitationsPanel(streamingText) {
  const empty = document.getElementById('citEmpty');
  const list = document.getElementById('citList');
  if (!list) return;

  if (streamingText !== undefined) {
    if (empty) empty.hidden = true;
    list.hidden = false;
    list.innerHTML = '<div class="cit-entry active"><div class="cit-entry-head">正在检索信源…</div><div class="cit-content streaming">' + formatCitationContent(streamingText) + '</div></div>';
    list.scrollTop = list.scrollHeight;
    return;
  }

  if (!S.sourceEntries.length) {
    if (empty) empty.hidden = false;
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  if (empty) empty.hidden = true;
  list.hidden = false;
  const parts = S.sourceEntries.map(entry => {
    const active = entry.id === S.activeSourceId;
    const q = entry.sentence.length > 72 ? entry.sentence.slice(0, 72) + '…' : entry.sentence;
    let h = '<div class="cit-entry' + (active ? ' active' : '') + '" data-id="' + entry.id + '">';
    h += '<div class="cit-entry-head" onclick="toggleSourceEntry(\'' + entry.id + '\', event)">';
    h += '<span class="cit-chevron' + (active ? ' open' : '') + '" aria-hidden="true">▸</span>';
    h += '<div class="cit-entry-summary"><div>' + escHtml(q) + '</div>';
    h += '<div class="cit-entry-time">' + escHtml(entry.createdAt || '') + '</div></div>';
    if (active) {
      h += '<button type="button" class="cit-collapse-btn" onclick="collapseSourceEntry(event,\'' + entry.id + '\')" title="收起">收起</button>';
    }
    h += '</div>';
    if (active) {
      h += '<div class="cit-entry-body">';
      h += '<div class="cit-detail-quote">' + escHtml(entry.sentence) + '</div>';
      h += '<div class="cit-content">' + formatCitationContent(entry.content) + '</div>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  });
  list.innerHTML = parts.join('');
}

function toggleSourceEntry(id, e) {
  if (e?.target?.closest?.('.cit-collapse-btn')) return;
  e?.stopPropagation?.();
  S.activeSourceId = S.activeSourceId === id ? null : id;
  renderCitationsPanel();
}

function collapseSourceEntry(e, id) {
  e?.stopPropagation?.();
  e?.preventDefault?.();
  S.activeSourceId = null;
  renderCitationsPanel();
}

function renderCitationsError(msg) {
  const list = document.getElementById('citList');
  const empty = document.getElementById('citEmpty');
  if (empty) empty.hidden = true;
  if (list) {
    list.hidden = false;
    list.innerHTML = '<div class="cit-entry active"><div class="cit-content" style="color:var(--accent)">❌ ' + escHtml(msg) + '</div></div>';
  }
}

async function requestSources() {
  if (!S.script.trim()) { showToast('请先生成脚本草稿'); return; }
  if (!S.selection?.text?.trim()) { showToast('请先拖选要查证信源的句子'); return; }

  const sentence = S.selection.text.trim();
  const btn = document.getElementById('sourceReqBtn');
  if (btn) { btn.disabled = true; btn.textContent = '检索中…'; }

  renderCitationsPanel('正在启动真实数据库检索…\n');
  try {
    const { content } = await fetchGroundedSources({
      sentence,
      script: S.script,
      onProgress: msg => renderCitationsPanel(msg),
      callStream,
    });
    persistApiSettings();
    const entry = {
      id: 'src_' + Date.now(),
      sentence,
      content,
      createdAt: new Date().toLocaleString('zh-CN'),
    };
    S.sourceEntries.unshift(entry);
    S.activeSourceId = entry.id;
    persistSourceEntries();
    renderCitationsPanel();
    showToast('✓ 已检索真实文献链接');
  } catch (e) {
    renderCitationsError(e.message);
    showToast('❌ ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '信源请求'; }
    updateSourceReqBtn();
  }
}

// ═══════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════
function switchProvider(val) {
  if (!PROVIDER_CFG[val]) return;
  S.currentProvider = val;
  persistApiSettings();
  showToast('已切换至 ' + PROVIDER_CFG[val].name);
}

function updateProviderUI() {
  const sel = document.getElementById('providerSelect');
  if (!sel) return;
  sel.value = S.currentProvider;
  if (!sel.value) { sel.value = 'doubao'; S.currentProvider = 'doubao'; }
}

function saveApiKeys() {
  persistApiSettings({ clearEmpty: true, silent: true });
  closeModal('apiKeyModal');
  showToast('✓ 已保存到本机，刷新后仍会保留');
}

// ═══════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════
function updateCC() { document.getElementById('ccNum').textContent = document.getElementById('outlineInput').value.length; }
function formatSize(b) { return b < 1024 ? b + 'B' : b < 1048576 ? (b / 1024).toFixed(1) + 'KB' : (b / 1048576).toFixed(1) + 'MB'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatCitationContent(text) {
  const s = String(text || '');
  const parts = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'\u4e00-\u9fff]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push(escHtml(s.slice(last, m.index)));
    const url = m[2] || m[3];
    const label = m[1] || url;
    parts.push(`<a class="cit-link" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`);
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(escHtml(s.slice(last)));
  return parts.join('').replace(/\n/g, '<br>');
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function openApiKeyModal() {
  setApiTestStatus('', '');
  openModal('apiKeyModal');
}

document.querySelectorAll('.modal-bg').forEach(bg => bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('show'); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show')); });

let toastT;
function showToast(msg, durationMs = 2800) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), durationMs);
}

init();

Object.assign(window, {
  openFolderUpload,
  handleFolderUpload,
  switchProvider,
  openApiKeyModal,
  testCurrentProvider,
  generate,
  toggleRefMode,
  toggleCreatorIdentity,
  onCreatorIdentityInput,
  resetCreatorIdentity,
  updateCC,
  copyScript,
  confirmScript,
  regenerateMetaTitles,
  regenerateMetaDescs,
  closeChat,
  sendParaChat,
  requestSources,
  toggleSourceEntry,
  collapseSourceEntry,
  chatKeydown,
  copyFull,
  exportMd,
  exportWord,
  previewDoc,
  closePrev,
  closeModal,
  saveApiKeys,
  selectCol,
  deleteCol,
  toggleColExpand,
  pickMeta,
});
