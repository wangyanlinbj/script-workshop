import { proxyTo } from '../../_lib/proxy.js';

// /api/deepseek/*  →  https://api.deepseek.com/*
export const onRequest = ({ request }) =>
  proxyTo(request, '/api/deepseek', 'https://api.deepseek.com');
