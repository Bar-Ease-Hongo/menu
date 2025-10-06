# Bar Ease Hongo メニュー配信システム

Google スプレッドシートを唯一の管理画面として扱い、Apps Script と AWS サーバーレス基盤で承認フロー付きのメニュー JSON を生成し、Next.js でモバイル向け一覧・詳細 UI を提供するモノレポです。承認から 5 分以内の公開反映を目標に、AI による入力補完と Webhook 自動処理を組み合わせています。

## アーキテクチャ概要
- Google スプレッドシート + Apps Script: メニュー入力、承認ワークフロー、Webhook 連携
- AWS API Gateway + Lambda (`services/lambda/menu`): GAS 署名検証、画像ステージング → 本番コピー、`menu.json` 再生成
- AWS DynamoDB (`sheet#menu` パーティション): シート内容の同期データを保存
- Amazon Bedrock Claude 3 Haiku: 欠損値の AI 補完候補を生成
- AWS S3: `menu.json` / `makers.json` / 画像アセットのホスティング
- Next.js 14 (App Router): モバイル最適化された閲覧/検索フロントエンド

## リポジトリ構成
```
├── apps/frontend           # Next.js 14 フロントエンド (App Router)
│   ├── app                 # ページ / API ルート
│   ├── components          # UI コンポーネント
│   └── lib                 # データ取得ロジック
├── services
│   ├── lambda/menu         # menu.json 生成・Webhook 受信用 Lambda 群
│   └── lambda/recommend    # おすすめ API 用 Lambda
├── infra                   # SST Ion (v3) による IaC
├── gas                     # 旧 onEdit スクリプト（参考）
├── packages/core           # 共有 TypeScript 型定義
└── data/fixtures           # ローカル開発用サンプルデータ
```

## 開発環境の準備
- Node.js 20.16.0 (`.nvmrc` を参照) ※ Lambda ランタイムと合わせる
- pnpm 9.12.3（`corepack enable` で有効化すると自動で切り替わります）
- AWS CLI v2 + AWS SSO 設定（`aws configure sso` による `barease-dev` / `barease-prod` プロファイル）
- (任意) `direnv` / `asdf` 等で `.env` の切り替えを自動化

## 依存パッケージのインストール
```bash
corepack enable
pnpm install
```

## 環境変数
ルートの `.env.example` を参考に `.env` を作成し、少なくとも以下を設定します。

- `SHEET_ID` : メニュー管理シートの ID
- `GAS_WEBHOOK_SECRET` : GAS ⇔ Lambda 共通の HMAC シークレット
- `GAS_WEBHOOK_ENDPOINT` : API Gateway の `/webhook` エンドポイント URL
- `AWS_REGION`, `MENU_BUCKET_NAME`, `PUBLIC_IMAGE_BUCKET_NAME`, `STAGING_IMAGE_BUCKET_NAME`
- `BEDROCK_MODEL_CLAUDE`, `BEDROCK_MODEL_EMBEDDING`
- `NEXT_PUBLIC_MENU_JSON_URL`, `NEXT_PUBLIC_MAKERS_JSON_URL`, `NEXT_PUBLIC_RECOMMEND_API`

`GAS_WEBHOOK_SECRET` と `GAS_WEBHOOK_ENDPOINT` は後述の Apps Script のスクリプト プロパティとも同じ値を利用します。

## ローカル開発
```bash
pnpm dev
```

- ルートの `dev` スクリプトから `@bar-ease/frontend` の Next.js 開発サーバを起動します。
- `NEXT_PUBLIC_MENU_JSON_URL` が未指定の場合、`data/fixtures/menu.sample.json` がフォールバックで読み込まれます。

## Lambda / バックエンド
### `services/lambda/menu`
- `nightlyCompletionHandler`: DynamoDB から未承認行を抽出し Claude Haiku による補完案を生成（現状はログ出力まで。DynamoDB への書き戻しは TODO）。
- `generateMenuHandler`: DynamoDB (`pk = sheet#menu`) の行を読み込み、`status === "Published"` かつ `approveFlag === "Approved"` のレコードのみを抽出して `menu.json` を S3 に PUT。
- `webhookHandler`: GAS からの HMAC 署名付きリクエストを検証し、ステージング画像を本番バケットへコピー後 `generateMenuHandler` を実行します。

### `services/lambda/recommend`
- Amazon Titan Embeddings でベクトル化 → `embeddings.json` (S3) とコサイン類似度でランキング。
- メーカー / カテゴリ / 度数帯 / 価格帯によるフィルタリングに対応。
- レスポンス形式: `{ items: [{ id, name, maker, score, reason }] }`。

## インフラ (SST Ion)
- `infra/sst.config.ts` で API Gateway, DynamoDB, S3 バケット 3 種, Lambda 群, Next.js サイト、`GasWebhookSecret` などを定義。
- ローカルから Ion を起動する場合:

  ```bash
  pnpm dev:sst:dev   # dev 環境でのホットリロード
  pnpm deploy:sst:dev
  pnpm deploy:sst:prod
  pnpm remove:sst:dev
  ```

- `deploy` / `dev` 時の出力で `ApiUrl`, `MenuBucket`, `FrontendUrl` などの値が確認できます。

## Google スプレッドシート連携
スプレッドシート側の初期設定と承認フローの自動化は Apps Script で行います。以下の手順で構築してください。

### 1. Apps Script プロジェクト作成
1. メニュー管理用スプレッドシートを開き、`拡張機能 > Apps Script` を選択。
2. デフォルトの `Code.gs` を削除し、新規ファイル `menu.gs` を作成。
3. 後述のスクリプトを貼り付けて保存します。

### 2. スクリプト プロパティの設定
Apps Script エディタ右上の歯車アイコン → `プロジェクトの設定` → `スクリプト プロパティ` から以下を登録します。

- `WEBHOOK_SECRET`
  1. GAS と Lambda で共有する 32 文字以上のランダム文字列を生成（例: `openssl rand -hex 32`）。
  2. 生成した値を 1Password 等に保管し、`pnpm exec sst secrets set GasWebhookSecret <value> --stage <stage>` で対象ステージに登録。
  3. `.env` の `GAS_WEBHOOK_SECRET` とスクリプト プロパティ `WEBHOOK_SECRET` に同じ値を貼り付けます。
  4. 既存値を確認したい場合は `pnpm exec sst secrets value GasWebhookSecret --stage <stage>` を使用。

- `WEBHOOK_URL`
  1. `pnpm deploy:sst:<stage>` 実行後の出力、または `pnpm --filter @bar-ease/infra exec sst outputs --stage <stage>` で `ApiUrl` を取得。
  2. `WEBHOOK_URL = <ApiUrl>/webhook` の形式で設定（例: `https://xxxx.execute-api.ap-northeast-1.amazonaws.com/webhook`）。
  3. 同じ URL を `.env` の `GAS_WEBHOOK_ENDPOINT` にも設定します。

### 3. 初回セットアップの実行
1. Apps Script エディタで `setupMenuSheet` を選択して実行。
2. 初回実行時に表示される認可ダイアログで [続行] → Google アカウント選択 → [許可] を行います。
3. スプレッドシート 1 行目に以下のヘッダが追加され、ID 採番・データ検証・保護が適用されます。
   - `ID`, `公開状態`, `メーカー`, `メーカー（スラッグ）`, `カテゴリ`, `タグ`, `説明文`, `AI候補説明文`, `AI候補画像URL`, `公開画像URL`, `AIステータス`, `承認フラグ`, `承認者`, `承認日時`, `更新日時`
4. `承認フラグ` 列には `-, 承認, 却下` のプルダウンが付与されます。

### 4. トリガーの設定（onEdit ではなくインストール型）
onEdit（単純トリガー）は認可が不要な範囲でのみ動作するため、`UrlFetchApp` などの認可が必要な処理は失敗します。本プロジェクトでは承認時に Webhook を叩くため、インストール型トリガーで `handleSheetEdit` を実行してください。

手順（Apps Script エディタ上）
- 左メニューの時計アイコン「トリガー」を開く → 「トリガーを追加」
- 実行する関数を `handleSheetEdit` に設定
- イベントのソースを `スプレッドシートから` に設定
- イベントの種類を `編集時` に設定
- 失敗通知は任意（推奨: すぐに通知）
- 保存後、初回のみ認可ダイアログが表示されるので、Google アカウントを選択し権限を許可

補足
- インストール型トリガーは「実行ユーザー」の権限で動作するため、`UrlFetchApp`・`PropertiesService` などの認可が必要なサービスを利用できます。
- 既に `onEdit(e)` を残している場合は競合しないよう削除または未使用のままで問題ありません（本番は `handleSheetEdit` のみに統一）。
- トリガーはスプレッドシートにバインドされたプロジェクトで作成してください（スタンドアロンでは `e.source` の取得や対象シートの特定で混乱しやすい）。

### 5. スクリプト本体
本リポジトリの `gas/onEdit.gs` が最新実装です。Apps Script 側の `menu.gs`（任意のファイル名で可）に、`gas/onEdit.gs` の内容をそのまま貼り付けてください。

- ファイルパス: `gas/onEdit.gs`
- 列名・カラム運用は当該ファイルの実装に合わせてスプレッドシートを整備してください。

### 6. 動作確認のポイント
- `承認フラグ` を `承認` に変更すると、`公開画像URL` の値を Webhook 通知の `publicKey` として送信します（空欄の場合は空文字）。
- Lambda 側で 2xx 応答が返らない場合、Apps Script の実行ログに HTTP ステータスとレスポンス本文が記録されます。
- 画像キーを `public/ITEM0001.jpg` のように事前に決めておくと、Web フロントエンド側での参照が一貫します。
- ステージング画像のキー（`AI候補画像URL`）が未入力の場合はコピーをスキップし、`menu.json` の再生成のみ実行されます。

## 運用メモ
- `nightlyCompletionHandler` は EventBridge Scheduler で 1 日 1 回以上起動させ、欠損補完ログを確認する想定です。
- 画像は常にステージングバケットに保存し、承認時に `public` バケットへコピーして公開します。
- `menu.json` には `Cache-Control: max-age=60, s-maxage=300` を設定しており、CloudFront との組み合わせでおおむね 5 分以内に反映されます。

## 参考コマンド
```bash
pnpm dev                         # Next.js 開発サーバ
pnpm build:frontend              # フロントエンド本番ビルド
pnpm deploy:sst:dev              # インフラ（dev ステージ）デプロイ
pnpm format                      # Prettier による整形
pnpm aws-login                   # AWS SSO ログイン補助
```

## 今後のタスク候補
- DynamoDB への AI 補完結果の書き戻し実装
- Claude リランキング（Top-K 再スコアリング）
- メーカー別 QR アクセス `/menu?maker=` の QR コード自動生成
- E2E テスト（Playwright）による UI 品質担保
