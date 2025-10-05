# Bar Ease Hongo メニュー配信システム

Google スプレッドシートを単一のデータソースとして、AI 補完・承認フロー付きでメニュー (`menu.json`) を生成し、Next.js でモバイルファーストな閲覧体験を提供するプロジェクトです。AWS（S3 / CloudFront / Lambda / Bedrock）と Google Apps Script を連携させ、承認後5分以内の反映を目指します。

## ディレクトリ構成

```
├── apps/frontend           # Next.js 14（App Router）フロントエンド
│   ├── app                 # ページ / API ルート
│   ├── components          # UI コンポーネント
│   └── lib                 # データ取得ロジック
├── services
│   ├── lambda/menu         # menu.json 生成・Webhook 受信 Lambda
│   └── lambda/recommend    # おすすめ API 用 Lambda
├── infra                   # SST v3 (CDK) による IaC
├── gas                     # Google Apps Script (onEdit)
├── packages/core           # 共有 TypeScript 型定義
└── data/fixtures           # ローカル開発用サンプルデータ
```

## 開発環境セットアップ

1. **Node.js**: `.nvmrc` のバージョン（18.19.0）を使用してください。
2. **依存インストール** (`npm` ワークスペース採用):

   ```bash
   npm install
   ```

3. **環境変数**: `.env.example` を参考に `.env` を作成し、最低限以下を設定します。

   - `SHEET_ID` スプレッドシート ID
   - `GAS_WEBHOOK_SECRET` Webhook 署名用シークレット
   - `AWS_REGION`, `MENU_BUCKET_NAME` などの AWS リソース識別子
   - フロントエンド用 `NEXT_PUBLIC_*` URL

4. **ローカル開発**:

   ```bash
   npm run dev --workspace @bar-ease/frontend
   ```

   `NEXT_PUBLIC_MENU_JSON_URL` が未設定の場合、`data/fixtures/menu.sample.json` を自動的に読み込みます。

## フロントエンド (Next.js 14)

- スマホ前提の黒 × 金 × 白デザイン。
- `/menu` 一覧 + フィルタリング / `/menu/[id]` 詳細 / `/recommend` レコメンドフォームを実装。
- `/api/recommend` は本番 API が未接続でも簡易スコアリングで動作するフォールバックを同梱。
- S3 上の `menu.json` / `makers.json` を取得し、承認済み商品のみ表示。

## Lambda 群

### services/lambda/menu

- **`nightlyCompletionHandler`**: 欠損行を検出し Claude 3 Haiku にプロンプト送信。AI 補完候補を DynamoDB へ書き戻す想定（サンプルではログ出力）。
- **`generateMenuHandler`**: DynamoDB のシート同期テーブルを走査し、`Published + Approved` のみを抽出して `menu.json` を S3 に出力。
- **`webhookHandler`**: GAS からの HMAC 署名リクエストを検証し、画像の `staging → public` コピーと `menu.json` 再生成を行う。
- HMAC 署名検証、度数/価格帯のクラス分類、タグ正規化などの補助関数を実装。

### services/lambda/recommend

- Titan Embeddings で問い合わせテキストをベクトル化し、`embeddings.json`（S3）とコサイン類似度でランキング。
- `filters` で絞り込み（メーカー / カテゴリ / 度数帯 / 価格帯）。
- レスポンスは `{ items: [{ id, score, name, maker, reason }] }` 形式。

## GAS (gas/onEdit.gs)

- `approveFlag` 列が `Approved` になった時だけ発火。
- 署名付きで API Gateway (`/webhook`) に通知し、承認者情報・承認日時・`aiStatus` を行に書き戻します。
- スクリプトプロパティに `WEBHOOK_URL`, `WEBHOOK_SECRET` を設定してください。

## インフラ (infra)

SST v3 + CDK で以下を定義します。

- メニュー/ステージング/公開用 S3 バケット
- Google シート同期用 DynamoDB テーブル
- `generateMenu`, `webhook`, `recommend` Lambda
- `/recommend`, `/webhook` を提供する API Gateway
- Next.js フロントエンド (NextjsSite) を CloudFront デプロイ

### デプロイ手順

1. AWS 認証情報を設定（例: `aws sso login`）。
2. 必要な環境変数を `sst-env.d.ts` または `.env` に設定。
3. 初回デプロイ:

   ```bash
   npm run deploy --workspace @bar-ease/infra
   ```

4. デプロイ後の出力に `ApiEndpoint`, `FrontendUrl`, `MenuBucket` が表示されます。

5. CloudFront キャッシュ無効化は `menu.json` への更新時のみ（Lambda 内で `CacheControl` を短めに設定）。

## Google Apps Script 設定

1. Apps Script プロジェクトをシートと紐付け、`gas/onEdit.gs` を貼り付け。
2. スクリプトプロパティに以下を設定:

   - `WEBHOOK_URL` … API Gateway `/webhook` エンドポイント
   - `WEBHOOK_SECRET` … 環境変数と同じシークレット

3. トリガー: `onEdit`（単純トリガー）で保存。承認列のデータ検証（Approved / Rejected / -）も忘れずに。

## 追加の運用ポイント

- `nightlyCompletionHandler` を EventBridge Scheduler で 1時間おきに実行し、欠損行を自動補完。
- ベクトル更新バッチ（Titan Embeddings）は別 Lambda / Step Functions で日次更新を推奨。
- 画像は常に `staging` に保存 → 承認後に `public` へコピーして公開。
- `menu.json` は `max-age=60` としており、CloudFront 側の TTL も合わせて 5 分以内の反映が可能です。

## コマンド一覧

```bash
npm run dev --workspace @bar-ease/frontend    # Next.js 開発サーバ
npm run build --workspace @bar-ease/frontend  # フロントエンド本番ビルド
npm run deploy --workspace @bar-ease/infra    # SST デプロイ
npm run format                                 # Prettier による整形
```

## 今後のタスク候補

- DynamoDB への AI 補完結果の書き戻し実装
- Claude リランキング（Top-K 再スコアリング）
- メーカー別 QR アクセス `/menu?maker=` の QR コード自動生成
- E2E テスト（Playwright）による UI 品質担保
