import { proxyTo } from '../../_lib/proxy.js';

// /api/doubao/*  →  https://ark.cn-beijing.volces.com/*
export const onRequest = ({ request }) =>
  proxyTo(request, '/api/doubao', 'https://ark.cn-beijing.volces.com');
