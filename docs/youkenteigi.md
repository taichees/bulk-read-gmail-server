仕様書を基に、Gmailの一括既読アプリの「サーバーサイド（バックエンド）のソースコード」を実装してください。
Cloudflare Workers環境（V8ランタイム）で動作するため、Google公式ライブラリは使用せず、標準の `fetch` APIを用いてGoogle OAuthおよびGmail APIと通信するコードにしてください。

### 1. 技術スタック
- サーバー: Cloudflare Workers (TypeScript / Honoフレームワーク)
- データベース: Supabase (PostgreSQL、接続には `@node-postgres/keys` や `postgres` などのWorkers互換ドライバ、またはSupabaseのData API/Prisma Accelerateなどを想定。実装しやすい方法でOK)
- 認証・API通信: 標準の `fetch` APIを使用（Google公式ライブラリは使用禁止）

### 2. 実装が必要な機能・要件

#### ① データベース設計 
ユーザーごとのOAuth認証情報を保存するテーブルのSQL（またはスキーマ）を作成してください。
- 保持データ: user_id (主キー), access_token, refresh_token, expiry_date
- 【セキュリティ】refresh_token は、Web Crypto API（`crypto.subtle`）などを用いて、データベース保存時に暗号化（AES-GCMなど）し、読み込み時に複合するロジックを組み込んでください。

#### ② OAuth認証・コールバック用API (POST /v1/auth/callback)
- フロントエンドから送られてくる「認可コード（Authorization Code）」を受け取る。
- `fetch` を使って `https://oauth2.googleapis.com/token` にリクエストを送り、`access_token` と `refresh_token` を取得する。
- 取得した情報を上記データベースに保存（更新）する。

#### ③ 一括既読処理API (POST /v1/gmail/read-all)
- 【パラメータ】`limit` (件数、オプショナル)
- 【ロジック】
  1. DBから該当ユーザーの `refresh_token` を取得。期限切れ（または毎回安全のため）、`fetch` で新しい `access_token` を生成。
  2. `fetch` で Gmail API (`https://gmail.googleapis.com/v1/users/me/messages`) を叩き、条件 `q=is:unread` で未読メールのID一覧を取得する。
  3. パラメータ `limit` が指定されている場合（無料版想定）：最大 `limit` 件分（50件など）だけIDを抽出する。
  4. パラメータ `limit` がない場合（有料版想定）：未読が0になるまでページネーション（`nextPageToken`を使用）しながらループ処理でIDをすべて取得する。
  5. Gmail API (`.../messages/batchModify`) を使い、取得したメッセージID群に対して `removeLabelIds: ["UNREAD"]` を適用し、一括既読化する。
  ※注意: `batchModify` は1リクエスト最大1,000件までの制限があるため、1,000件を超える場合は分割してリクエストを送信するループ処理を実装してください。

#### ④ アカウント初期化（ログアウト）API (POST /v1/auth/logout)
- 指定されたユーザーのOAuth認証情報（アクセストークン、リフレッシュトークンなど）をデータベースから完全に削除する。

### 3. 出力形式
- ディレクトリ構成（`wrangler.toml` の設定例含む）
- 各機能のソースコード（コメントを詳しく入れてください）