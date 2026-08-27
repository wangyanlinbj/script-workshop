import { proxyTo } from '../../_lib/proxy.js';

// /api/wiki-zh/*  →  https://zh.wikipedia.org/*  （信源查证：中文维基百科）
export const onRequest = ({ request }) =>
  proxyTo(request, '/api/wiki-zh', 'https://zh.wikipedia.org');
