/**
 * 选题搜索（Cloudflare Pages Functions 版）
 *
 * 由 server/topicSearchHandler.js 移植而来：把 Node http/https 改为原生 fetch，
 * 去掉本地代理 agent（Cloudflare 边缘节点直接出网）。
 *
 * 注意：Cloudflare 边缘节点分布全球，抓取国内站点（科普中国/果壳/B站）
 * 可能因地域或反爬而不稳定；OpenAlex/Crossref/维基等由独立代理路由处理。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQ_TIMEOUT_MS = 6000;
const TASK_TIMEOUT_DOMESTIC = 7000;
const TASK_TIMEOUT_FOREIGN = 9000;
const OVERALL_TIMEOUT_MS = 22000;

function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// base64url（替代 Node 的 Buffer.from(x).toString('base64url')）
function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function headersForHost(hostname) {
  const base = { 'user-agent': UA, accept: 'text/html,application/json,*/*' };
  if (hostname.includes('bilibili.com')) {
    return { ...base, referer: 'https://search.bilibili.com', origin: 'https://search.bilibili.com' };
  }
  if (hostname.includes('guokr.com')) return { ...base, referer: 'https://www.guokr.com/' };
  if (hostname.includes('kepuchina.cn')) return { ...base, referer: 'https://www.kepuchina.cn/' };
  if (hostname.includes('bing.com')) {
    return { ...base, referer: 'https://www.bing.com/', 'accept-language': 'en-US,en;q=0.9' };
  }
  if (hostname.includes('popsci.com') || hostname.includes('sciencealert.com') || hostname.includes('scientificamerican.com')) {
    return { ...base, referer: `https://www.${hostname}/`, 'accept-language': 'en-US,en;q=0.9' };
  }
  return base;
}

async function fetchText(url, opts = {}) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw e;
  }
  const hostHeaders = headersForHost(target.hostname);
  const headers = {
    ...hostHeaders,
    ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(target.href, {
      method: opts.method || 'GET',
      headers,
      body: opts.postBody || undefined,
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status || 0, body };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const { status, body } = await fetchText(url);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  return JSON.parse(body);
}

function decodeDdgUrl(href) {
  if (!href) return '';
  if (href.includes('uddg=')) {
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      return decodeURIComponent(u.searchParams.get('uddg') || href);
    } catch {
      return href;
    }
  }
  return href;
}

function parseMetric(text) {
  const s = String(text || '');
  const m =
    s.match(/([\d,.]+)\s*万?\s*(?:次)?(?:阅读|浏览|播放|观看|views?|plays?|likes?|点赞|收藏)/i) ||
    s.match(/(?:阅读|播放|观看)\s*[：:]?\s*([\d,.]+)\s*万?/i);
  if (!m) return 0;
  let n = parseFloat(String(m[1]).replace(/,/g, ''));
  if (Number.isNaN(n)) return 0;
  if (/万/.test(m[0])) n *= 10000;
  return Math.round(n);
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function siteLabel(url) {
  const h = hostFromUrl(url);
  const map = {
    'kepuchina.cn': '科普中国',
    'guokr.com': '果壳',
    'popsci.com': 'Popular Science',
    'sciencealert.com': 'ScienceAlert',
    'scientificamerican.com': 'Scientific American',
    'bilibili.com': 'Bilibili 知识区',
  };
  return map[h] || h;
}

function isDomesticSource(sourceUrl) {
  const host = hostFromUrl(sourceUrl);
  return host.includes('bilibili.com') || host.includes('guokr.com') || host.includes('kepuchina.cn');
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function searchBilibili(keyword, page) {
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&order=click`;
  const json = await fetchJson(url);
  if (json?.code !== 0) throw new Error(`bilibili code ${json?.code}`);
  const list = json?.data?.result || [];
  return list.map((item, idx) => ({
    title: stripHtml(item.title || item.name || '无标题'),
    url: item.arcurl || (item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : ''),
    snippet: stripHtml(item.description || item.desc || item.author || ''),
    metric: Number(item.play) || 0,
    metricLabel: '播放',
    rank: idx + 1,
    publishedAt: item.pubdate ? new Date(item.pubdate * 1000).toISOString().slice(0, 10) : '',
  })).filter((i) => i.url && i.title);
}

async function searchDdgSite(domain, keyword) {
  const q = encodeURIComponent(`site:${domain} ${keyword}`);
  let body = '';
  try {
    ({ body } = await fetchText(`https://html.duckduckgo.com/html/?q=${q}`));
  } catch {
    try {
      ({ body } = await fetchText('https://html.duckduckgo.com/html/', {
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        postBody: `q=${q}&b=`,
      }));
    } catch {
      return [];
    }
  }
  const items = [];
  const patterns = [
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a/gi,
    /class="[^"]*result[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) && items.length < 10) {
      const url = decodeDdgUrl(m[1]);
      if (!url || !url.includes(domain)) continue;
      const title = stripHtml(m[2]);
      const snippet = stripHtml(m[3] || '');
      if (!title || title.length < 4) continue;
      items.push({
        title, url, snippet,
        metric: parseMetric(`${title} ${snippet}`),
        metricLabel: parseMetric(`${title} ${snippet}`) ? '互动' : '',
        rank: items.length + 1,
        publishedAt: '',
      });
    }
    if (items.length) break;
  }
  return items;
}

function hasChinese(text) {
  return /[一-鿿]/.test(String(text || ''));
}

async function translateZhToEn(text) {
  const raw = String(text || '').trim().slice(0, 200);
  if (!raw || !hasChinese(raw)) return raw;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(raw)}&langpair=zh-CN|en`;
    const json = await fetchJson(url);
    const translated = String(json?.responseData?.translatedText || '').trim();
    if (translated && !hasChinese(translated) && translated.toLowerCase() !== raw.toLowerCase()) {
      return translated;
    }
  } catch { /* ignore */ }
  return raw;
}

function parseAnchors(html, domain, pathRe) {
  const items = [];
  const seen = new Set();
  const domainEsc = domain.replace(/\./g, '\\.');
  const re = new RegExp(
    `<a[^>]+href="(https?:\\/\\/(?:www\\.)?${domainEsc}[^"]+)"[^>]*>([\\s\\S]*?)<\\/a>`,
    'gi',
  );
  let m;
  while ((m = re.exec(html)) && items.length < 12) {
    const url = m[1].split('#')[0];
    if (seen.has(url)) continue;
    try {
      const u = new URL(url);
      if (pathRe && !pathRe.test(u.pathname)) continue;
      if (/\/(search|tag|category|author|page|wp-|feed|rss|login)/i.test(u.pathname)) continue;
    } catch {
      continue;
    }
    const title = stripHtml(m[2]);
    if (!title || title.length < 8 || title.length > 200) continue;
    if (/^(read more|subscribe|sign in|next|previous)$/i.test(title)) continue;
    seen.add(url);
    items.push({ title, url, snippet: '', metric: 0, metricLabel: '', rank: items.length + 1, publishedAt: '' });
  }
  return items;
}

async function searchPopsci(keyword) {
  const urls = [
    `https://www.popsci.com/search/?s=${encodeURIComponent(keyword)}`,
    `https://www.popsci.com/?s=${encodeURIComponent(keyword)}`,
  ];
  for (const url of urls) {
    try {
      const { body } = await fetchText(url);
      const items = parseAnchors(body, 'popsci.com', /\/(story|science|technology|health|diy|environment|gadgets|space)\//i);
      if (items.length) return items;
    } catch { /* next */ }
  }
  return [];
}

async function searchScienceAlert(keyword) {
  const urls = [
    `https://www.sciencealert.com/search/${encodeURIComponent(keyword)}`,
    `https://www.sciencealert.com/?s=${encodeURIComponent(keyword)}`,
  ];
  for (const url of urls) {
    try {
      const { body } = await fetchText(url);
      const items = parseAnchors(body, 'sciencealert.com', /^\/[a-z0-9][a-z0-9-]+\/?$/i);
      if (items.length) return items;
    } catch { /* next */ }
  }
  return [];
}

async function searchSciam(keyword) {
  const urls = [
    `https://www.scientificamerican.com/search/?q=${encodeURIComponent(keyword)}`,
    `https://www.scientificamerican.com/?s=${encodeURIComponent(keyword)}`,
  ];
  for (const url of urls) {
    try {
      const { body } = await fetchText(url);
      const items = parseAnchors(body, 'scientificamerican.com', /\/(article|podcast|video|blog|news)\//i);
      if (items.length) return items;
    } catch { /* next */ }
  }
  return [];
}

function pushForeignItem(items, url, titleHtml, domain, seen) {
  const urlClean = decodeDdgUrl(url).split('#')[0];
  if (!urlClean.includes(domain) || seen.has(urlClean)) return;
  const title = stripHtml(titleHtml);
  if (!title || title.length < 8) return;
  if (/\/(search|tag|category|login|subscribe)/i.test(urlClean)) return;
  seen.add(urlClean);
  items.push({ title, url: urlClean, snippet: '', metric: 0, metricLabel: '', rank: items.length + 1, publishedAt: '' });
}

async function searchBingSite(domain, keyword) {
  const q = encodeURIComponent(`site:${domain} ${keyword}`);
  const url = `https://www.bing.com/search?q=${q}&count=20&setlang=en-US`;
  const { body } = await fetchText(url);
  const items = [];
  const seen = new Set();
  const reAlgo = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = reAlgo.exec(body)) && items.length < 10) {
    pushForeignItem(items, m[1], m[2], domain, seen);
  }
  if (items.length) return items;
  const reLink = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reLink.exec(body)) && items.length < 10) {
    if (!m[1].includes(domain)) continue;
    pushForeignItem(items, m[1], m[2], domain, seen);
  }
  return items;
}

async function searchForeign(host, keyword) {
  const directMap = {
    'popsci.com': searchPopsci,
    'sciencealert.com': searchScienceAlert,
    'scientificamerican.com': searchSciam,
  };
  const directFn = directMap[host];
  if (directFn) {
    try {
      const items = await directFn(keyword);
      if (items.length) return items;
    } catch { /* fall through */ }
  }
  try {
    const items = await searchBingSite(host, keyword);
    if (items.length) return items;
  } catch { /* fall through */ }
  return searchDdgSite(host, keyword);
}

async function searchGuokr(keyword, page) {
  const urls = [
    `https://www.guokr.com/search/article/?wd=${encodeURIComponent(keyword)}&page=${page}`,
    `https://www.guokr.com/search/all/?wd=${encodeURIComponent(keyword)}&page=${page}`,
  ];
  let body = '';
  for (const url of urls) {
    try {
      ({ body } = await fetchText(url));
      if (body && body.includes('/article/')) break;
    } catch { /* try next */ }
  }
  if (!body) return [];
  const items = [];
  const seen = new Set();
  const patterns = [
    /<a[^>]+href="(https?:\/\/www\.guokr\.com\/article\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/article\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) && items.length < 10) {
      const path = m[1];
      const title = stripHtml(m[2]);
      if (!title || title.length < 4) continue;
      const fullUrl = path.startsWith('http') ? path : `https://www.guokr.com${path}`;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);
      items.push({ title, url: fullUrl, snippet: '', metric: 0, metricLabel: '', rank: items.length + 1, publishedAt: '' });
    }
  }
  return items;
}

async function searchKepuchina(keyword) {
  const url = `https://www.kepuchina.cn/search?keyword=${encodeURIComponent(keyword)}`;
  const { body } = await fetchText(url);
  const items = [];
  const seen = new Set();
  const patterns = [
    /<a[^>]+href="(https?:\/\/www\.kepuchina\.cn\/(?:km|article|content|science)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/(?:km|article|content)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) && items.length < 10) {
      const path = m[1];
      const title = stripHtml(m[2]);
      if (!title || title.length < 6) continue;
      if (/首页|登录|注册|关于|联系我们/.test(title)) continue;
      const fullUrl = path.startsWith('http') ? path : `https://www.kepuchina.cn${path}`;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);
      items.push({ title, url: fullUrl, snippet: '', metric: 0, metricLabel: '', rank: items.length + 1, publishedAt: '' });
    }
  }
  return items;
}

async function searchSource(sourceUrl, keyword, page) {
  const host = hostFromUrl(sourceUrl);
  try {
    if (host.includes('bilibili.com')) return searchBilibili(keyword, page);
    if (host.includes('guokr.com')) return searchGuokr(keyword, page);
    if (host.includes('kepuchina.cn')) return searchKepuchina(keyword);
    return searchForeign(host, keyword);
  } catch {
    return [];
  }
}

function inDateRange(publishedAt, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true;
  if (!publishedAt) return true;
  if (dateFrom && publishedAt < dateFrom) return false;
  if (dateTo && publishedAt > dateTo) return false;
  return true;
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url.split('#')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByQuality(items) {
  return [...items].sort((a, b) => {
    const aPlay = a.metric > 0 ? a.metric : 0;
    const bPlay = b.metric > 0 ? b.metric : 0;
    if (aPlay !== bPlay) return bPlay - aPlay;
    return (a.rank || 999) - (b.rank || 999);
  });
}

function diversifyBySource(items, limit) {
  const buckets = new Map();
  for (const item of items) {
    const key = item.sourceName || 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const keys = [...buckets.keys()];
  const out = [];
  let round = 0;
  while (out.length < limit && keys.some((k) => buckets.get(k).length > round)) {
    for (const k of keys) {
      const list = buckets.get(k);
      if (list[round]) out.push(list[round]);
      if (out.length >= limit) break;
    }
    round += 1;
  }
  return out;
}

async function collectFromSources(sources, keywordsZh, keywordsEn, page) {
  const tasks = [];
  for (const src of sources) {
    const kws = isDomesticSource(src.url) ? keywordsZh : keywordsEn.length ? keywordsEn : keywordsZh;
    const kw = kws[0];
    if (!kw) continue;
    tasks.push({ src, kw, foreign: !isDomesticSource(src.url) });
  }

  const settled = await Promise.allSettled(
    tasks.map(({ src, kw, foreign }) =>
      withTimeout(
        searchSource(src.url, kw, page),
        foreign ? TASK_TIMEOUT_FOREIGN : TASK_TIMEOUT_DOMESTIC,
      ).catch(() => []),
    ),
  );

  const collected = [];
  settled.forEach((result, i) => {
    const { src, kw } = tasks[i];
    const batch = result.status === 'fulfilled' ? result.value : [];
    batch.forEach((item) => {
      collected.push({
        ...item,
        id: `${hostFromUrl(src.url)}_${b64url(item.url).slice(0, 16)}`,
        sourceUrl: src.url,
        sourceName: siteLabel(src.url),
        keyword: kw,
      });
    });
  });
  return collected;
}

async function doHandleTopicSearch(body) {
  const keyword = String(body.keyword || '').trim();
  if (!keyword) throw new Error('请输入搜索关键词');

  const sources = Array.isArray(body.sources) ? body.sources.filter((s) => s && s.url && s.enabled !== false) : [];
  if (sources.length === 0) throw new Error('请至少保留一个信源');

  const related = Array.isArray(body.related) ? body.related.map(String).filter(Boolean) : [];
  const keywordsZh = [keyword, ...related.filter((k) => k !== keyword)].slice(0, 1);

  const keywordEnRaw = String(body.keywordEn || '').trim();
  let keywordEn = keywordEnRaw;
  if (!keywordEn || hasChinese(keywordEn)) {
    keywordEn = await translateZhToEn(keywordEn || keyword);
  }
  const relatedEn = Array.isArray(body.relatedEn) ? body.relatedEn.map(String).filter(Boolean) : [];
  let relatedEnResolved = relatedEn[0] || '';
  if (relatedEnResolved && hasChinese(relatedEnResolved)) {
    relatedEnResolved = await translateZhToEn(relatedEnResolved);
  }
  const keywordsEn =
    keywordEn && !hasChinese(keywordEn)
      ? [keywordEn, ...[relatedEnResolved].filter((k) => k && k !== keywordEn && !hasChinese(k))].slice(0, 1)
      : hasChinese(keyword) ? [] : [keyword];

  const page = Math.max(1, Number(body.page) || 1);
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(30, Math.max(1, Number(body.limit) || 20));
  const dateFrom = body.dateFrom || '';
  const dateTo = body.dateTo || '';
  const excludeUrlSet = new Set(
    (Array.isArray(body.excludeUrls) ? body.excludeUrls : []).map(String).filter(Boolean),
  );

  const collected = await collectFromSources(sources, keywordsZh, keywordsEn, page);

  let filtered = dedupeByUrl(collected).filter((i) => inDateRange(i.publishedAt, dateFrom, dateTo));
  filtered = sortByQuality(filtered);
  if (excludeUrlSet.size) {
    filtered = filtered.filter((i) => i.url && !excludeUrlSet.has(i.url));
  }
  const poolSize = Math.min(filtered.length, limit + offset + excludeUrlSet.size + limit);
  filtered = diversifyBySource(filtered, poolSize);

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  const sourceStats = {};
  collected.forEach((i) => {
    sourceStats[i.sourceName] = (sourceStats[i.sourceName] || 0) + 1;
  });

  return {
    items,
    total,
    offset,
    limit,
    hasMore: offset + limit < total,
    page,
    keywords: keywordsZh,
    keywordsEn,
    englishQuery: keywordsEn[0] || '',
    sourceStats,
    partial: collected.length === 0 && sources.length > 0,
  };
}

export async function handleTopicSearch(body) {
  try {
    return await withTimeout(doHandleTopicSearch(body), OVERALL_TIMEOUT_MS, 'timeout');
  } catch (err) {
    if (String(err?.message || err).includes('timeout')) {
      throw new Error('搜索超时：请减少信源数量，或关闭部分国外站点后重试');
    }
    throw err;
  }
}
