import { Document, Packer, Paragraph, TextRun } from 'docx';
import {
  answerTruthFollowup,
  buildTruthInvestigationAnswer,
  fetchGroundedSources,
  formatTruthInvestigationMarkdown,
} from './sourceLookup.js';
import { initTopicPanel, renderTopicPanel } from './topicPanel.js';
import { initStoryboardPanel, resetStoryboardPanel } from './storyboardPanel.js';

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
const CREATOR_IDENTITY_DEFAULT_PRESET_ID = 'default';

// State & Provider Config
// ═══════════════════════════════════════════
const S = {
  columns: [],
  docs: {},
  expandedCols: new Set(),
  activeCol: null,
  script: '',
  selection: null,      // { start, end, text } 鼠标拖选范围（相对 S.script）
  scriptCursorOffset: null,
  chatHistory: [],      // multi-turn chat for current selection
  selTitle: '',
  selDesc: '',
  currentProvider: 'doubao', // 'doubao' | 'deepseek'
  useRef: true,         // whether to inject reference docs into prompt
  sourceEntries: [],    // { id, sentence, content, createdAt }
  activeSourceId: null,
  revisionEntries: [],  // { id, createdAt, provider, model, originalText, revisedText, instruction, prompts }
  aiEditDraft: null,    // { start, end, originalText, instruction, result, prompts }
  historyDrafts: [],    // 历史稿件
  activeHistoryId: null,
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
  loadRevisionEntries();
  loadHistoryDrafts();
  renderColumns();
  renderCitationsPanel();
  renderHistoryPanel();

  KEY_FIELDS.forEach(k => {
    const v = ls(k);
    const el = document.getElementById(k);
    if (el && v) el.value = v;
  });
  bindApiSettingsPersistence();
  initCreatorIdentity();
  initTopicPanel({ escHtml, showToast, callMetaJson, updateCC });
  initStoryboardPanel({
    escHtml,
    showToast,
    callMetaJson,
    readMainScript: () => readScriptFromEditor() || S.script,
    readDocxText: readDocxFile,
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
    S.expandedCols.add(col.id);
  }

  prog.classList.remove('show');

  try { lss('columns', JSON.stringify(S.columns)); } catch {}
  try { lss('docs', JSON.stringify(S.docs)); } catch {}
  persistExpandedCols();

  renderColumns();
  const lastName = folderNames[folderNames.length - 1];
  const imported = S.columns.find(c => c.name === lastName);
  if (imported) selectCol(imported.id);
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
// UI: 栏目标签（顶栏）
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

function renderColToolbar() {
  const tabs = document.getElementById('colTabs');
  if (!tabs) return;
  if (S.columns.length === 0) {
    tabs.innerHTML = '<span class="col-tabs-empty">上传文件夹后将在此显示栏目标签</span>';
    return;
  }
  tabs.innerHTML = S.columns
    .map((col) => {
      const active = S.activeCol === col.id;
      return `<div class="col-tab${active ? ' active' : ''}" data-col-id="${col.id}">
      <button type="button" class="col-tab-main" onclick="selectCol('${col.id}')" title="${escHtml(col.name)}">
        ${active ? '<span class="col-tab-dot"></span>' : ''}
        <span class="col-tab-emoji">${col.emoji}</span>
        <span class="col-tab-name">${escHtml(col.name)}</span>
      </button>
      <button type="button" class="col-tab-close" onclick="deleteCol(event,'${col.id}')" title="删除栏目">✕</button>
    </div>`;
    })
    .join('');
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
  renderColToolbar();
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
  resetStoryboardPanel();
}

function showEditorArea(col) {
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('edActive').style.display = 'flex';
  renderColToolbar();
}

function resetEditor() {
  document.getElementById('emptyState').style.display = 'flex';
  document.getElementById('edActive').style.display = 'none';
  renderColToolbar();
  closePrev();
  resetStoryboardPanel();
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
  setActiveCreatorIdentityPreset(CREATOR_IDENTITY_DEFAULT_PRESET_ID);
  showToast('已恢复默认创作者身份');
}

function loadCreatorIdentityPresets() {
  try {
    const raw = ls('creatorIdentityPresets');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(p => p && p.id && p.name && typeof p.content === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistCreatorIdentityPresets(presets) {
  try { lss('creatorIdentityPresets', JSON.stringify(presets)); } catch {}
}

function activeCreatorIdentityPresetId() {
  return ls('activeCreatorIdentityPresetId') || CREATOR_IDENTITY_DEFAULT_PRESET_ID;
}

function setActiveCreatorIdentityPreset(id) {
  lss('activeCreatorIdentityPresetId', id || CREATOR_IDENTITY_DEFAULT_PRESET_ID);
  renderCreatorIdentityPresetSelect();
}

function renderCreatorIdentityPresetSelect() {
  const sel = document.getElementById('creatorIdentityPresetSelect');
  if (!sel) return;
  const presets = loadCreatorIdentityPresets();
  const activeId = activeCreatorIdentityPresetId();
  sel.innerHTML = [
    `<option value="${CREATOR_IDENTITY_DEFAULT_PRESET_ID}">默认：知识科普短视频</option>`,
    ...presets.map(p => `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`),
  ].join('');
  sel.value = presets.some(p => p.id === activeId) ? activeId : CREATOR_IDENTITY_DEFAULT_PRESET_ID;
}

function applyCreatorIdentityPreset(id) {
  const el = document.getElementById('creatorIdentityInput');
  if (!el) return;
  const presetId = id || CREATOR_IDENTITY_DEFAULT_PRESET_ID;
  const preset = presetId === CREATOR_IDENTITY_DEFAULT_PRESET_ID
    ? { content: DEFAULT_CREATOR_IDENTITY }
    : loadCreatorIdentityPresets().find(p => p.id === presetId);
  if (!preset) {
    renderCreatorIdentityPresetSelect();
    showToast('未找到该预设');
    return;
  }
  el.value = preset.content;
  updateIdentityCC();
  persistCreatorIdentity();
  setActiveCreatorIdentityPreset(presetId);
  showToast('✓ 已载入创作者身份预设');
}

function uniquePresetName(baseName, presets) {
  const base = (baseName || '未命名预设').trim() || '未命名预设';
  const names = new Set(presets.map(p => p.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

function saveCreatorIdentityPreset() {
  const el = document.getElementById('creatorIdentityInput');
  if (!el) return;
  const content = el.value.trim();
  if (!content) { showToast('创作者身份内容为空，不能保存'); return; }
  const presets = loadCreatorIdentityPresets();
  const activeId = activeCreatorIdentityPresetId();
  const activePreset = presets.find(p => p.id === activeId);
  const suggested = activePreset?.name || '我的创作者身份';
  const rawName = window.prompt('给这个创作者身份预设起个名字：', suggested);
  if (rawName === null) return;
  const name = rawName.trim();
  if (!name) { showToast('预设名称不能为空'); return; }
  const sameIdx = presets.findIndex(p => p.name === name);
  if (sameIdx >= 0) {
    if (!window.confirm(`已存在「${name}」，要覆盖它吗？`)) return;
    presets[sameIdx] = {
      ...presets[sameIdx],
      content,
      updatedAt: new Date().toLocaleString('zh-CN'),
    };
    persistCreatorIdentityPresets(presets);
    setActiveCreatorIdentityPreset(presets[sameIdx].id);
    persistCreatorIdentity();
    showToast('✓ 已覆盖预设');
    return;
  }
  const entry = {
    id: 'preset_' + Date.now(),
    name: uniquePresetName(name, presets),
    content,
    updatedAt: new Date().toLocaleString('zh-CN'),
  };
  presets.unshift(entry);
  persistCreatorIdentityPresets(presets);
  persistCreatorIdentity();
  setActiveCreatorIdentityPreset(entry.id);
  showToast('✓ 已保存为预设');
}

function renameCreatorIdentityPreset() {
  const activeId = activeCreatorIdentityPresetId();
  if (activeId === CREATOR_IDENTITY_DEFAULT_PRESET_ID) {
    showToast('默认预设不能重命名');
    return;
  }
  const presets = loadCreatorIdentityPresets();
  const idx = presets.findIndex(p => p.id === activeId);
  if (idx < 0) { showToast('请先选择一个用户预设'); return; }
  const rawName = window.prompt('新的预设名称：', presets[idx].name);
  if (rawName === null) return;
  const name = rawName.trim();
  if (!name) { showToast('预设名称不能为空'); return; }
  const duplicate = presets.some((p, i) => i !== idx && p.name === name);
  if (duplicate) { showToast('已有同名预设'); return; }
  presets[idx] = { ...presets[idx], name, updatedAt: new Date().toLocaleString('zh-CN') };
  persistCreatorIdentityPresets(presets);
  renderCreatorIdentityPresetSelect();
  showToast('✓ 已重命名预设');
}

function deleteCreatorIdentityPreset() {
  const activeId = activeCreatorIdentityPresetId();
  if (activeId === CREATOR_IDENTITY_DEFAULT_PRESET_ID) {
    showToast('默认预设不能删除');
    return;
  }
  const presets = loadCreatorIdentityPresets();
  const preset = presets.find(p => p.id === activeId);
  if (!preset) { showToast('请先选择一个用户预设'); return; }
  if (!window.confirm(`确定删除「${preset.name}」吗？`)) return;
  persistCreatorIdentityPresets(presets.filter(p => p.id !== activeId));
  setActiveCreatorIdentityPreset(CREATOR_IDENTITY_DEFAULT_PRESET_ID);
  showToast('已删除预设');
}

function initCreatorIdentity() {
  const el = document.getElementById('creatorIdentityInput');
  if (!el) return;
  el.value = ls('creatorIdentity') || DEFAULT_CREATOR_IDENTITY;
  updateIdentityCC();
  renderCreatorIdentityPresetSelect();
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
  setScriptEditorMode('streaming');
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
    setScriptEditorMode('editable');
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
const META_TITLE_RULE = '标题每条 10～12 字（不超过 12 字），信息完整、有记忆点。';
const META_DESC_RULE = '简介每条 15～20 字（不超过 20 字）：尽量写满到 18～20 字，补充一句利益点或悬念，禁止少于 15 字的过短句。';

const META_FALLBACK_TITLES = ['熬夜后大脑在偷偷补课？', '你以为在发呆，其实在记东西', '记忆为啥睡一觉就变牢了'];
const META_FALLBACK_DESCS = ['看完才懂：睡眠是把记忆写进大脑的关键', '熬夜复习白费功？记忆要靠睡眠写进脑子'];

const HISTORY_MAX = 20;

function loadHistoryDrafts() {
  try {
    const raw = ls('historyDrafts');
    S.historyDrafts = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(S.historyDrafts)) S.historyDrafts = [];
  } catch {
    S.historyDrafts = [];
  }
}

function persistHistoryDrafts() {
  try { lss('historyDrafts', JSON.stringify(S.historyDrafts.slice(0, HISTORY_MAX))); } catch {}
}

function historyDraftLabel(item) {
  if (item.selTitle) return item.selTitle;
  if (item.outline) return item.outline.slice(0, 18) + (item.outline.length > 18 ? '…' : '');
  const preview = (item.script || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return preview ? preview + '…' : '未命名稿件';
}

function saveHistoryDraft() {
  if (!S.script?.trim()) return;
  const col = S.columns.find(c => c.id === S.activeCol);
  const outline = document.getElementById('outlineInput')?.value.trim() || '';
  const entry = {
    id: 'hist_' + Date.now(),
    savedAt: new Date().toLocaleString('zh-CN'),
    colId: S.activeCol,
    colName: col?.name || '',
    colEmoji: col?.emoji || '📝',
    outline,
    script: S.script,
    selTitle: S.selTitle || '',
    selDesc: S.selDesc || '',
    titles: [...__metaTitles],
    descs: [...__metaDescs],
  };
  const dupIdx = S.historyDrafts.findIndex(h => h.script === entry.script && h.outline === entry.outline);
  if (dupIdx >= 0) S.historyDrafts.splice(dupIdx, 1);
  S.historyDrafts.unshift(entry);
  if (S.historyDrafts.length > HISTORY_MAX) S.historyDrafts.length = HISTORY_MAX;
  S.activeHistoryId = entry.id;
  persistHistoryDrafts();
  renderHistoryPanel();
}

function syncHistoryDraftMeta() {
  if (!S.selTitle || !S.selDesc) return;
  const item = S.historyDrafts.find(h => h.id === S.activeHistoryId)
    || S.historyDrafts.find(h => h.script === S.script);
  if (!item) return;
  item.selTitle = S.selTitle;
  item.selDesc = S.selDesc;
  item.script = S.script;
  persistHistoryDrafts();
  renderHistoryPanel();
}

function renderHistoryPanel() {
  const list = document.getElementById('historyList');
  const count = document.getElementById('historyCount');
  if (!list) return;
  if (count) count.textContent = `${S.historyDrafts.length}/${HISTORY_MAX}`;
  if (!S.historyDrafts.length) {
    list.innerHTML = `<div class="history-empty">确认稿件后，最近 ${HISTORY_MAX} 篇会保存在这里</div>`;
    return;
  }
  list.innerHTML = S.historyDrafts.map(item => {
    const label = escHtml(historyDraftLabel(item));
    const sub = escHtml([item.colName, item.savedAt].filter(Boolean).join(' · '));
    const words = (item.script || '').replace(/\s/g, '').length;
    const active = item.id === S.activeHistoryId ? ' active' : '';
    return `<div class="history-item${active}" data-id="${item.id}">
      <button type="button" class="history-item-main" data-action="load">
        <div class="history-item-title">${label}</div>
        <div class="history-item-meta">${sub} · ${words}字</div>
      </button>
      <button type="button" class="history-item-del" data-action="delete" title="删除">✕</button>
    </div>`;
  }).join('');
  if (!list.dataset.bound) {
    list.dataset.bound = '1';
    list.addEventListener('click', e => {
      const itemEl = e.target.closest('.history-item');
      if (!itemEl) return;
      const id = itemEl.dataset.id;
      if (e.target.closest('[data-action="delete"]')) {
        e.stopPropagation();
        deleteHistoryDraft(id);
        return;
      }
      loadHistoryDraft(id);
    });
  }
}

function loadHistoryDraft(id) {
  const item = S.historyDrafts.find(h => h.id === id);
  if (!item) return;

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('edActive').style.display = 'flex';

  const col = item.colId ? S.columns.find(c => c.id === item.colId) : null;
  if (col) {
    S.activeCol = col.id;
    S.expandedCols.add(col.id);
    persistExpandedCols();
    renderColumns();
    showEditorArea(col);
  } else {
    showEditorArea({ name: item.colName || '历史稿件', emoji: item.colEmoji || '📝' });
  }

  document.getElementById('outlineInput').value = item.outline || '';
  updateCC();
  S.script = item.script || '';
  S.selection = null;
  S.chatHistory = [];
  S.selTitle = item.selTitle || '';
  S.selDesc = item.selDesc || '';
  S.activeHistoryId = id;

  document.getElementById('scriptCard').classList.add('show');
  document.getElementById('scriptLabel').style.display = 'flex';
  renderScriptContent();
  document.getElementById('paraHint').style.display = S.script.trim() ? 'block' : 'none';
  document.getElementById('chatCard').style.display = 'none';
  updateSourceReqBtn();

  document.getElementById('metaWrap').classList.add('show');
  renderMeta(item.titles?.length ? item.titles : META_FALLBACK_TITLES, item.descs?.length ? item.descs : META_FALLBACK_DESCS, { restoreSelection: false });

  if (S.selTitle) {
    const ti = __metaTitles.indexOf(S.selTitle);
    if (ti >= 0) document.querySelectorAll('#titleOpts .meta-opt').forEach((el, i) => el.classList.toggle('selected', i === ti));
  }
  if (S.selDesc) {
    const di = __metaDescs.indexOf(S.selDesc);
    if (di >= 0) document.querySelectorAll('#descOpts .meta-opt').forEach((el, i) => el.classList.toggle('selected', i === di));
  }
  if (S.selTitle && S.selDesc) {
    document.getElementById('expTitle').textContent = S.selTitle;
    document.getElementById('expDesc').textContent = S.selDesc;
    document.getElementById('exportBar')?.classList.add('show');
  } else {
    document.getElementById('exportBar')?.classList.remove('show');
  }

  renderHistoryPanel();
  showToast('✓ 已载入历史稿件，可继续修改');
  document.getElementById('scriptBody')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function deleteHistoryDraft(id) {
  S.historyDrafts = S.historyDrafts.filter(h => h.id !== id);
  if (S.activeHistoryId === id) S.activeHistoryId = null;
  persistHistoryDrafts();
  renderHistoryPanel();
  showToast('已删除历史稿件');
}

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
    const prompt = `根据以下视频脚本，生成3条短视频标题备选。返回格式：{"titles":["标题1","标题2","标题3"]}\n${META_TITLE_RULE}\n${META_ENGAGE}\n\n脚本：\n${S.script.slice(0, 800)}`;
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
    const prompt = `根据以下视频脚本，生成2条短视频简介备选。返回格式：{"descs":["简介1","简介2"]}\n${META_DESC_RULE}\n${META_ENGAGE}\n\n脚本：\n${S.script.slice(0, 800)}`;
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
  syncScriptFromEditor();
  if (!S.script?.trim()) { showToast('还没有脚本内容'); return; }
  const mw = document.getElementById('metaWrap');
  mw.classList.add('show');
  S.selTitle = null;
  S.selDesc = null;
  document.getElementById('exportBar')?.classList.remove('show');
  setMetaLoading('title', true);
  setMetaLoading('desc', true);
  mw.scrollIntoView({ behavior: 'smooth' });

  const prompt = `根据以下视频脚本，生成标题和简介备选。返回格式：{"titles":["标题1","标题2","标题3"],"descs":["简介1","简介2"]}\n${META_TITLE_RULE}\n${META_DESC_RULE}\n${META_ENGAGE}\n\n脚本：\n${S.script.slice(0, 800)}`;

  try {
    const parsed = await callMetaJson(prompt);
    renderMeta(parsed.titles || META_FALLBACK_TITLES, parsed.descs || META_FALLBACK_DESCS, { restoreSelection: false });
    saveHistoryDraft();
    showToast('✓ 标题与简介已生成，已存入历史稿件');
  } catch {
    renderMeta(META_FALLBACK_TITLES, META_FALLBACK_DESCS, { restoreSelection: false });
    saveHistoryDraft();
    showToast('生成失败，已显示示例备选并保存到历史');
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
    syncHistoryDraftMeta();
  }
}

function copyScript() {
  syncScriptFromEditor();
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
// Script display, manual edit & free text selection
// ═══════════════════════════════════════════
function updateScriptWordCount() {
  const el = document.getElementById('wordCt');
  if (el) el.textContent = S.script.replace(/\s/g, '').length;
}

function readScriptFromEditor() {
  const body = document.getElementById('scriptBody');
  if (!body) return '';
  return body.innerText.replace(/\u00A0/g, ' ');
}

function syncScriptFromEditor() {
  S.script = readScriptFromEditor();
  updateScriptWordCount();
}

function setScriptEditorMode(mode) {
  const body = document.getElementById('scriptBody');
  if (!body) return;
  const streaming = mode === 'streaming';
  const editable = mode === 'editable';
  body.contentEditable = editable ? 'plaintext-only' : 'false';
  body.classList.toggle('streaming', streaming);
  body.classList.toggle('script-editable', editable);
  body.classList.toggle('script-selectable', editable);
  if (editable) body.tabIndex = 0;
}

function invalidateScriptSelection() {
  if (!S.selection) return;
  S.selection = null;
  updateSourceReqBtn();
  document.querySelectorAll('.chat-apply-btn').forEach(btn => {
    btn.disabled = true;
    btn.textContent = '选区已失效';
  });
}

function onScriptManualEdit() {
  const body = document.getElementById('scriptBody');
  if (!body?.classList.contains('streaming')) syncScriptFromEditor();
  if (S.selection) invalidateScriptSelection();
}

function onScriptPaste(e) {
  const body = document.getElementById('scriptBody');
  if (!body || body.classList.contains('streaming')) return;
  if (body.contentEditable === 'plaintext-only') return;
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') || '';
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  onScriptManualEdit();
}

function renderScriptContent() {
  const body = document.getElementById('scriptBody');
  if (!body) return;
  body.textContent = S.script;
  setScriptEditorMode('editable');
  updateScriptWordCount();
  bindScriptSelectionEditor();
}

function bindScriptSelectionEditor() {
  const body = document.getElementById('scriptBody');
  if (!body || body.dataset.selectionBound) return;
  body.dataset.selectionBound = '1';
  body.addEventListener('mouseup', onScriptMouseUp);
  body.addEventListener('contextmenu', onScriptContextMenu);
  body.addEventListener('input', onScriptManualEdit);
  body.addEventListener('paste', onScriptPaste);
  body.addEventListener('blur', () => {
    if (!body.classList.contains('streaming')) syncScriptFromEditor();
  });
  bindScriptContextMenu();
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
  const text = range.toString();
  if (!text.trim()) return null;
  return { start, end, text };
}

function getCaretOffsetInScript() {
  const body = document.getElementById('scriptBody');
  const sel = window.getSelection();
  if (!body || !sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !body.contains(range.commonAncestorContainer)) return null;
  const measure = document.createRange();
  measure.selectNodeContents(body);
  measure.setEnd(range.startContainer, range.startOffset);
  return measure.toString().length;
}

function onScriptMouseUp() {
  if (document.getElementById('scriptBody')?.classList.contains('streaming')) return;
  requestAnimationFrame(() => {
    syncScriptFromEditor();
    const hit = getSelectionInScript();
    if (hit) {
      setScriptSelection(hit);
      S.scriptCursorOffset = null;
      return;
    }
    const offset = getCaretOffsetInScript();
    if (offset !== null) {
      S.selection = null;
      S.scriptCursorOffset = offset;
      updateSourceReqBtn();
    }
  });
}

function setScriptSelection({ start, end, text }) {
  const changed = !S.selection || S.selection.start !== start || S.selection.end !== end || S.selection.text !== text;
  S.selection = { start, end, text };
  if (changed) {
    S.chatHistory = [];
    const msgs = document.getElementById('chatMsgs');
    if (msgs) msgs.innerHTML = '';
  }
  updateSourceReqBtn();
}

function openSelectionFeedback({ start, end, text }) {
  setScriptSelection({ start, end, text });
  const changed = !S.selection || S.selection.start !== start || S.selection.end !== end;
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

function bindScriptContextMenu() {
  const menu = document.getElementById('scriptContextMenu');
  if (!menu || menu.dataset.bound) return;
  menu.dataset.bound = '1';
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    e.preventDefault();
    const action = btn.dataset.action;
    closeScriptContextMenu();
    handleScriptContextAction(action);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('#scriptContextMenu')) closeScriptContextMenu();
  });
  document.addEventListener('scroll', closeScriptContextMenu, true);
}

function onScriptContextMenu(e) {
  const body = document.getElementById('scriptBody');
  if (!body || body.classList.contains('streaming')) return;
  syncScriptFromEditor();
  const hit = getSelectionInScript();
  if (hit) {
    setScriptSelection(hit);
    S.scriptCursorOffset = null;
  } else {
    S.selection = null;
    S.scriptCursorOffset = getCaretOffsetInScript();
    updateSourceReqBtn();
  }
  e.preventDefault();
  openScriptContextMenu(e.clientX, e.clientY, Boolean(S.selection?.text?.trim()));
}

function openScriptContextMenu(clientX, clientY, hasSelection) {
  const menu = document.getElementById('scriptContextMenu');
  if (!menu) return;
  menu.querySelectorAll('[data-action="ai-edit"], [data-action="sources"], [data-action="cut"], [data-action="copy"]')
    .forEach(btn => { btn.disabled = !hasSelection; });
  menu.hidden = false;
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - pad);
  const top = Math.min(clientY, window.innerHeight - rect.height - pad);
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;
}

function closeScriptContextMenu() {
  const menu = document.getElementById('scriptContextMenu');
  if (menu) menu.hidden = true;
}

async function handleScriptContextAction(action) {
  if (action === 'ai-edit') { openAiEditModal(); return; }
  if (action === 'sources') { requestSources(); return; }
  if (action === 'copy') { await copySelectedScriptText(); return; }
  if (action === 'cut') { await cutSelectedScriptText(); return; }
  if (action === 'paste') { await pasteIntoScriptSelection(); }
}

async function copySelectedScriptText() {
  if (!S.selection?.text) { showToast('请先选中文字'); return; }
  await navigator.clipboard.writeText(S.selection.text);
  showToast('✓ 已复制选中文字');
}

async function cutSelectedScriptText() {
  if (!S.selection?.text) { showToast('请先选中文字'); return; }
  await navigator.clipboard.writeText(S.selection.text);
  applyScriptRangeEdit(S.selection.start, S.selection.end, '', S.selection.text);
  closeChat();
  showToast('✓ 已剪切');
}

async function pasteIntoScriptSelection() {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showToast('浏览器不允许直接粘贴，请使用 Cmd/Ctrl + V');
    return;
  }
  if (!text) return;
  syncScriptFromEditor();
  if (S.selection) {
    applyScriptRangeEdit(S.selection.start, S.selection.end, text, S.selection.text);
  } else if (S.scriptCursorOffset !== null) {
    const start = Math.max(0, Math.min(S.script.length, S.scriptCursorOffset));
    applyScriptRangeEdit(start, start, text, '');
  } else {
    S.script += text;
    renderScriptContent();
  }
  showToast('✓ 已粘贴');
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
  syncScriptFromEditor();
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
  const expected = S.selection?.start === start && S.selection?.end === end ? S.selection.text : '';
  if (!applyScriptRangeEdit(start, end, newText, expected)) return;
  const newEnd = start + newText.length;
  S.selection = { start, end: newEnd, text: newText };
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

function applyScriptRangeEdit(start, end, newText, expectedText = '') {
  syncScriptFromEditor();
  const current = S.script.slice(start, end);
  if (expectedText && current !== expectedText) {
    showToast('原文已变化，请重新选中要修改的文字');
    return false;
  }
  S.script = S.script.slice(0, start) + newText + S.script.slice(end);
  renderScriptContent();
  if (newText) S.selection = { start, end: start + newText.length, text: newText };
  else S.selection = null;
  updateSourceReqBtn();
  return true;
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendParaChat(); }
}

// ═══════════════════════════════════════════
// Word-like context edit modal
// ═══════════════════════════════════════════
function loadRevisionEntries() {
  try {
    const raw = ls('revisionEntries');
    if (raw) S.revisionEntries = JSON.parse(raw);
  } catch { S.revisionEntries = []; }
  if (!Array.isArray(S.revisionEntries)) S.revisionEntries = [];
}

function persistRevisionEntries() {
  try { lss('revisionEntries', JSON.stringify(S.revisionEntries.slice(0, 50))); } catch {}
}

function recordRevisionEntry(entry) {
  S.revisionEntries.unshift(entry);
  persistRevisionEntries();
}

function setAiEditStatus(text, kind = '') {
  const el = document.getElementById('aiEditStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ai-edit-status' + (kind ? ' is-' + kind : '');
}

function openAiEditModal() {
  syncScriptFromEditor();
  if (!S.selection?.text?.trim()) {
    showToast('请先选中要修改的文字');
    return;
  }
  S.aiEditDraft = {
    start: S.selection.start,
    end: S.selection.end,
    originalText: S.selection.text,
    instruction: '',
    result: S.selection.text,
    prompts: null,
  };
  document.getElementById('aiEditOriginal').textContent = S.selection.text;
  document.getElementById('aiEditInstruction').value = '';
  document.getElementById('aiEditResult').value = S.selection.text;
  setAiEditStatus('', '');
  openModal('aiEditModal');
  setTimeout(() => document.getElementById('aiEditInstruction')?.focus(), 0);
}

function closeAiEditModal() {
  closeModal('aiEditModal');
  S.aiEditDraft = null;
  setAiEditStatus('', '');
}

function buildAiEditPrompts(instruction, originalText) {
  const system = '你是专业视频脚本编辑。根据用户的修改要求，对脚本中被选中的片段进行改写。只返回改写后的片段正文，不添加任何解释、前缀或引号，不要输出未被选中的其他内容。';
  const user = `完整脚本供参考：
${S.script}

需要修改的选中内容：
${originalText}

修改要求：
${instruction}`;
  return { system, user };
}

async function regenerateAiEdit() {
  if (!S.aiEditDraft) return;
  syncScriptFromEditor();
  const instructionEl = document.getElementById('aiEditInstruction');
  const resultEl = document.getElementById('aiEditResult');
  const regenBtn = document.getElementById('aiEditRegenBtn');
  const confirmBtn = document.getElementById('aiEditConfirmBtn');
  const instruction = instructionEl.value.trim();
  if (!instruction) {
    showToast('请先填写修改意见');
    instructionEl.focus();
    return;
  }
  const current = S.script.slice(S.aiEditDraft.start, S.aiEditDraft.end);
  if (current !== S.aiEditDraft.originalText) {
    showToast('原文已变化，请关闭后重新选择');
    setAiEditStatus('原文已变化，请关闭弹窗后重新选择要修改的文字。', 'err');
    return;
  }

  const prompts = buildAiEditPrompts(instruction, S.aiEditDraft.originalText);
  S.aiEditDraft.instruction = instruction;
  S.aiEditDraft.prompts = prompts;
  S.aiEditDraft.result = '';
  resultEl.value = '';
  resultEl.disabled = true;
  regenBtn.disabled = true;
  confirmBtn.disabled = true;
  setAiEditStatus('正在生成修改稿…', 'info');

  try {
    await callStreamWithHistory(prompts.system, [{ role: 'user', content: prompts.user }], chunk => {
      S.aiEditDraft.result += chunk;
      resultEl.value = S.aiEditDraft.result;
      resultEl.scrollTop = resultEl.scrollHeight;
    });
    persistApiSettings();
    setAiEditStatus('已生成，可继续编辑后确认替换。', 'ok');
  } catch (e) {
    setAiEditStatus('生成失败：' + e.message, 'err');
    showToast('❌ ' + e.message);
  } finally {
    resultEl.disabled = false;
    regenBtn.disabled = false;
    confirmBtn.disabled = false;
    resultEl.focus();
  }
}

function confirmAiEdit() {
  if (!S.aiEditDraft) return;
  const resultEl = document.getElementById('aiEditResult');
  const instructionEl = document.getElementById('aiEditInstruction');
  const revisedText = resultEl.value.trim();
  if (!revisedText) {
    showToast('修改后文字不能为空');
    resultEl.focus();
    return;
  }
  const instruction = instructionEl.value.trim();
  const draft = S.aiEditDraft;
  const ok = applyScriptRangeEdit(draft.start, draft.end, revisedText, draft.originalText);
  if (!ok) return;

  const cfg = PROVIDER_CFG[currentProvider()];
  recordRevisionEntry({
    id: 'rev_' + Date.now(),
    createdAt: new Date().toLocaleString('zh-CN'),
    provider: cfg?.name || currentProvider(),
    model: fieldValue(cfg?.modelKey || ''),
    originalText: draft.originalText,
    revisedText,
    instruction,
    prompts: draft.prompts || buildAiEditPrompts(instruction || '用户手动编辑修改稿', draft.originalText),
  });
  closeAiEditModal();
  showToast('✓ 已替换原文并记录修改');
}


// ═══════════════════════════════════════════
// Truth investigation
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

function activeTruthEntry() {
  return S.sourceEntries.find(entry => entry.id === S.activeSourceId) || null;
}

function renderCitationsPanel(streamingText) {
  const empty = document.getElementById('citEmpty');
  const list = document.getElementById('citList');
  const askBox = document.getElementById('truthAskBox');
  if (!list) return;

  if (streamingText !== undefined) {
    if (empty) empty.hidden = true;
    if (askBox) askBox.hidden = true;
    list.hidden = false;
    list.innerHTML = '<div class="cit-entry active"><div class="cit-entry-head">正在真实性调查…</div><div class="cit-content streaming">' + formatCitationContent(streamingText) + '</div></div>';
    list.scrollTop = list.scrollHeight;
    return;
  }

  if (!S.sourceEntries.length) {
    if (empty) empty.hidden = false;
    if (askBox) askBox.hidden = true;
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  if (empty) empty.hidden = true;
  list.hidden = false;
  if (askBox) askBox.hidden = !activeTruthEntry();
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
      if (Array.isArray(entry.qa) && entry.qa.length) {
        h += '<div class="truth-qa-list">';
        for (const qa of entry.qa) {
          h += '<div class="truth-qa-item">';
          h += '<div class="truth-q">问：' + escHtml(qa.question) + '</div>';
          h += '<div class="truth-a">' + formatCitationContent(qa.answer) + '</div>';
          h += '</div>';
        }
        h += '</div>';
      }
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
  const askBox = document.getElementById('truthAskBox');
  if (askBox) askBox.hidden = true;
}

async function requestSources() {
  syncScriptFromEditor();
  if (!S.script.trim()) { showToast('请先生成脚本草稿'); return; }
  if (!S.selection?.text?.trim()) { showToast('请先选中要做真实性调查的文字'); return; }

  const sentence = S.selection.text.trim();
  const btn = document.getElementById('sourceReqBtn');
  if (btn) { btn.disabled = true; btn.textContent = '调查中…'; }

  renderCitationsPanel('正在启动真实数据库检索…\n');
  try {
    const { points, sources } = await fetchGroundedSources({
      sentence,
      script: S.script,
      onProgress: msg => renderCitationsPanel(msg),
      callStream,
    });
    renderCitationsPanel('已获得真实检索结果，正在基于来源生成真实性结论…\n');
    const answer = await buildTruthInvestigationAnswer({
      sentence,
      script: S.script,
      sources,
      callStream,
    });
    const content = formatTruthInvestigationMarkdown(sentence, answer, sources);
    persistApiSettings();
    const entry = {
      id: 'src_' + Date.now(),
      sentence,
      content,
      points,
      sources,
      qa: [],
      createdAt: new Date().toLocaleString('zh-CN'),
    };
    S.sourceEntries.unshift(entry);
    S.activeSourceId = entry.id;
    persistSourceEntries();
    renderCitationsPanel();
    showToast('✓ 已完成真实性调查');
  } catch (e) {
    renderCitationsError(e.message);
    showToast('❌ ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '真实性调查'; }
    updateSourceReqBtn();
  }
}

async function askTruthQuestion() {
  const entry = activeTruthEntry();
  const input = document.getElementById('truthAskInput');
  const btn = document.getElementById('truthAskBtn');
  const question = input?.value.trim();
  if (!entry) { showToast('请先展开一条真实性调查'); return; }
  if (!question) { input?.focus(); return; }
  input.value = '';
  if (!Array.isArray(entry.qa)) entry.qa = [];
  const qa = { question, answer: '正在基于当前真实来源回答…', createdAt: new Date().toLocaleString('zh-CN') };
  entry.qa.push(qa);
  renderCitationsPanel();
  const activeBtn = document.getElementById('truthAskBtn') || btn;
  if (activeBtn) { activeBtn.disabled = true; activeBtn.textContent = '回答中…'; }

  try {
    const answer = await answerTruthFollowup({ question, entry, callStream });
    qa.answer = answer;
    persistApiSettings();
    persistSourceEntries();
    renderCitationsPanel();
    showToast('✓ 已基于来源回答');
  } catch (e) {
    qa.answer = '❌ ' + e.message;
    renderCitationsPanel();
    showToast('❌ ' + e.message);
  } finally {
    const nextBtn = document.getElementById('truthAskBtn') || btn;
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = '提问'; }
    document.getElementById('truthAskInput')?.focus();
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
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeScriptContextMenu();
    document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show'));
  }
});

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
  applyCreatorIdentityPreset,
  saveCreatorIdentityPreset,
  renameCreatorIdentityPreset,
  deleteCreatorIdentityPreset,
  updateCC,
  copyScript,
  confirmScript,
  regenerateMetaTitles,
  regenerateMetaDescs,
  closeChat,
  sendParaChat,
  openAiEditModal,
  regenerateAiEdit,
  confirmAiEdit,
  closeAiEditModal,
  requestSources,
  askTruthQuestion,
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
  pickMeta,
});
