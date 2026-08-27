import { proxyTo } from '../../_lib/proxy.js';

// /api/openrouter/*  →  https://openrouter.ai/*
export const onRequest = ({ request }) =>
  proxyTo(request, '/api/openrouter', 'https://openrouter.ai');
