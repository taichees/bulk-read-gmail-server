import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from './crypto';
import { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

// Supabaseクライアント初期化
const getSupabase = (env: Bindings) => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * ② OAuth認証・コールバック
 */
app.post('/v1/auth/callback', async (c) => {
  const { code, user_id } = await c.req.json();
  const env = c.env;

  // Google Token APIにリクエスト
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: 'postmessage', // フロントエンドの実装に合わせる
    }),
  });

  const tokens = await tokenRes.json() as any;
  if (!tokenRes.ok) {
    console.error('Google Auth Error:', tokens);
    return c.json({ error: tokens.error_description || tokens.error || 'Failed to fetch tokens' }, 400);
  }

  // refresh_tokenの暗号化
  const encryptedRT = await encrypt(tokens.refresh_token, env.ENCRYPTION_KEY);

  // DB保存
  const { error } = await getSupabase(env).from('user_tokens').upsert({
    user_id,
    access_token: tokens.access_token,
    refresh_token: encryptedRT,
    expiry_date: Date.now() + tokens.expires_in * 1000,
  });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

/**
 * ③ 一括既読処理API
 */
app.post('/v1/gmail/read-all', async (c) => {
  const { user_id, limit } = await c.req.json();
  const env = c.env;
  const supabase = getSupabase(env);

  // 1. DBから情報を取得
  const { data: user, error: dbError } = await supabase
    .from('user_tokens')
    .select('*')
    .eq('user_id', user_id)
    .single();

  if (dbError || !user) return c.json({ error: 'User not found' }, 404);

  // 2. access_tokenの更新
  const decryptedRT = await decrypt(user.refresh_token, env.ENCRYPTION_KEY);
  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: decryptedRT,
      grant_type: 'refresh_token',
    }),
  });

  const newTokens: any = await refreshRes.json();
  if (!refreshRes.ok) {
    console.error('Token Refresh Error:', newTokens);
    return c.json({ error: 'Failed to refresh access token' }, 401);
  }
  const accessToken = newTokens.access_token;

  // 3 & 4. 未読メールIDの取得 (Pagination対応)
  let allMessageIds: string[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const listParams = new URLSearchParams({
      q: 'is:unread',
      maxResults: '500',
    });
    if (pageToken) listParams.append('pageToken', pageToken);

    const listRes = await fetch(`https://gmail.googleapis.com/v1/users/me/messages?${listParams.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const listData: any = await listRes.json();
    if (listData.messages) {
      allMessageIds.push(...listData.messages.map((m: any) => m.id));
    }

    // limitがある場合は制限
    if (limit && allMessageIds.length >= limit) {
      allMessageIds = allMessageIds.slice(0, limit);
      break;
    }

    pageToken = listData.nextPageToken;
  } while (pageToken);

  if (allMessageIds.length === 0) {
    return c.json({ message: 'No unread messages' });
  }

  // 5. batchModify (1,000件ずつ分割してリクエスト)
  const chunkSize = 1000;
  for (let i = 0; i < allMessageIds.length; i += chunkSize) {
    const chunk = allMessageIds.slice(i, i + chunkSize);
    await fetch('https://gmail.googleapis.com/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: chunk,
        removeLabelIds: ['UNREAD'],
      }),
    });
  }

  return c.json({
    success: true,
    processed_count: allMessageIds.length,
  });
});

/**
 * ④ アカウント初期化（ログアウト）
 */
app.post('/v1/auth/logout', async (c) => {
  const { user_id } = await c.req.json();
  const supabase = getSupabase(c.env);

  const { error } = await supabase
    .from('user_tokens')
    .delete()
    .eq('user_id', user_id);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

export default app;