import { handleTopicSearch } from '../_lib/topicSearch.js';

// /api/topic-search  —  选题搜索（等价于本地 vite 的 topicSearchPlugin）
export const onRequest = async ({ request }) => {
  if (request.method !== 'POST') {
    return new Response('topic-search 仅支持 POST', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await handleTopicSearch(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return new Response(err?.message || String(err), {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
};
