import { proxyTo } from '../../_lib/proxy.js';

// /api/openalex/*  →  https://api.openalex.org/*  （信源查证：学术论文）
export const onRequest = ({ request }) =>
  proxyTo(request, '/api/openalex', 'https://api.openalex.org');
