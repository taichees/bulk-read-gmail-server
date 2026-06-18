import { Hono } from 'hono';
import { html } from 'hono/html';
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from './crypto';
import { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

// Supabaseクライアント初期化
const getSupabase = (env: Bindings) =>
  createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * ② OAuth認証・コールバック
 */
app.post('/v1/auth/callback', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { code, user_id } = body;
  const env = c.env;

  // 環境変数の検証
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.ENCRYPTION_KEY) {
    console.error('Missing environment variables:', {
      GOOGLE_CLIENT_ID: !!env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!env.GOOGLE_CLIENT_SECRET,
      ENCRYPTION_KEY: !!env.ENCRYPTION_KEY,
    });
    return c.json({ error: 'Server configuration error' }, 500);
  }

  // Google Token APIにリクエスト
  const redirectUri = env.REDIRECT_URI || 'http://localhost:5173';

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  const tokens: any = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error('Google Auth Error:', {
      status: tokenRes.status,
      details: tokens,
    });
    // Googleからのエラー内容を詳細に返すように変更
    return c.json({ error: 'Google Auth Failed', google_error: tokens }, 400);
  }

  // Googleは初回認証時（またはprompt=consent時）のみrefresh_tokenを返すため、
  // 存在する場合のみ暗号化して更新データに含める。
  const upsertData: any = {
    user_id,
    access_token: tokens.access_token,
    expiry_date: Date.now() + tokens.expires_in * 1000,
  };

  if (tokens.refresh_token) {
    upsertData.refresh_token = await encrypt(tokens.refresh_token, env.ENCRYPTION_KEY);
  } else {
    console.log(
      `No new refresh_token provided for user ${user_id}. Keeping existing one if it exists.`
    );
  }

  // DB保存
  const { error: upsertError } = await getSupabase(env).from('user_tokens').upsert(upsertData);

  if (upsertError) return c.json({ error: upsertError.message }, 500);
  return c.json({ success: true });
});

/**
 * ③ 一括既読処理API
 */
app.post('/v1/gmail/read-all', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { user_id, limit } = body;
  const env = c.env;
  const supabase = getSupabase(env);

  // 1. DBから情報を取得
  const { data: user, error: dbError } = await supabase
    .from('user_tokens')
    .select('*')
    .eq('user_id', user_id)
    .single();

  if (dbError || !user) return c.json({ error: 'User not found' }, 404);

  // refresh_tokenがDBに存在するかチェック
  if (!user.refresh_token) {
    return c.json({ error: 'Refresh token is missing. Please re-authenticate.' }, 401);
  }

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

    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams.toString()}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!listRes.ok) {
      const errorText = await listRes.text();
      console.error('Gmail List API Error:', { status: listRes.status, body: errorText });
      return c.json(
        { error: 'Failed to fetch messages from Gmail', details: errorText },
        listRes.status
      );
    }

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
    return c.json({
      success: true,
      processed_count: 0,
      message: 'No unread messages',
    });
  }

  // 5. batchModify (1,000件ずつ分割してリクエスト)
  const chunkSize = 1000;
  for (let i = 0; i < allMessageIds.length; i += chunkSize) {
    const chunk = allMessageIds.slice(i, i + chunkSize);
    const batchRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ids: chunk,
          removeLabelIds: ['UNREAD'],
        }),
      }
    );

    if (!batchRes.ok) {
      const errorText = await batchRes.text();
      console.error('Gmail BatchModify Error:', errorText);
    }
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

  const { error } = await supabase.from('user_tokens').delete().eq('user_id', user_id);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

/**
 * ⑤ プライバシーポリシー（Google審査用）
 */
app.get('/privacy', (c) => {
  return c.html(
    html`<!DOCTYPE html>
      <html lang="ja">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>プライバシーポリシー - Gmail一括既読アプリ</title>
          <style>
            body {
              font-family:
                -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
                sans-serif;
              line-height: 1.6;
              max-width: 800px;
              margin: 40px auto;
              padding: 0 20px;
              color: #333;
              background-color: #f4f7f9;
            }
            .container {
              background: #fff;
              padding: 40px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
            }
            h1 {
              color: #222;
              border-bottom: 2px solid #eee;
              padding-bottom: 10px;
              font-size: 1.8em;
            }
            h2 {
              color: #444;
              margin-top: 30px;
              font-size: 1.4em;
            }
            p,
            li {
              margin-bottom: 15px;
            }
            ul {
              padding-left: 20px;
            }
            .footer {
              margin-top: 50px;
              font-size: 0.9em;
              color: #777;
              border-top: 1px solid #eee;
              padding-top: 20px;
            }
            .contact-box {
              background: #f0f4f8;
              padding: 15px;
              border-left: 4px solid #007aff;
              margin-top: 20px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>プライバシーポリシー</h1>
            <p>
              「Gmail一括既読アプリ」（以下「本アプリ」）は、ユーザーのプライバシーを尊重し、個人データの保護に厳重に努めています。本ポリシーは、本アプリがGoogle
              APIから取得するデータの取り扱いについて説明するものです。
            </p>

            <h2>1. 取得するデータと利用目的</h2>
            <p>本アプリは、Google OAuth認証を通じて以下のスコープ（権限）を利用します：</p>
            <ul>
              <li><strong>https://www.googleapis.com/auth/gmail.modify</strong></li>
            </ul>
            <p>
              この権限は、ユーザーの指示に基づき、Gmailの未読メールを検索し、それらを「既読」状態にする（UNREADラベルを削除する）という<strong>特定の機能を提供するためだけに</strong>使用されます。本アプリがメールの閲覧、作成、送信、または削除を行うことはありません。
            </p>

            <h2>2. データの保護と管理</h2>
            <ul>
              <li>
                <strong>データの非蓄積:</strong>
                本アプリは、ユーザーのメール本文、件名、連絡先リスト、その他の個人データを外部サーバーに収集・蓄積・送信することはありません。処理はメモリ上でのみ行われ、完了後に破棄されます。
              </li>
              <li>
                <strong>認証情報の保護:</strong>
                認証に使用されるリフレッシュトークンは、データベースに保存される際、AES-GCMなどの標準的な暗号化技術を用いて暗号化され、不正アクセスから保護されます。
              </li>
              <li>
                <strong>第三者への共有:</strong>
                本アプリがユーザーのデータを第三者に販売、共有、または広告目的で利用することは一切ありません。
              </li>
            </ul>

            <h2>3. データの削除</h2>
            <p>
              ユーザーはアプリ内の「ログアウト」または「アカウント解除」機能を利用することで、サーバー上の認証情報をいつでも完全に削除することができます。
            </p>

            <h2>4. お問い合わせ</h2>
            <p>
              本ポリシーに関するご質問や、データの取り扱いに関するお問い合わせは、下記までご連絡ください。
            </p>
            <div class="contact-box">
              <strong>連絡先:</strong>
              <a href="mailto:system@tsushinryo.com">system@tsushinryo.com</a>
            </div>

            <div class="footer">
              <p>更新日: 2026年6月18日</p>
              <p>&copy; 2026 Gmail一括既読アプリ</p>
            </div>
          </div>
        </body>
      </html>`
  );
});

export default app;
