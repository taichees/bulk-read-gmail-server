import { Hono } from 'hono';
import { html } from 'hono/html';
import { streamText } from 'hono/streaming';
import { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

// Supabaseクライアント初期化は不要になりました

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

  const { code, user_id, client_id, redirect_uri } = body;
  const env = c.env;

  // 環境変数の検証
  const targetClientId = client_id || env.GOOGLE_CLIENT_ID;
  const targetRedirectUri = redirect_uri || env.REDIRECT_URI || 'http://localhost:5173';

  if (!targetClientId) {
    console.error('Missing environment variables or parameters: targetClientId');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  // Google Token APIにリクエスト用のパラメータを構築
  const params: Record<string, string> = {
    code,
    client_id: targetClientId,
    grant_type: 'authorization_code',
    redirect_uri: targetRedirectUri,
  };

  // デフォルトのGOOGLE_CLIENT_IDと同じ場合（かつシークレットがある場合）のみclient_secretを付与
  if (targetClientId === env.GOOGLE_CLIENT_ID) {
    if (!env.GOOGLE_CLIENT_SECRET) {
      console.error('Missing GOOGLE_CLIENT_SECRET for confidential client exchange');
      return c.json({ error: 'Server configuration error' }, 500);
    }
    params.client_secret = env.GOOGLE_CLIENT_SECRET;
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

  const tokens: any = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error('Google Auth Error:', {
      status: tokenRes.status,
      details: tokens,
    });
    return c.json({ error: 'Google Auth Failed', google_error: tokens }, 400);
  }

  // user_id がない場合は Google Userinfo API からメールアドレスを取得
  let finalUserId = user_id;
  if (!finalUserId) {
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (userInfoRes.ok) {
      const userInfo: any = await userInfoRes.json();
      finalUserId = userInfo.email;
    } else {
      console.error('Failed to fetch userinfo from Google');
      return c.json({ error: 'Failed to fetch user info from Google' }, 400);
    }
  }

  if (!finalUserId) {
    return c.json({ error: 'user_id is missing and could not be retrieved from Google' }, 400);
  }

  return c.json({
    success: true,
    user_id: finalUserId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
  });
});

/**
 * ③ 一括既読処理API
 */
app.post('/v1/gmail/read-all', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    body = {};
  }

  const { limit, stream } = body;

  // Authorizationヘッダーからアクセストークンを取得
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid token' }, 401);
  }
  const accessToken = authHeader.substring(7).trim();

  if (!accessToken) {
    return c.json({ error: 'Unauthorized: Empty token' }, 401);
  }

  if (stream) {
    return streamText(c, async (writer) => {
      // 3 & 4. 未読メールIDの取得 (Pagination対応)
      let allMessageIds: string[] = [];
      let pageToken: string | undefined = undefined;

      try {
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
            await writer.writeln(
              JSON.stringify({
                type: 'error',
                error: 'Failed to fetch messages from Gmail',
                details: errorText,
              })
            );
            return;
          }

          const listData: any = await listRes.json();
          if (listData.messages) {
            allMessageIds.push(...listData.messages.map((m: any) => m.id));
          }

          if (limit && allMessageIds.length >= limit) {
            allMessageIds = allMessageIds.slice(0, limit);
            break;
          }

          pageToken = listData.nextPageToken;
        } while (pageToken);

        await writer.writeln(JSON.stringify({ type: 'count', total: allMessageIds.length }));

        if (allMessageIds.length === 0) {
          await writer.writeln(
            JSON.stringify({ type: 'result', success: true, processed_count: 0 })
          );
          return;
        }

        const chunkSize = 1000;
        let completed = 0;
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
          } else {
            completed += chunk.length;
          }
          await writer.writeln(JSON.stringify({ type: 'progress', completed }));
        }

        await writer.writeln(
          JSON.stringify({ type: 'result', success: true, processed_count: completed })
        );
      } catch (err: any) {
        await writer.writeln(JSON.stringify({ type: 'error', error: err.message }));
      }
    });
  } else {
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

    const chunkSize = 1000;
    let completed = 0;
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
      } else {
        completed += chunk.length;
      }
    }

    return c.json({
      success: true,
      processed_count: completed,
    });
  }
});

/**
 * ④ アカウント初期化（ログアウト）
 */
app.post('/v1/auth/logout', async (c) => {
  // クライアントサイド移行に伴い、サーバー側でのログアウト処理（DB削除）は不要になりました。
  // 互換性維持のため、常に成功を返します。
  return c.json({ success: true });
});

/**
 * ⑥ アプリ紹介ページ（ルートパス）
 */
app.get('/', (c) => {
  return c.html(
    html`<!DOCTYPE html>
      <html lang="ja">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta
            name="google-site-verification"
            content="-XAmTvUVaxJ8H_DR0BSwk5l_PxM7GiaASAqgdcD7H_0"
          />
          <title>Gmail一括既読アプリ</title>
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
              text-align: center;
            }
            h1 {
              color: #222;
              margin-bottom: 20px;
            }
            p {
              margin-bottom: 30px;
              font-size: 1.1em;
            }
            .links {
              margin-top: 20px;
              border-top: 1px solid #eee;
              padding-top: 20px;
            }
            a {
              color: #007aff;
              text-decoration: none;
            }
            a:hover {
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Gmail一括既読アプリ</h1>
            <p>
              溜まってしまったGmailの未読メールを、ワンタップで一括して「既読」にするためのシンプルで強力なツールです。
            </p>
            <div class="links">
              <a href="/privacy">プライバシーポリシー</a>
            </div>
          </div>
        </body>
      </html>`
  );
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
            h3 {
              color: #222;
              margin-top: 30px;
              font-size: 1.3em;
            }
            h4 {
              color: #444;
              margin-top: 20px;
              font-size: 1.1em;
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

            <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;" />

            <h3>
              Google APIサービスユーザーデータポリシーへの準拠について / Google API Services User
              Data Policy Compliance
            </h3>
            <p>
              当アプリ「Gmail一括既読アプリ（以下「本アプリ」）」は、ユーザーの同意のもと、Google
              APIから受信した情報を使用および他アプリへ転送します。その際、本アプリは、限定用途（Limited
              Use）の要件を含め、<a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                >Google API Services User Data Policy</a
              >に完全に準拠します。
            </p>
            <p>
              Our application "Gmail一括既読アプリ" (hereinafter referred to as "the App") uses and
              transfers information received from Google APIs to any other app in full compliance
              with the
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                >Google API Services User Data Policy</a
              >, including the Limited Use requirements.
            </p>

            <h4>データの限定用途（Limited Use）に関する誓約 / Limited Use Commitments</h4>
            <ul>
              <li>
                <strong>ユーザー機能の提供と向上:</strong> Google API（Gmail
                API）から取得したデータは、本アプリのユーザーインターフェース上で明確に提供されている機能（Gmailの一括既読化、未読件数の通知、バッジ表示など）の提供および改善の目的にのみ使用されます。<br />
                <strong>Providing and Improving User-Facing Features:</strong> Data obtained through
                Google APIs will be used solely to provide or improve user-facing features that are
                prominent in the App's user interface.
              </li>
              <li>
                <strong>広告利用の禁止:</strong>
                取得したGoogleユーザーデータを、行動ターゲティング広告、パーソナライズされた広告、または関心連動型広告を含む、いかなる広告の配信・提供のためにも使用または転送しません。<br />
                <strong>No Advertising:</strong> We do not use or transfer Google user data for
                serving advertisements, including retargeting, personalized, or interest-based
                advertising.
              </li>
              <li>
                <strong>第三者への転送・売却の禁止:</strong>
                法的義務の遵守やセキュリティ上の理由、またはユーザーが明示的に同意した機能の提供に必要な場合を除き、取得したデータを第三者に共有または売却しません。<br />
                <strong>No Data Sale or Transfer:</strong> We do not sell or transfer Google user
                data to third parties, except as necessary to provide or improve prominent
                user-facing features, comply with applicable law, or for security purposes.
              </li>
              <li>
                <strong>AI・機械学習モデルのトレーニング禁止:</strong>
                取得したGoogleユーザーデータを、一般的なAI（人工知能）や機械学習（ML）モデル、大規模言語モデル（LLM）のトレーニングや学習のために使用または転送しません。<br />
                <strong>No AI/ML Training:</strong> We do not use or transfer Google user data to
                train non-personalized artificial intelligence (AI) and/or machine learning (ML)
                models.
              </li>
              <li>
                <strong>人間によるアクセスの制限:</strong>
                セキュリティ上の理由、法的要請、または不具合調査のためにユーザーから明確な同意を得た場合を除き、人間がユーザーのGoogleデータ（メール内容など）を直接閲覧することはありません。<br />
                <strong>Human Access Restricted:</strong> We do not allow humans to read Google user
                data unless we have obtained the user's affirmative agreement for specific messages,
                for security purposes, or to comply with applicable law.
              </li>
            </ul>

            <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;" />

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
                本アプリは、ユーザーのメール本文、件名、連絡先リスト、その他の個人データを外部サーバーに収集・蓄積・送信することはありません。処理はメモリ上でのみ一時的に行われ、完了後に破棄されます。
              </li>
              <li>
                <strong>認証情報の保護:</strong>
                認証に使用されるアクセストークンやリフレッシュトークンは、サーバーのデータベース等には一切保存されません。これらの情報は、ユーザーの端末内（iOSのキーチェーンやAndroidの暗号化された保存領域）に安全に保存され、APIリクエスト時の認証のためにのみ一時的に使用されます。
              </li>
              <li>
                <strong>第三者への共有:</strong>
                本アプリがユーザーのデータを第三者に販売、共有、または広告目的で利用することは一切ありません。
              </li>
            </ul>

            <h2>3. データの削除</h2>
            <p>
              本アプリはサーバー上にユーザーの認証情報や個人データを保持しないため、アプリからログアウトするか、アプリをアンインストールすることで、端末内のすべての認証情報が完全に削除されます。
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
              <p>更新日: 2026年6月26日</p>
              <p>&copy; 2026 Gmail一括既読アプリ</p>
            </div>
          </div>
        </body>
      </html>`
  );
});

export default app;
