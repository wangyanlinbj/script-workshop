import { proxyTo } from '../../_lib/proxy.js';

// /api/openai/*  →  https://api.openai.com/*
export const onRequest = ({ request }) =>
  proxyTo(request, '/api/openai', 'https://api.openai.com');
