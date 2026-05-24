import { Document, Packer, Paragraph, TextRun } from 'docx';

export const DEFAULT_TOPIC_SOURCES = [
  { id: 'kepuchina', url: 'https://www.kepuchina.cn', enabled: true },
  { id: 'guokr', url: 'https://www.guokr.com', enabled: true },
  { id: 'popsci', url: 'https://www.popsci.com/', enabled: false },
  { id: 'sciencealert', url: 'https://www.sciencealert.com/', enabled: false },
  { id: 'sciam', url: 'https://www.scientificamerican.com/', enabled: false },
  {
    id: 'bilibili',
    url: 'https://www.bilibili.com',
    enabled: true,
  },
];

const LS_SOURCES = 'topicSources';
const LS_FAV = 'topicFavorites';

let deps = {};
let topicState = {
  sources: [],
  favorites: [],
  results: [],
  offset: 0,
  page: 1,
  hasMore: false,
  lastKeyword: '',
  lastRelated: [],
  searching: false,
  seenUrls: new Set(),
  dateNavYear: new Date().getFullYear(),
  dateNavMonth: new Date().getMonth() + 1,
};

function normalizeSources(sources) {
  return sources.map((s) => {
    let url = s.url || '';
    if (url.includes('bilibili.com/c/knowledge') || url.includes('bilibili.com/c/')) {
      url = 'https://www.bilibili.com';
    }
    return { ...s, url };
  });
}

function loadSources() {
  try {
    const raw = localStorage.getItem(LS_SOURCES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        topicState.sources = normalizeSources(parsed);
        return;
      }
    }
  } catch {}
  topicState.sources = DEFAULT_TOPIC_SOURCES.map((s) => ({ ...s }));
}

function saveSources() {
  try {
    localStorage.setItem(LS_SOURCES, JSON.stringify(topicState.sources));
  } catch {}
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(LS_FAV);
    topicState.favorites = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(topicState.favorites)) topicState.favorites = [];
  } catch {
    topicState.favorites = [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(LS_FAV, JSON.stringify(topicState.favorites));
  } catch {}
}

function esc(s) {
  return deps.escHtml ? deps.escHtml(s) : String(s);
}

function formatDateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDateInput(value) {
  if (!value) return null;
  const d = new Date(`${value}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function syncDateNavFromInputs() {
  const from = parseDateInput(document.getElementById('tpDateFrom')?.value);
  const to = parseDateInput(document.getElementById('tpDateTo')?.value);
  const ref = from || to;
  if (ref) {
    topicState.dateNavYear = ref.getFullYear();
    topicState.dateNavMonth = ref.getMonth() + 1;
  }
}

function updateDateNavLabel() {
  const el = document.getElementById('tpDateNavLabel');
  if (el) el.textContent = `${topicState.dateNavYear}年${topicState.dateNavMonth}月`;
}

function shiftDateField(id, years, months) {
  const el = document.getElementById(id);
  if (!el) return;
  const d = parseDateInput(el.value);
  if (!d) return;
  d.setFullYear(d.getFullYear() + years);
  d.setMonth(d.getMonth() + months);
  el.value = formatDateISO(d);
}

function addNavMonths(years, months) {
  const fromEl = document.getElementById('tpDateFrom');
  const toEl = document.getElementById('tpDateTo');
  const hasFrom = !!fromEl?.value;
  const hasTo = !!toEl?.value;

  if (hasFrom || hasTo) {
    if (hasFrom) shiftDateField('tpDateFrom', years, months);
    if (hasTo) shiftDateField('tpDateTo', years, months);
    syncDateNavFromInputs();
  } else {
    let y = topicState.dateNavYear;
    let m = topicState.dateNavMonth + months + years * 12;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    while (m > 12) {
      m -= 12;
      y += 1;
    }
    topicState.dateNavYear = y;
    topicState.dateNavMonth = m;
    const firstDay = formatDateISO(new Date(y, m - 1, 1));
    if (fromEl) fromEl.value = firstDay;
  }
  updateDateNavLabel();
}

function updateSelectAllBtn() {
  const btn = document.getElementById('tpSelectAllBtn');
  if (!btn) return;
  const allOn = topicState.sources.length > 0 && topicState.sources.every((s) => s.enabled !== false);
  btn.classList.toggle('on', allOn);
  btn.setAttribute('aria-pressed', allOn ? 'true' : 'false');
}

function toggleSelectAllSources() {
  if (!topicState.sources.length) return;
  const allOn = topicState.sources.every((s) => s.enabled !== false);
  const next = !allOn;
  topicState.sources.forEach((s) => {
    s.enabled = next;
  });
  saveSources();
  renderSourceList();
}

function renderSourceList() {
  const el = document.getElementById('tpSourceList');
  if (!el) return;
  el.innerHTML = topicState.sources
    .map(
      (s, i) => `
    <div class="tp-source-row">
      <input type="checkbox" class="tp-source-check" data-idx="${i}" ${s.enabled !== false ? 'checked' : ''} />
      <input type="text" class="tp-source-url" data-idx="${i}" value="${esc(s.url)}" />
      <button type="button" class="tp-source-del" data-idx="${i}" title="删除">✕</button>
    </div>`,
    )
    .join('');

  el.querySelectorAll('.tp-source-url').forEach((input) => {
    input.addEventListener('change', () => {
      const idx = Number(input.dataset.idx);
      topicState.sources[idx].url = input.value.trim();
      saveSources();
    });
  });
  el.querySelectorAll('.tp-source-check').forEach((input) => {
    input.addEventListener('change', () => {
      const idx = Number(input.dataset.idx);
      topicState.sources[idx].enabled = input.checked;
      saveSources();
      updateSelectAllBtn();
    });
  });
  el.querySelectorAll('.tp-source-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      topicState.sources.splice(Number(btn.dataset.idx), 1);
      saveSources();
      renderSourceList();
    });
  });
  updateSelectAllBtn();
}

function renderResults() {
  const el = document.getElementById('tpResults');
  const meta = document.getElementById('tpResultsMeta');
  if (!el) return;

  if (topicState.searching) {
    el.innerHTML = '<div class="tp-status">正在检索信源并生成提纲…</div>';
    if (meta) meta.textContent = '';
    document.getElementById('tpRefreshBtn')?.classList.add('hidden');
    return;
  }

  if (!topicState.results.length) {
    el.innerHTML = '<div class="tp-status">输入关键词后点击搜索，将抓取各信源热门选题</div>';
    if (meta) meta.textContent = '';
    document.getElementById('tpRefreshBtn')?.classList.add('hidden');
    return;
  }

  if (meta) meta.textContent = `本批 ${topicState.results.length} 条`;

  el.innerHTML = topicState.results
    .map((item) => {
      const fav = topicState.favorites.some((f) => f.url === item.url);
      const metric =
        item.metric > 0 ? `${item.metricLabel || '热度'} ${item.metric.toLocaleString()}` : item.metricLabel || '';
      return `
      <article class="tp-result-item">
        <div class="tp-result-top">
          <button type="button" class="tp-fav-btn${fav ? ' on' : ''}" data-url="${esc(item.url)}" title="收藏">${fav ? '★' : '☆'}</button>
          <a class="tp-result-title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
        </div>
        <div class="tp-result-meta">${esc(item.sourceName)}${metric ? ' · ' + esc(metric) : ''}</div>
        <p class="tp-result-summary">${esc(item.summary || item.snippet || '')}</p>
      </article>`;
    })
    .join('');

  const refreshBtn = document.getElementById('tpRefreshBtn');
  if (refreshBtn) {
    refreshBtn.classList.toggle('hidden', !topicState.lastKeyword);
    refreshBtn.disabled = !topicState.lastKeyword;
  }
}

function updateFavBar() {
  const n = topicState.favorites.length;
  const el = document.getElementById('tpFavCount');
  if (el) el.textContent = String(n);
  const exp = document.getElementById('tpExportFavBtn');
  const clearBtn = document.getElementById('tpClearFavBtn');
  if (exp) exp.disabled = n === 0;
  if (clearBtn) clearBtn.disabled = n === 0;
}

function renderTopicShell() {
  const root = document.getElementById('topicPanel');
  if (!root) return;
  if (root.dataset.built === '5') return;
  root.dataset.built = '5';

  root.innerHTML = `
    <div class="tp-search-row">
      <input type="search" id="tpKeyword" class="tp-input" placeholder="输入关键词…" autocomplete="off" />
      <button type="button" id="tpSearchBtn" class="tp-btn primary">搜索</button>
    </div>

    <details class="tp-block" open>
      <summary>搜索信源合集</summary>
      <div class="tp-block-body">
        <button type="button" id="tpSelectAllBtn" class="tp-btn ghost tp-select-all" aria-pressed="false">全选</button>
        <div id="tpSourceList"></div>
        <button type="button" id="tpAddSourceBtn" class="tp-btn ghost">+ 添加信源</button>
      </div>
    </details>

    <details class="tp-block tp-block-advanced">
      <summary>搜索高级功能</summary>
      <div class="tp-block-body">
        <div class="tp-date-nav">
          <button type="button" id="tpDatePrevYear" class="tp-date-nav-btn" title="上一年">«</button>
          <button type="button" id="tpDatePrevMonth" class="tp-date-nav-btn" title="上一月">‹</button>
          <span class="tp-date-nav-label" id="tpDateNavLabel"></span>
          <button type="button" id="tpDateNextMonth" class="tp-date-nav-btn" title="下一月">›</button>
          <button type="button" id="tpDateNextYear" class="tp-date-nav-btn" title="下一年">»</button>
        </div>
        <div class="tp-date-row">
          <label class="tp-date-label">起始<input type="date" id="tpDateFrom" class="tp-date" /></label>
          <label class="tp-date-label">截止<input type="date" id="tpDateTo" class="tp-date" /></label>
        </div>
      </div>
    </details>

    <div class="tp-fav-bar">
      <span>已收藏 <strong id="tpFavCount">0</strong> 个选题</span>
      <div class="tp-export-row">
        <select id="tpExportFormat" class="tp-export-format" title="导出格式">
          <option value="md">Markdown (.md)</option>
          <option value="txt">纯文本 (.txt)</option>
          <option value="doc">Word (.docx)</option>
        </select>
        <button type="button" id="tpExportFavBtn" class="tp-btn ghost" disabled>导出</button>
        <button type="button" id="tpClearFavBtn" class="tp-btn ghost tp-clear-fav" disabled>清空</button>
      </div>
    </div>

    <div class="tp-results-head">
      <span class="tp-results-meta" id="tpResultsMeta"></span>
      <button type="button" id="tpRefreshBtn" class="tp-btn refresh hidden">换一批重新搜索</button>
    </div>
    <div class="tp-results" id="tpResults"></div>
  `;

  bindTopicEvents();
  renderSourceList();
  updateDateNavLabel();
  updateFavBar();
  renderResults();
}

function bindTopicEvents() {
  document.getElementById('tpSearchBtn')?.addEventListener('click', () => runTopicSearch(false));
  document.getElementById('tpKeyword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTopicSearch(false);
  });
  document.getElementById('tpRefreshBtn')?.addEventListener('click', () => runTopicSearch(true));
  document.getElementById('tpSelectAllBtn')?.addEventListener('click', toggleSelectAllSources);
  document.getElementById('tpAddSourceBtn')?.addEventListener('click', () => {
    topicState.sources.push({ id: crypto.randomUUID(), url: 'https://', enabled: true });
    saveSources();
    renderSourceList();
  });
  document.getElementById('tpExportFavBtn')?.addEventListener('click', exportFavorites);
  document.getElementById('tpClearFavBtn')?.addEventListener('click', clearFavorites);
  document.getElementById('tpDateFrom')?.addEventListener('change', syncDateNavFromInputs);
  document.getElementById('tpDateFrom')?.addEventListener('change', updateDateNavLabel);
  document.getElementById('tpDateTo')?.addEventListener('change', syncDateNavFromInputs);
  document.getElementById('tpDateTo')?.addEventListener('change', updateDateNavLabel);
  document.getElementById('tpDatePrevYear')?.addEventListener('click', () => addNavMonths(-1, 0));
  document.getElementById('tpDatePrevMonth')?.addEventListener('click', () => addNavMonths(0, -1));
  document.getElementById('tpDateNextMonth')?.addEventListener('click', () => addNavMonths(0, 1));
  document.getElementById('tpDateNextYear')?.addEventListener('click', () => addNavMonths(1, 0));

  document.getElementById('tpResults')?.addEventListener('click', (e) => {
    const favBtn = e.target.closest('.tp-fav-btn');
    if (favBtn) {
      toggleFavorite(favBtn.dataset.url);
    }
  });
}

function toggleFavorite(url) {
  if (!url) return;
  const idx = topicState.favorites.findIndex((f) => f.url === url);
  if (idx >= 0) {
    topicState.favorites.splice(idx, 1);
    deps.showToast?.('已取消收藏');
  } else {
    const item = topicState.results.find((r) => r.url === url) || { url, title: url };
    topicState.favorites.unshift({ ...item, savedAt: new Date().toLocaleString('zh-CN') });
    deps.showToast?.('✓ 已收藏');
  }
  saveFavorites();
  updateFavBar();
  renderResults();
}

function clearFavorites() {
  if (!topicState.favorites.length) return;
  if (!window.confirm(`确定清空已收藏的 ${topicState.favorites.length} 个选题吗？`)) return;
  topicState.favorites = [];
  saveFavorites();
  updateFavBar();
  renderResults();
  deps.showToast?.('✓ 已清空收藏');
}

function downloadFavoritesFile(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function getExportBasename() {
  return `选题收藏-${new Date().toISOString().slice(0, 10)}`;
}

function buildFavoritesMarkdown() {
  const body = topicState.favorites
    .map(
      (f, i) =>
        `## ${i + 1}. ${f.title}\n\n> ${f.summary || f.snippet || ''}\n\n来源：${f.sourceName || ''} · ${f.url}\n`,
    )
    .join('\n');
  return `# 选题收藏\n\n${body}`;
}

function buildFavoritesTxt() {
  const header = `选题收藏（共 ${topicState.favorites.length} 条）\n${'='.repeat(24)}\n\n`;
  const body = topicState.favorites
    .map((f, i) => {
      const lines = [
        `${i + 1}. ${f.title}`,
        f.summary || f.snippet || '',
        `来源：${f.sourceName || ''}`,
        `链接：${f.url}`,
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n' + '-'.repeat(24) + '\n\n');
  return header + body;
}

async function buildFavoritesDocx() {
  const children = [
    new Paragraph({
      children: [new TextRun({ text: '选题收藏', bold: true, size: 32 })],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `共 ${topicState.favorites.length} 条 · ${new Date().toLocaleDateString('zh-CN')}`,
          size: 20,
          color: '666666',
        }),
      ],
    }),
    new Paragraph({ text: '' }),
  ];

  topicState.favorites.forEach((f, i) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `${i + 1}. ${f.title}`, bold: true, size: 26 })],
      }),
    );
    const summary = f.summary || f.snippet || '';
    if (summary) {
      children.push(new Paragraph({ children: [new TextRun({ text: summary, size: 24 })] }));
    }
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `来源：${f.sourceName || ''} · ${f.url}`,
            size: 20,
            color: '666666',
          }),
        ],
      }),
    );
    children.push(new Paragraph({ text: '' }));
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

async function exportFavorites() {
  if (!topicState.favorites.length) return;
  const format = document.getElementById('tpExportFormat')?.value || 'md';
  const base = getExportBasename();

  if (format === 'txt') {
    const blob = new Blob([buildFavoritesTxt()], { type: 'text/plain;charset=utf-8' });
    downloadFavoritesFile(blob, `${base}.txt`);
    deps.showToast?.('✓ 已导出 TXT');
    return;
  }

  if (format === 'doc') {
    const blob = await buildFavoritesDocx();
    downloadFavoritesFile(blob, `${base}.docx`);
    deps.showToast?.('✓ 已导出 Word');
    return;
  }

  const blob = new Blob([buildFavoritesMarkdown()], { type: 'text/markdown;charset=utf-8' });
  downloadFavoritesFile(blob, `${base}.md`);
  deps.showToast?.('✓ 已导出 Markdown');
}

async function expandRelatedKeywords(keyword) {
  if (!deps.callMetaJson) return [];
  try {
    const parsed = await deps.callMetaJson(
      `与科普短视频选题相关的搜索词。主题：「${keyword}」。返回 JSON：{"related":["词1","词2","词3"]}，每个词2-8字。`,
    );
    return (parsed.related || []).filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

async function summarizeItems(items) {
  if (!items.length || !deps.callMetaJson) {
    return items.map((it) => ({ ...it, summary: (it.snippet || it.title).slice(0, 100) }));
  }
  const lines = items
    .map((it, i) => `${i + 1}. 标题：${it.title}\n摘要：${(it.snippet || '').slice(0, 120)}`)
    .join('\n\n');
  try {
    const parsed = await deps.callMetaJson(
      `为每条科普选题写100字以内中文视频提纲。返回 JSON：{"summaries":["提纲1",...]}，长度 ${items.length}。\n\n${lines}`,
    );
    const sums = parsed.summaries || [];
    return items.map((it, i) => ({ ...it, summary: String(sums[i] || it.snippet || it.title).slice(0, 100) }));
  } catch {
    return items.map((it) => ({ ...it, summary: (it.snippet || it.title).slice(0, 100) }));
  }
}

async function runTopicSearch(isRefresh) {
  const keyword = document.getElementById('tpKeyword')?.value.trim();
  if (!keyword) {
    deps.showToast?.('请输入搜索关键词');
    return;
  }

  if (isRefresh) {
    topicState.page += 1;
    topicState.offset = 0;
  } else {
    topicState.offset = 0;
    topicState.page = 1;
    topicState.lastKeyword = keyword;
    topicState.seenUrls.clear();
  }

  topicState.searching = true;
  renderResults();

  try {
    let related = topicState.lastRelated;
    if (!isRefresh || !related.length) {
      related = await expandRelatedKeywords(keyword);
      topicState.lastRelated = related;
    }

    const limit = 20;
    const maxPageAttempts = 5;
    let page = topicState.page;
    let rawItems = [];
    let lastHasMore = false;

    for (let attempt = 0; attempt < maxPageAttempts && rawItems.length < limit; attempt++) {
      const excludeUrls = [...topicState.seenUrls, ...rawItems.map((it) => it.url)];
      const res = await fetch('/api/topic-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword,
          related,
          sources: topicState.sources,
          dateFrom: document.getElementById('tpDateFrom')?.value || '',
          dateTo: document.getElementById('tpDateTo')?.value || '',
          offset: 0,
          page,
          limit,
          excludeUrls,
        }),
      });

      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);

      const data = await res.json();
      lastHasMore = !!data.hasMore;
      const batch = (data.items || []).filter(
        (it) => it.url && !topicState.seenUrls.has(it.url) && !rawItems.some((r) => r.url === it.url),
      );
      rawItems.push(...batch);

      if (rawItems.length >= limit) break;
      if (!lastHasMore && batch.length === 0) {
        page += 1;
        continue;
      }
      if (!lastHasMore) break;
      page += 1;
    }

    topicState.page = page;

    if (!rawItems.length) {
      topicState.hasMore = false;
      if (isRefresh) {
        topicState.page = Math.max(1, topicState.page - 1);
        deps.showToast?.('没有更多未展示的选题了');
      } else {
        topicState.results = [];
        deps.showToast?.('未找到相关选题');
      }
      return;
    }

    const nextItems = rawItems.slice(0, limit);
    topicState.results = await summarizeItems(nextItems);
    nextItems.forEach((it) => {
      if (it.url) topicState.seenUrls.add(it.url);
    });
    topicState.hasMore = lastHasMore || rawItems.length > limit;
    deps.showToast?.(`✓ 已获取 ${topicState.results.length} 条新选题`);
  } catch (e) {
    deps.showToast?.('❌ ' + (e.message || '搜索失败'));
    if (!isRefresh) topicState.results = [];
  } finally {
    topicState.searching = false;
    renderResults();
  }
}

export function initTopicPanel(api) {
  deps = api;
  loadSources();
  loadFavorites();
  renderTopicShell();
}

export function renderTopicPanel() {
  renderTopicShell();
  renderSourceList();
  updateFavBar();
  renderResults();
}
