# 依頼：Gmail一括既読アプリ - トークン管理のクライアントサイド移行

## 1. 目的

セキュリティ向上とサーバーサイドのステートレス化のため、これまでサーバーサイドで保持していた各種トークン（OAuthアクセストークン、リフレッシュトークンなど）を、クライアントサイド（Android/iOS）の安全なストレージで保持・管理する方式に変更します。

## 2. 対象リポジトリ

- サーバーサイド: https://github.com/taichees/bulk-read-gmail-server
- Android: https://github.com/taichees/BulkReadGmailAndroid
- iOS: https://github.com/taichees/BulkReadGmailForiOS

## 3. 実装のステップ

### ステップ 1: クライアントサイドでの安全なトークン保存

- **Android**: `EncryptedSharedPreferences` または暗号化を有効にした `DataStore` を使用し、取得したトークンを安全にローカル保存する処理を実装してください。
- **iOS**: `Keychain`（またはそれをラップしたSwift製ライブラリ）を使用して、トークンをセキュアに保存・取得する処理を実装してください。

### ステップ 2: サーバーサイドAPI（Cloudflare Workers）の修正

- 各エンドポイントで、リクエストヘッダー（例: `Authorization: Bearer <Token>`）からGmail API用のトークンを直接受け取るように変更してください。
- サーバー側（Supabase等）のDBでアクセストークンを永続保持・管理するロジックがある場合は削除、またはオプトアウトしてください。

### ステップ 3: クライアントからのAPIコール修正

- クライアントからCloudflare Workersへリクエストを送信する際、ローカルの安全なストレージから読み出したトークンをヘッダーに付与して通信するよう修正してください。

## 4. 出力要求

- 各プラットフォーム（Kotlin / Swift / TypeScript）の修正が必要なファイル名。
- 具体的なコードの差分（Diffまたは新規コード）。
