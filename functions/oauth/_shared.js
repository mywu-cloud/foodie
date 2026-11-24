/**
 * /admin「Sign In with GitHub」的 OAuth 共用函式（Cloudflare Pages Functions，跟網站同網域，不需另外部署 Worker）
 *
 * 需要在 Cloudflare Pages 專案 → Settings → Variables and Secrets（Production）設定：
 *   GITHUB_CLIENT_ID      GitHub OAuth App 的 Client ID
 *   GITHUB_CLIENT_SECRET  （Secret）GitHub OAuth App 的 Client secret
 * GitHub OAuth App 的 Authorization callback URL 設為 https://twfood.pages.dev/oauth/callback
 *
 * 流程（Sveltia / Decap CMS 的標準 popup 協定）：
 *   /admin 開 popup → /oauth/auth → GitHub 授權頁 → /oauth/callback 換 token
 *   → 以 postMessage 傳回「同網域」的 /admin 視窗。token 不經過任何第三方伺服器。
 * 能不能存檔由 GitHub 決定：只有對 repo 有寫入權限的帳號才寫得進去。
 */
export const STATE_COOKIE = 'cms_oauth_state';

export const html = (body, status = 200, headers = {}) =>
  new Response(
    `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>登入</title></head><body>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } },
  );

/** 把結果傳回開啟這個 popup 的 /admin 視窗（只送給同網域）。 */
export const reply = (origin, status, content) => {
  const message = `authorization:github:${status}:${JSON.stringify(content)}`;
  return html(
    `<p>${status === 'success' ? '登入成功，視窗即將關閉…' : '登入失敗：' + escapeHtml(content.error ?? '')}</p>
<script>
(() => {
  const origin = ${JSON.stringify(origin)};
  const message = ${JSON.stringify(message)};
  window.addEventListener('message', (e) => {
    if (e.origin !== origin || e.data !== 'authorizing:github') return;
    window.opener && window.opener.postMessage(message, origin);
  }, { once: true });
  window.opener && window.opener.postMessage('authorizing:github', origin);
})();
</script>`,
    200,
    { 'set-cookie': `${STATE_COOKIE}=; Path=/oauth; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
  );
};

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const readCookie = (request, name) => {
  const m = (request.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
};
