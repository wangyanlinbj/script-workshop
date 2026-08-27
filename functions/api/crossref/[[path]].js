import { proxyTo } from '../../_lib/proxy.js';

// /api/crossref/*  →  https://api.crossref.org/*  （信源查证：学术论文）
export const onRequest = ({ request }) =>
  proxyTo(request, '/api/crossref', 'https://api.crossref.org');
