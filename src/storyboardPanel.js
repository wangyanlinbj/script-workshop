let deps = {};
let sbState = {
  scriptText: '',
  shots: [],
  batchGenerating: false,
  busyShotId: null,
};

function esc(s) {
  return deps.escHtml ? deps.escHtml(s) : String(s);
}

function splitScriptSegments(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const paras = t.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 2) return paras;
  const sentences = t.split(/(?<=[。！？!?；;])\s*/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length >= 2) return sentences;
  return [t];
}

function syncScriptFromInput() {
  sbState.scriptText = document.getElementById('sbScriptInput')?.value || '';
}

function syncShotsFromDom() {
  document.querySelectorAll('[data-sb-script]').forEach((ta) => {
    const shot = sbState.shots.find((s) => s.id === ta.dataset.sbScript);
    if (shot) shot.scriptSegment = ta.value;
  });
  document.querySelectorAll('[data-sb-visual]').forEach((ta) => {
    const shot = sbState.shots.find((s) => s.id === ta.dataset.sbVisual);
    if (shot) shot.visualDesc = ta.value;
  });
}

function renderStoryboardShell() {
  const root = document.getElementById('storyboardModule');
  if (!root || root.dataset.built === '1') return;
  root.dataset.built = '1';

  root.innerHTML = `
    <div class="sec-label">分镜稿创作</div>
    <div class="sb-toolbar">
      <button type="button" id="sbTransferBtn" class="sb-btn">从脚本区转入</button>
      <button type="button" id="sbUploadBtn" class="sb-btn">本地上传</button>
      <input type="file" id="sbUploadInput" accept=".txt,.md,.doc,.docx" hidden />
      <button type="button" id="sbGenerateBtn" class="sb-btn primary">生成分镜稿</button>
    </div>
    <div class="sb-board">
      <div class="sb-col-head">
        <span>逐字稿</span>
        <span>分镜稿</span>
      </div>
      <div class="sb-board-top">
        <div class="sb-source-pane">
          <textarea id="sbScriptInput" class="sb-script-input" rows="8"
            placeholder="逐字稿可从上方脚本区转入，或本地上传；也可直接粘贴编辑…"></textarea>
          <div class="sb-source-foot">字数：<strong id="sbScriptCount">0</strong></div>
        </div>
        <div class="sb-board-hint">
          <p>逐字稿按段落/句子切分后，下方将逐条展示与分镜画面的一一对应关系。</p>
        </div>
      </div>
      <div class="sb-rows" id="sbRows">
        <p class="sb-empty">填入逐字稿后点击「生成分镜稿」</p>
      </div>
    </div>
  `;

  bindStoryboardEvents();
  updateScriptCount();
  renderShotRows();
}

function bindStoryboardEvents() {
  document.getElementById('sbTransferBtn')?.addEventListener('click', transferFromMainScript);
  document.getElementById('sbUploadBtn')?.addEventListener('click', () => document.getElementById('sbUploadInput')?.click());
  document.getElementById('sbUploadInput')?.addEventListener('change', handleScriptUpload);
  document.getElementById('sbGenerateBtn')?.addEventListener('click', generateAllStoryboards);
  document.getElementById('sbScriptInput')?.addEventListener('input', () => {
    syncScriptFromInput();
    updateScriptCount();
  });

  document.getElementById('sbRows')?.addEventListener('click', (e) => {
    const regen = e.target.closest('[data-sb-regen]');
    if (regen) {
      regenerateShot(regen.dataset.sbRegen);
      return;
    }
    const confirmBtn = e.target.closest('[data-sb-confirm]');
    if (confirmBtn) {
      confirmShotVisual(confirmBtn.dataset.sbConfirm);
      return;
    }
    const copyBtn = e.target.closest('[data-sb-copy]');
    if (copyBtn) copyImagePrompt(copyBtn.dataset.sbCopy);
  });

  document.getElementById('sbRows')?.addEventListener('input', (e) => {
    const scriptTa = e.target.closest('[data-sb-script]');
    if (scriptTa) {
      const shot = sbState.shots.find((s) => s.id === scriptTa.dataset.sbScript);
      if (shot) {
        shot.scriptSegment = scriptTa.value;
        shot.confirmed = false;
        shot.imagePrompt = '';
        updateShotPromptBlock(shot.id);
      }
      return;
    }
    const visualTa = e.target.closest('[data-sb-visual]');
    if (visualTa) {
      const shot = sbState.shots.find((s) => s.id === visualTa.dataset.sbVisual);
      if (shot) {
        shot.visualDesc = visualTa.value;
        shot.confirmed = false;
        shot.imagePrompt = '';
        updateShotPromptBlock(shot.id);
      }
    }
  });
}

function updateScriptCount() {
  const el = document.getElementById('sbScriptCount');
  if (el) el.textContent = String(sbState.scriptText.replace(/\s/g, '').length);
}

function transferFromMainScript() {
  const text = deps.readMainScript?.() || '';
  if (!text.trim()) {
    deps.showToast?.('上方脚本区还没有逐字稿');
    return;
  }
  const ta = document.getElementById('sbScriptInput');
  if (ta) ta.value = text;
  syncScriptFromInput();
  updateScriptCount();
  sbState.shots = [];
  renderShotRows();
  deps.showToast?.('✓ 已转入逐字稿');
}

async function handleScriptUpload(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    let text = '';
    const name = file.name.toLowerCase();
    if (name.endsWith('.docx') || name.endsWith('.doc')) {
      if (!deps.readDocxText) throw new Error('暂不支持 Word，请改用 .txt 或 .md');
      text = await deps.readDocxText(file);
    } else {
      text = await file.text();
    }
    const ta = document.getElementById('sbScriptInput');
    if (ta) ta.value = text;
    syncScriptFromInput();
    updateScriptCount();
    sbState.shots = [];
    renderShotRows();
    deps.showToast?.('✓ 已上传逐字稿');
  } catch (err) {
    deps.showToast?.('❌ ' + (err.message || '上传失败'));
  }
}

function isShotBusy(id) {
  return sbState.busyShotId === id;
}

function renderSingleShotRow(shot, i) {
  const busy = isShotBusy(shot.id);
  const disabled = sbState.batchGenerating || busy;
  const promptBlock = shot.imagePrompt
    ? `<div class="sb-prompt-box" data-sb-prompt="${esc(shot.id)}">
            <div class="sb-prompt-label">GPT Image 提示词${shot.confirmed ? ' ✓' : ''}</div>
            <textarea class="sb-prompt-text" readonly rows="3">${esc(shot.imagePrompt)}</textarea>
            <button type="button" class="sb-btn sm" data-sb-copy="${esc(shot.id)}" ${disabled ? 'disabled' : ''}>复制提示词</button>
          </div>`
    : `<div class="sb-prompt-box" data-sb-prompt="${esc(shot.id)}" hidden></div>`;
  return `
    <div class="sb-row" data-shot-id="${esc(shot.id)}">
      <div class="sb-cell sb-cell-script">
        <div class="sb-row-label">片段 ${i + 1}</div>
        <textarea class="sb-segment-input" data-sb-script="${esc(shot.id)}" rows="4" ${sbState.batchGenerating ? 'disabled' : ''}>${esc(shot.scriptSegment)}</textarea>
      </div>
      <div class="sb-cell sb-cell-visual">
        <textarea class="sb-visual-input" data-sb-visual="${esc(shot.id)}" rows="4" ${disabled ? 'disabled' : ''}
          placeholder="画面描述：镜头、主体、动作、氛围…">${esc(shot.visualDesc || '')}</textarea>
        <div class="sb-row-actions">
          <button type="button" class="sb-btn sm" data-sb-regen="${esc(shot.id)}" ${disabled ? 'disabled' : ''}>${busy ? '生成中…' : '重新生成'}</button>
          <button type="button" class="sb-btn sm primary" data-sb-confirm="${esc(shot.id)}" ${disabled ? 'disabled' : ''}>
            ${busy ? '处理中…' : shot.confirmed ? '重新确认' : '确认画面'}
          </button>
        </div>
        ${promptBlock}
      </div>
    </div>`;
}

function renderShotRows() {
  const el = document.getElementById('sbRows');
  if (!el) return;

  if (!sbState.shots.length) {
    el.innerHTML = '<p class="sb-empty">填入逐字稿后点击「生成分镜稿」，将按片段生成画面描述</p>';
    return;
  }

  el.innerHTML = sbState.shots.map((shot, i) => renderSingleShotRow(shot, i)).join('');
}

function updateShotRow(id) {
  const i = sbState.shots.findIndex((s) => s.id === id);
  const shot = sbState.shots[i];
  const row = document.querySelector(`.sb-row[data-shot-id="${CSS.escape(id)}"]`);
  if (i < 0 || !shot || !row) return;
  row.outerHTML = renderSingleShotRow(shot, i);
}

function updateShotPromptBlock(id) {
  const shot = sbState.shots.find((s) => s.id === id);
  const box = document.querySelector(`[data-sb-prompt="${CSS.escape(id)}"]`);
  if (!shot || !box) return;
  if (!shot.imagePrompt) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="sb-prompt-label">GPT Image 提示词${shot.confirmed ? ' ✓' : ''}</div>
    <textarea class="sb-prompt-text" readonly rows="3">${esc(shot.imagePrompt)}</textarea>
    <button type="button" class="sb-btn sm" data-sb-copy="${esc(shot.id)}">复制提示词</button>`;
}

function setBatchGenerating(on) {
  sbState.batchGenerating = on;
  const btn = document.getElementById('sbGenerateBtn');
  if (btn) {
    btn.disabled = on;
    btn.textContent = on ? '生成中…' : '生成分镜稿';
  }
  renderShotRows();
}

function setShotBusy(id, on) {
  sbState.busyShotId = on ? id : null;
  updateShotRow(id);
}

async function generateAllStoryboards() {
  syncScriptFromInput();
  const segments = splitScriptSegments(sbState.scriptText);
  if (!segments.length) {
    deps.showToast?.('请先填入逐字稿');
    return;
  }
  if (!deps.callMetaJson) {
    deps.showToast?.('请先配置 API Key');
    return;
  }

  setBatchGenerating(true);
  try {
    const lines = segments.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
    const parsed = await deps.callMetaJson(
      `为每段口播写视频分镜画面描述（20-45字中文：镜头景别+画面主体+动作+氛围）。返回 JSON：{"shots":[{"visual":"描述1"},...]}，数组长度必须等于 ${segments.length}。\n\n${lines}`,
    );
    const visuals = parsed.shots || [];
    sbState.shots = segments.map((seg, i) => ({
      id: crypto.randomUUID(),
      scriptSegment: seg,
      visualDesc: String(visuals[i]?.visual || visuals[i]?.description || '').trim(),
      imagePrompt: '',
      confirmed: false,
    }));
    renderShotRows();
    deps.showToast?.(`✓ 已生成 ${sbState.shots.length} 个分镜`);
  } catch (e) {
    deps.showToast?.('❌ ' + (e.message || '分镜生成失败'));
  } finally {
    setBatchGenerating(false);
  }
}

async function regenerateShot(id) {
  if (sbState.busyShotId || sbState.batchGenerating) return;
  syncShotsFromDom();
  const shot = sbState.shots.find((s) => s.id === id);
  if (!shot || !deps.callMetaJson) return;

  setShotBusy(id, true);
  try {
    const parsed = await deps.callMetaJson(
      `为以下口播片段写一条视频分镜画面描述（20-45字中文）。返回 JSON：{"visual":"..."}\n\n片段：${shot.scriptSegment}`,
    );
    shot.visualDesc = String(parsed.visual || parsed.description || '').trim();
    shot.confirmed = false;
    shot.imagePrompt = '';
    deps.showToast?.('✓ 已重新生成该分镜');
  } catch (e) {
    deps.showToast?.('❌ ' + (e.message || '重新生成失败'));
  } finally {
    sbState.busyShotId = null;
    updateShotRow(id);
  }
}

async function confirmShotVisual(id) {
  if (sbState.busyShotId || sbState.batchGenerating) return;
  syncShotsFromDom();
  const shot = sbState.shots.find((s) => s.id === id);
  if (!shot?.visualDesc?.trim()) {
    deps.showToast?.('请先填写或生成画面描述');
    return;
  }
  if (!deps.callMetaJson) return;

  setShotBusy(id, true);
  try {
    const parsed = await deps.callMetaJson(
      `将以下分镜画面描述整理为 GPT Image（gpt-image-1）可用的中文绘图提示词。要求：只输出中文；写清镜头景别、画面主体、动作、环境、构图、光线、色彩、画面风格；不要出现对白、字幕、水印、英文词或解释说明；80-160 个中文字。返回 JSON：{"prompt":"中文提示词"}\n\n口播片段：${shot.scriptSegment}\n画面描述：${shot.visualDesc}`,
    );
    shot.imagePrompt = String(parsed.prompt || '').trim();
    shot.confirmed = !!shot.imagePrompt;
    deps.showToast?.(shot.imagePrompt ? '✓ 已生成 GPT Image 提示词' : '提示词生成失败');
  } catch (e) {
    deps.showToast?.('❌ ' + (e.message || '提示词生成失败'));
  } finally {
    sbState.busyShotId = null;
    updateShotRow(id);
  }
}

async function copyImagePrompt(id) {
  const shot = sbState.shots.find((s) => s.id === id);
  if (!shot?.imagePrompt) return;
  try {
    await navigator.clipboard.writeText(shot.imagePrompt);
    deps.showToast?.('✓ 已复制提示词');
  } catch {
    deps.showToast?.('复制失败，请手动选择复制');
  }
}

export function resetStoryboardPanel() {
  sbState.scriptText = '';
  sbState.shots = [];
  sbState.batchGenerating = false;
  sbState.busyShotId = null;
  const ta = document.getElementById('sbScriptInput');
  if (ta) ta.value = '';
  updateScriptCount();
  renderShotRows();
  setBatchGenerating(false);
}

export function initStoryboardPanel(api) {
  deps = api;
  renderStoryboardShell();
}
