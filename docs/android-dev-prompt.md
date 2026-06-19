# Android App Development Prompt: Gmail Bulk Reader

## 1. プロジェクト概要

既存のGmail一括既読サーバー（Hono + Supabase + Gmail API）と連携するAndroidアプリを開発したい。
このアプリの主な目的は、ユーザーがGoogleログインを行い、ワンタップで未読メールをすべて既読にすることである。

## 2. 参照するバックエンド仕様

バックエンド（TypeScript/Hono）には以下のエンドポイントが実装されている：

- `POST /v1/auth/callback`: Google OAuthの認可コードを受け取り、Supabaseにトークンを保存（暗号化あり）。
- `POST /v1/gmail/read-all`: 指定された `user_id` の未読メールをGmail API経由で取得し、一括既読化する。
- `POST /v1/auth/logout`: `user_id` に紐づくトークン情報を削除する。

## 3. アプリの要件

### 技術スタック

- 言語: Kotlin
- UI: Jetpack Compose
- ネットワーク: Retrofit2 or Ktor
- 認証: Google Sign-In SDK (Android), Supabase Auth Kotlin SDK

### 主要機能

1. **Google認証画面**:
   - Googleアカウントでサインインし、サーバー側の `/v1/auth/callback` に認可コードを送信する。
2. **メイン画面**:
   - ログインユーザー情報の表示。
   - 「すべての未読メールを既読にする」ボタン。
   - 実行中のプログレス表示と、処理完了後の既読件数表示。
3. **設定・ログアウト**:
   - サーバー側の `/v1/auth/logout` を呼び出し、ローカルのセッションを破棄する。

## 4. 実装のステップ（依頼事項）

以下のステップに沿って、コードの実装案を提示してください。

1. **依存関係の設定**: `build.gradle.kts` に必要なライブラリ（Google Sign-In, Supabase, Retrofit等）を追加する。
2. **データモデルの定義**: バックエンドの `types.ts` に合わせたリクエスト/レスポンス用のデータクラス作成。
3. **APIインターフェース**: Retrofitを用いたバックエンドAPIとの通信定義。
4. **認証ロジック**: Google Sign-Inの結果から `serverAuthCode` を取得し、バックエンドへ送信する一連の流れ。
5. **UI実装**: Jetpack Composeを用いたシンプルでモダンなUI（Material 3）。

## 5. バックエンドのソースコード（コンテキスト）

※ここに `src/index.ts`, `src/types.ts`, `src/crypto.ts` の内容を添付、または読み込ませて開発を開始してください。

---

### Geminiへの指示

「上記プロジェクト概要とバックエンドの仕様を理解しましたか？理解できたら、まずステップ1の `build.gradle.kts` の設定と、プロジェクトのディレクトリ構造の提案から始めてください。」
