/** GET /oauth/callback —— 用 GitHub 回傳的 code 換 access token，交回 /admin（說明見 ./_shared.js） */
import { STATE_COOKIE, readCookie, reply } from './_shared.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = readCookie(request, STATE_COOKIE);

  if (!code || !state || !saved || state !== saved) {
    return reply(url.origin, 'error', { error: '登入驗證失敗（state 不符或逾時），請重新登入' });
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return reply(url.origin, 'error', { error: '尚未設定 GitHub OAuth' });
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'twfood-cms-auth' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/oauth/callback`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    return reply(url.origin, 'error', { error: data.error_description || data.error || 'GitHub 沒有回傳 token' });
  }
  return reply(url.origin, 'success', { provider: 'github', token: data.access_token });
}
