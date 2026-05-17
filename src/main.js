/** 标题/简介候选项（用于点击选择，避免把文案写进 onclick 造成引号与特殊字符问题） */
let __metaTitles = [];
let __metaDescs = [];

// State & Provider Config
// ═══════════════════════════════════════════
const S = {
  columns: [],
  docs: {},
  activeCol: null,
  script: '',
  paragraphs: [],       // script split into editable paragraphs
  selectedParaIdx: -1,
  chatHistory: [],      // multi-turn chat for current paragraph
  selTitle: '',
  selDesc: '',
  currentProvider: 'doubao', // 'doubao' | 'deepseek'
  useRef: true,         // whether to inject reference docs into prompt
};

/**
 * provider 接口配置（仅保留豆包 / DeepSeek）：
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
  openrouter: {
    endpoint: '/api/openrouter/api/v1',
    keyId: 'openrouterKey',
    modelKey: 'openrouterModelId',
    format: 'openai',
    name: 'OpenRouter',
    extraHeaders: {
      'HTTP-Referer': 'http://localhost:5173/',
      'X-Title': '脚本工坊',
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
  'openrouterKey', 'openrouterModelId',
];

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

  renderColumns();

  KEY_FIELDS.forEach(k => {
    const v = ls(k); if (v) document.getElementById(k).value = v;
  });

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
  }

  prog.classList.remove('show');

  try { lss('columns', JSON.stringify(S.columns)); } catch {}
  try { lss('docs', JSON.stringify(S.docs)); } catch {}

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
// UI: 栏目列表
// ═══════════════════════════════════════════
function renderColumns() {
  const list = document.getElementById('colList');
  if (S.columns.length === 0) {
    list.innerHTML = `<div style="padding:28px 12px;text-align:center;color:var(--ink-faint);font-size:13px;line-height:2">
      <div style="font-size:28px;margin-bottom:8px">📁</div>
      点击「+ 上传文件夹」<br>添加栏目文档
    </div>`;
    return;
  }
  list.innerHTML = S.columns.map(col => {
    const cnt = (S.docs[col.id] || []).length;
    return `<div class="col-item ${S.activeCol === col.id ? 'active' : ''}" onclick="selectCol('${col.id}')">
      <div class="col-icon">${col.emoji}</div>
      <div class="col-info">
        <div class="col-name">${escHtml(col.name)}</div>
        <div class="col-sub">${cnt > 0 ? cnt + ' 篇文稿' : '暂无文稿'}</div>
      </div>
      <button class="col-del" onclick="deleteCol(event,'${col.id}')" title="删除栏目">✕</button>
    </div>`;
  }).join('');
}

function deleteCol(e, colId) {
  e.stopPropagation();
  S.columns = S.columns.filter(c => c.id !== colId);
  delete S.docs[colId];
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
  const col = S.columns.find(c => c.id === id);
  renderColumns();
  showEditorArea(col);
  renderDocs(id);
  // Reset writing area
  document.getElementById('outlineInput').value = '';
  updateCC();
  document.getElementById('scriptCard').classList.remove('show');
  document.getElementById('scriptLabel').style.display = 'none';
  document.getElementById('metaWrap').classList.remove('show');
  document.getElementById('exportBar').classList.remove('show');
  S.script = ''; S.paragraphs = []; S.selectedParaIdx = -1; S.chatHistory = [];
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
  document.getElementById('docList').innerHTML = `<div class="lib-empty"><div class="lib-empty-icon">📂</div><div>选择栏目后显示<br>该栏目下的参考文稿</div></div>`;
  document.getElementById('libCount').textContent = '';
}

// ═══════════════════════════════════════════
// UI: 文稿列表
// ═══════════════════════════════════════════
function renderDocs(colId) {
  const list = document.getElementById('docList');
  const docs = S.docs[colId] || [];
  document.getElementById('libCount').textContent = docs.length > 0 ? docs.length + ' 篇' : '';
  if (docs.length === 0) {
    list.innerHTML = `<div class="lib-empty"><div class="lib-empty-icon">📄</div><div>该栏目暂无参考文稿<br>请在文件夹中添加文档后重新上传</div></div>`;
    return;
  }
  list.innerHTML = docs.map(doc => `
    <div class="doc-item" id="di_${doc.id}" onclick="previewDoc('${colId}','${doc.id}')">
      <div class="doc-icon">${docIcon(doc.name)}</div>
      <div class="doc-info">
        <div class="doc-name">${escHtml(doc.name)}</div>
        <div class="doc-meta">
          <span>${doc.size}</span>
          <span>${doc.date}</span>
        </div>
      </div>
    </div>`).join('');
}

function docIcon(n) {
  if (n.endsWith('.pdf')) return '📕';
  if (n.endsWith('.docx') || n.endsWith('.doc')) return '📘';
  if (n.endsWith('.md')) return '📋';
  return '📄';
}

function previewDoc(colId, docId) {
  const doc = (S.docs[colId] || []).find(d => d.id === docId);
  if (!doc) return;
  document.querySelectorAll('.doc-item').forEach(el => el.classList.remove('active-ref'));
  document.getElementById('di_' + docId)?.classList.add('active-ref');
  document.getElementById('prevTitle').textContent = doc.name;
  const preview = (doc.content || '（无内容）').slice(0, 2000) + (doc.content?.length > 2000 ? '\n…（仅显示前2000字）' : '');
  document.getElementById('prevBody').textContent = preview;
  document.getElementById('prevPanel').classList.add('show');
}

function closePrev() { document.getElementById('prevPanel').classList.remove('show'); }

// ═══════════════════════════════════════════
// AI Generation
// ═══════════════════════════════════════════
function buildSystemPrompt() {
  const refs = S.useRef
    ? (S.docs[S.activeCol] || []).filter(d => d.content)
        .map((d, i) => `【参考文稿${i + 1}：${d.name}】\n${d.content.slice(0, 2500)}`).join('\n\n---\n\n')
    : '';
  return `你是一位专业的知识科普类视频脚本创作者。

${refs ? `以下是该栏目的参考文稿，请分析并严格学习其风格：\n\n${refs}\n\n---` : '（不使用参考文稿，请以优质知识科普视频风格创作）'}

创作要求：
1. ${refs ? '严格模仿参考文稿的表达风格、句式习惯和开场方式' : '使用生动有趣、口语化的表达风格'}
2. 生成约500字的视频逐字稿，适合对镜头直接口播
3. 开场用问题或反常识陈述吸引注意
4. 用生活化类比解释专业概念，配合具体案例
5. 语气口语化流畅，避免书面腔
6. 结构：开场钩子 → 核心内容展开 → 收尾总结

直接输出脚本正文，不要标注格式说明。`;
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
    throw new Error(`网络请求失败：${err?.message || err}（若你看到 "Load failed"，多半是浏览器 CORS 拦截或代理未启动；请确认是用 npm run dev 启动）`);
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

async function _callOpenAIStream(cfg, key, system, messages, onChunk) {
  const allMsgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
    ...(cfg.extraHeaders || {}),
  };
  const res = await _safeFetch(`${cfg.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: resolveModelId(), max_tokens: 1500, stream: true, messages: allMsgs }),
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
      try { const ev = JSON.parse(d); const t = ev.choices?.[0]?.delta?.content || ''; if (t) onChunk(t); } catch {}
    }
  }
}

function resolveModelId() {
  const cfg = PROVIDER_CFG[currentProvider()];
  const id = (ls(cfg.modelKey) || '').trim();
  if (!id) throw new Error(`请先在 ⚙ API Key 弹窗里填写 ${cfg.name} 的「模型 ID」`);
  return id;
}

function _getProviderKey() {
  const provider = currentProvider();
  const cfg = PROVIDER_CFG[provider];
  const key = (ls(cfg.keyId) || '').trim();
  if (!key) throw new Error(`请先在 ⚙ API Key 弹窗里填写 ${cfg.name} 的 API Key`);
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

  S.script = '';
  S.paragraphs = [];
  S.selectedParaIdx = -1;
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
    const prompt = `请根据以下大纲，生成约500字的知识科普类视频逐字稿：\n\n${outline}`;
    await callStream(prompt, sys, onChunk);
    showToast('✓ 脚本生成完成');
  } catch (e) {
    body.style.whiteSpace = '';
    body.innerHTML = `<div style="padding:16px 8px;color:var(--accent);font-size:13px;line-height:1.9">
      <strong>生成失败</strong><br>${escHtml(e.message)}
    </div>`;
    document.getElementById('wordCt').textContent = '0';
    showToast('❌ ' + e.message);
  } finally {
    body.classList.remove('streaming');
    btn.disabled = false;
    document.getElementById('genBtnTxt').textContent = '✦ 生成脚本';
    // Parse into paragraphs for inline editing
    S.paragraphs = S.script.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    if (S.paragraphs.length <= 1) {
      S.paragraphs = S.script.split(/\n/).map(p => p.trim()).filter(Boolean);
    }
    body.style.whiteSpace = '';
    renderScriptParagraphs();
    if (S.paragraphs.length > 0) {
      document.getElementById('paraHint').style.display = 'block';
    }
    body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function confirmScript() {
  if (!S.script) { showToast('还没有脚本内容'); return; }
  const mw = document.getElementById('metaWrap');
  mw.classList.add('show');
  document.getElementById('titleOpts').innerHTML = '<div style="padding:12px;font-size:13px;color:var(--ink-faint)">生成中…</div>';
  document.getElementById('descOpts').innerHTML = '<div style="padding:12px;font-size:13px;color:var(--ink-faint)">生成中…</div>';
  mw.scrollIntoView({ behavior: 'smooth' });

  const sys = '你是视频内容运营专家。只返回纯JSON，不加任何解释或代码块标记。';
  const prompt = `根据以下视频脚本，生成标题和简介。返回格式：{"titles":["标题1","标题2","标题3"],"descs":["简介1","简介2"]}\n标题每条12字以内，简介每条20字以内。\n\n脚本：\n${S.script.slice(0, 600)}`;

  let raw = '';
  try {
    const onC = t => { raw += t; };
    await callStream(prompt, sys, onC);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    renderMeta(parsed.titles || [], parsed.descs || []);
  } catch {
    renderMeta(['大脑为什么需要睡眠来记忆', '你以为在睡觉其实在学习', '记忆怎么从短期变长期'], ['睡眠才是记忆巩固的关键一步', '熬夜复习为什么效果这么差']);
  }
}

function renderMeta(titles, descs) {
  __metaTitles = titles;
  __metaDescs = descs;
  document.getElementById('titleOpts').innerHTML = titles.map((t, i) => `
    <div class="meta-opt" data-kind="title" data-idx="${i}">
      <span class="meta-opt-text">${escHtml(t)}</span><span class="meta-opt-ct">${t.length}字</span>
    </div>`).join('');
  document.getElementById('descOpts').innerHTML = descs.map((d, i) => `
    <div class="meta-opt" data-kind="desc" data-idx="${i}">
      <span class="meta-opt-text">${escHtml(d)}</span><span class="meta-opt-ct">${d.length}字</span>
    </div>`).join('');
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

// ═══════════════════════════════════════════
// Ref Toggle
// ═══════════════════════════════════════════
function toggleRefMode() {
  S.useRef = !S.useRef;
  lss('useRef', String(S.useRef));
  updateRefToggleUI();
  showToast(S.useRef ? '✓ 已开启参考资料库' : '已关闭参考资料库（自由创作模式）');
}

function updateRefToggleUI() {
  document.getElementById('refTrack')?.classList.toggle('on', S.useRef);
}

// ═══════════════════════════════════════════
// Paragraph Rendering & Selection
// ═══════════════════════════════════════════
function renderScriptParagraphs() {
  const body = document.getElementById('scriptBody');
  body.innerHTML = S.paragraphs.map((p, i) =>
    `<div class="para-block${S.selectedParaIdx === i ? ' selected' : ''}" onclick="selectParagraph(${i})">${escHtml(p)}</div>`
  ).join('');
  document.getElementById('wordCt').textContent = S.script.replace(/\s/g, '').length;
}

function selectParagraph(idx) {
  const switched = S.selectedParaIdx !== idx;
  S.selectedParaIdx = idx;
  if (switched) {
    S.chatHistory = [];
    document.getElementById('chatMsgs').innerHTML = '';
  }
  renderScriptParagraphs();
  document.getElementById('chatCardTitle').textContent = `修改第 ${idx + 1} 段（共 ${S.paragraphs.length} 段）`;
  document.getElementById('chatParaQuote').textContent = S.paragraphs[idx];
  const chatCard = document.getElementById('chatCard');
  chatCard.style.display = 'block';
  chatCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('chatInput').focus();
}

function closeChat() {
  S.selectedParaIdx = -1;
  S.chatHistory = [];
  document.getElementById('chatCard').style.display = 'none';
  renderScriptParagraphs();
}

// ═══════════════════════════════════════════
// Paragraph Chat
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
  if (!input || S.selectedParaIdx < 0) return;
  inputEl.value = '';

  appendChatMsg('user', input);

  // First turn: send full context; subsequent turns: just the instruction
  const isFirst = S.chatHistory.length === 0;
  const userContent = isFirst
    ? `完整脚本供参考：\n${S.script}\n\n需要修改的段落：\n${S.paragraphs[S.selectedParaIdx]}\n\n修改要求：${input}`
    : input;
  S.chatHistory.push({ role: 'user', content: userContent });

  const btn = document.getElementById('chatSendBtn');
  btn.disabled = true;

  let aiText = '';
  const aiEl = appendChatMsg('ai', '');
  const aiBody = aiEl.querySelector('.chat-msg-body');
  aiBody.classList.add('streaming');

  try {
    const sys = '你是专业视频脚本编辑。根据用户的修改要求，对指定段落进行改写。只返回改写后的段落文本，不添加任何解释、前缀或引号。';
    await callStreamWithHistory(sys, [...S.chatHistory], chunk => {
      aiText += chunk;
      aiBody.textContent = aiText;
      document.getElementById('chatMsgs').scrollTop = 99999;
    });
    S.chatHistory.push({ role: 'assistant', content: aiText });

    const applyBtn = document.createElement('button');
    applyBtn.className = 'chat-apply-btn';
    applyBtn.textContent = '✓ 应用到脚本';
    const capturedIdx = S.selectedParaIdx;
    const capturedText = aiText;
    applyBtn.onclick = () => applyParaEdit(capturedIdx, capturedText, applyBtn);
    aiEl.appendChild(applyBtn);
  } catch (e) {
    aiBody.textContent = '❌ ' + e.message;
  } finally {
    aiBody.classList.remove('streaming');
    btn.disabled = false;
  }
}

function applyParaEdit(paraIdx, newText, applyBtn) {
  S.paragraphs[paraIdx] = newText;
  S.script = S.paragraphs.join('\n\n');
  document.getElementById('chatParaQuote').textContent = newText;
  renderScriptParagraphs();
  if (applyBtn) { applyBtn.textContent = '✓ 已应用'; applyBtn.disabled = true; applyBtn.style.background = 'var(--success)'; }
  showToast('✓ 已应用修改');
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendParaChat(); }
}

// ═══════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════
function switchProvider(val) {
  if (!PROVIDER_CFG[val]) return;
  S.currentProvider = val;
  lss('currentProvider', val);
  showToast('已切换至 ' + PROVIDER_CFG[val].name);
}

function updateProviderUI() {
  const sel = document.getElementById('providerSelect');
  if (!sel) return;
  sel.value = S.currentProvider;
  if (!sel.value) { sel.value = 'doubao'; S.currentProvider = 'doubao'; }
}

function saveApiKeys() {
  KEY_FIELDS.forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    const v = el.value.trim();
    if (v) lss(k, v);
    else { try { localStorage.removeItem(k); } catch {} }
  });
  closeModal('apiKeyModal');
  showToast('✓ 已保存');
}

// ═══════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════
function updateCC() { document.getElementById('ccNum').textContent = document.getElementById('outlineInput').value.length; }
function formatSize(b) { return b < 1024 ? b + 'B' : b < 1048576 ? (b / 1024).toFixed(1) + 'KB' : (b / 1048576).toFixed(1) + 'MB'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function openApiKeyModal() { openModal('apiKeyModal'); }

document.querySelectorAll('.modal-bg').forEach(bg => bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('show'); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show')); });

let toastT;
function showToast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

init();

Object.assign(window, {
  openFolderUpload,
  handleFolderUpload,
  switchProvider,
  openApiKeyModal,
  generate,
  toggleRefMode,
  updateCC,
  copyScript,
  confirmScript,
  closeChat,
  sendParaChat,
  chatKeydown,
  copyFull,
  exportMd,
  previewDoc,
  closePrev,
  closeModal,
  saveApiKeys,
  selectCol,
  deleteCol,
  selectParagraph,
  pickMeta,
});
