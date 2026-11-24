/** GET /oauth/auth —— 導向 GitHub 授權頁（說明見 ./_shared.js） */
import { STATE_COOKIE, reply } from './_shared.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return reply(url.origin, 'error', { error: '尚未設定 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET，請先用 Token 登入' });
  }
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/oauth/callback`,
    scope: 'public_repo,user:email',
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://github.com/login/oauth/authorize?${params}`,
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  });
}
