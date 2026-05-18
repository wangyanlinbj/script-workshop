/**
 * 信源检索：用真实 API（OpenAlex / Crossref / 维基百科）返回可点击链接，
 * 避免大模型直接编造 URL。
 */

async function safeFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`检索接口 HTTP ${res.status}`);
  return res.json();
}

export async function extractSourceQueries(sentence, scriptSnippet, callStream) {
  const sys = `你是学术检索助手。只输出合法 JSON，不要 markdown 代码块或其它说明。
格式：{"points":[{"topic":"知识点中文名","queries":["english search query"]}]}
规则：最多 3 个 points，每个 1～2 个 queries；queries 用英文关键词便于学术库检索。`;
  const prompt = `脚本语境（节选）：\n${scriptSnippet}\n\n待分析句子：\n${sentence}`;
  let raw = '';
  await callStream(prompt, sys, t => { raw += t; });
  try {
    const j = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (Array.isArray(j.points) && j.points.length) {
      return j.points.map(p => ({
        topic: String(p.topic || '相关主题').trim(),
        queries: (Array.isArray(p.queries) ? p.queries : [])
          .map(q => String(q).trim())
          .filter(Boolean)
          .slice(0, 2),
      })).filter(p => p.queries.length).slice(0, 3);
    }
  } catch { /* fallback below */ }
  const fallback = sentence.replace(/\s+/g, ' ').trim().slice(0, 120);
  return [{ topic: '相关主题', queries: [fallback || 'science'] }];
}

export async function searchOpenAlex(query, limit = 3) {
  try {
    const url = `/api/openalex/works?search=${encodeURIComponent(query)}&per_page=${limit}`;
    const data = await safeFetchJson(url);
    return (data.results || []).map(w => {
      const doi = w.doi ? String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : '';
      const link = doi
        ? `https://doi.org/${doi}`
        : (w.best_oa_location?.landing_page_url || w.primary_location?.landing_page_url || w.id || '');
      const author = w.authorships?.[0]?.author?.display_name;
      const meta = [w.publication_year, author, w.host_venue?.display_name].filter(Boolean).join(' · ');
      return {
        type: '学术论文（OpenAlex）',
        title: w.display_name || '未知标题',
        meta,
        url: link,
        query,
        topicKey: query,
      };
    }).filter(s => s.url && /^https?:\/\//i.test(s.url));
  } catch {
    return [];
  }
}

export async function searchCrossref(query, limit = 2) {
  try {
    const url = `/api/crossref/works?query=${encodeURIComponent(query)}&rows=${limit}`;
    const data = await safeFetchJson(url);
    return (data.message?.items || []).map(item => {
      const doi = item.DOI;
      const title = Array.isArray(item.title) ? item.title[0] : item.title;
      const year = item.issued?.['date-parts']?.[0]?.[0];
      const author = item.author?.[0];
      const authorName = author ? `${author.given || ''} ${author.family || ''}`.trim() : '';
      return {
        type: '学术论文（Crossref）',
        title: title || '未知标题',
        meta: [year, authorName, item['container-title']?.[0]].filter(Boolean).join(' · '),
        url: doi ? `https://doi.org/${doi}` : (item.URL || ''),
        query,
        topicKey: query,
      };
    }).filter(s => s.url && /^https?:\/\//i.test(s.url));
  } catch {
    return [];
  }
}

export async function searchWikipediaZh(query, limit = 2) {
  try {
    const api = `/api/wiki-zh/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit}&namespace=0&format=json&origin=*`;
    const data = await safeFetchJson(api);
    const titles = data[1] || [];
    return titles.map(title => ({
      type: '百科条目（维基百科）',
      title,
      meta: '中文百科 · 适合背景概念',
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      query,
      topicKey: query,
    }));
  } catch {
    return [];
  }
}

function dedupeSources(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.url.split('#')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function formatGroundedSourceMarkdown(sentence, points, sources) {
  const lines = [
    '以下链接来自 OpenAlex / Crossref / 维基百科 的真实检索结果，不是模型编造的网址。',
    '请自行点开核实是否与你的句子一致；检索结果未必完全覆盖视频口播表述。',
    '',
    `**待查证句子：** ${sentence}`,
    '',
  ];

  for (const point of points) {
    lines.push(`### ${point.topic}`);
    const matched = sources.filter(s => point.queries.some(q => s.topicKey === q || s.query === q));
    const list = matched.length ? matched : sources.slice(0, 2);
    if (!list.length) {
      lines.push('- （未检索到链接，建议在 [Google Scholar](https://scholar.google.com) 或 [PubMed](https://pubmed.ncbi.nlm.nih.gov) 手动搜索：' + point.queries.join(' / ') + '）');
      continue;
    }
    for (const s of list) {
      lines.push(`- [${s.title}](${s.url}) — ${s.type}${s.meta ? ' · ' + s.meta : ''}`);
    }
    lines.push('');
  }

  const used = new Set();
  const extra = sources.filter(s => {
    if (used.has(s.url)) return false;
    used.add(s.url);
    return !points.some(p => p.queries.includes(s.query));
  });
  if (extra.length) {
    lines.push('### 其它相关检索结果');
    for (const s of extra.slice(0, 4)) {
      lines.push(`- [${s.title}](${s.url}) — ${s.type}${s.meta ? ' · ' + s.meta : ''}`);
    }
  }

  return lines.join('\n').trim();
}

/**
 * @param {{ sentence: string, script: string, onProgress?: (msg: string) => void, callStream: Function }} opts
 */
export async function fetchGroundedSources({ sentence, script, onProgress, callStream }) {
  const progress = msg => { onProgress?.(msg); };

  progress('① 分析句子，生成检索关键词…\n');
  const points = await extractSourceQueries(sentence, script.slice(0, 800), callStream);
  progress(`已识别 ${points.length} 个知识点，正在检索数据库…\n\n`);

  const all = [];
  for (const point of points) {
    for (const query of point.queries) {
      progress(`检索中：${point.topic} · ${query}\n`);
      const [oa, cr, wiki] = await Promise.all([
        searchOpenAlex(query, 2),
        searchCrossref(query, 1),
        searchWikipediaZh(query, 1),
      ]);
      for (const s of [...oa, ...cr, ...wiki]) {
        s.topicKey = query;
        all.push(s);
      }
    }
  }

  const sources = dedupeSources(all).slice(0, 12);
  const content = formatGroundedSourceMarkdown(sentence, points, sources);
  return { content, points, sources };
}
