/**
 * 搜尋/篩選 API + 編輯寫入端點
 *
 * 強制規則（沿用自日本旅遊網站專案的失敗教訓）：
 * 1. 任何會寫入資料的端點（POST/PUT/DELETE）都必須驗證 API_WRITE_TOKEN，不可裸露。
 * 2. 讀取端點（GET /search）不需要驗證，公開供前端查詢用。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/search' && request.method === 'GET') {
      return handleSearch(url, env);
    }

    if (request.method !== 'GET') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!token || token !== env.API_WRITE_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      // TODO: 編輯後台寫入邏輯（新增/更新餐廳資料、調整分級）
    }

    return new Response('Not found', { status: 404 });
  },
};

async function handleSearch(url, env) {
  const region = url.searchParams.get('region');
  const category = url.searchParams.get('category');
  const tier = url.searchParams.get('tier');
  // TODO: 從資料儲存層（KV / D1）依 region × category × tier 查詢並回傳 JSON
  return Response.json({ region, category, tier, results: [] });
}
