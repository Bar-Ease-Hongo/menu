# Bar Ease Hongo メニュー配信システム

Google スプレッドシートを唯一の管理画面として扱い、Apps Script と AWS サーバーレス基盤で承認フロー付きのメニュー JSON を生成し、Next.js でモバイル向け一覧・詳細 UI を提供するモノレポです。承認から 5 分以内の公開反映を目標に、AI による入力補完と Webhook 自動処理を組み合わせています。

## アーキテクチャ概要
- Google スプレッドシート + Apps Script: メニュー入力、AI補完依頼・公開承認（ボタン方式）
- AWS API Gateway + Lambda: `/ai/request` (AI補完依頼), `/ai/result` (状態取得), `/webhook` (公開承認)
- AWS DynamoDB: source/published 分離データ、flags 管理
- Amazon Bedrock Claude 3 Haiku: AI補完（公式情報優先・欠損値のみ）
- AWS S3: `menu.json` / `embeddings.json` / 画像アセット
- Next.js 14 (App Router): モバイル最適化フロントエンド

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
- `aiRequestHandler`: AI補完依頼処理（source → AI → published 保存 → Callback通知）
- `aiResultHandler`: AI補完結果取得（flags/published 返却）
- `webhookHandler`: 公開状態・表示情報制御（公開/非公開、元情報/優先公開情報）
- `generateMenuHandler`: menu.json 生成（flags.displaySource ベースで表示情報選択）
- `nightlyCompletionHandler`: バックアップ用AI補完（aiSuggested 保存）

### `services/lambda/recommend`
- Amazon Titan Embeddings でベクトル化 → `embeddings.json` (S3) とコサイン類似度でランキング。
- メーカー / カテゴリ / 度数帯 / 価格帯によるフィルタリングに対応。
- レスポンス形式: `{ items: [{ id, name, maker, score, reason }] }`。

## インフラ (SST Ion)
- `infra/sst.config.ts` で API Gateway, DynamoDB, S3 バケット 3 種, Lambda 群, Next.js サイト、`GasWebhookSecret`、エンドポイント (`/ai/request`, `/ai/result`, `/webhook`, `/recommend`) を定義。
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

- `AI_REQUEST_URL`
  1. `pnpm deploy:sst:<stage>` 実行後の出力、または `pnpm --filter @bar-ease/infra exec sst outputs --stage <stage>` で `ApiUrl` を取得。
  2. `AI_REQUEST_URL = <ApiUrl>/ai/request` の形式で設定（例: `https://xxxx.execute-api.ap-northeast-1.amazonaws.com/ai/request`）。

- `WEBHOOK_URL`
  1. 上記 `ApiUrl` を用い、`WEBHOOK_URL = <ApiUrl>/webhook` の形式で設定します。
  2. 公開承認処理で使用されます。

- `AI_RESULT_URL`
  1. 上記 `ApiUrl` を用い、`AI_RESULT_URL = <ApiUrl>/ai/result` の形式で設定します。
  2. AI補完結果取得で使用されます。


### 3. 初回セットアップの実行
1. Apps Script エディタで `setupMenuSheet` を選択して実行。
2. 初回実行時に表示される認可ダイアログで [続行] → Google アカウント選択 → [許可] を行います。
3. スプレッドシート 1 行目に以下のヘッダが追加され、ID 採番・データ検証・保護が適用されます。
   - `ID`, `公開状態`, `メーカー`, `メーカー（スラッグ）`, `カテゴリ`, `タグ`, `説明文`, `AI候補説明文`, `AI候補画像URL`, `公開画像URL`, `AIステータス`, `承認フラグ`, `承認者`, `承認日時`, `更新日時`
4. `承認フラグ` 列には `-, 承認, 却下` のプルダウンが付与されます。

### 4. トリガーの設定（onEdit ではなくインストール型）
onEdit（単純トリガー）は認可が不要な範囲でのみ動作するため、`UrlFetchApp` などの認可が必要な処理は失敗します。本プロジェクトでは以下 2 種類のインストール型トリガーを設定してください。

手順（Apps Script エディタ上）
- 左メニューの時計アイコン「トリガー」を開く → 「トリガーを追加」
  - 実行する関数: `handleSheetEdit`
  - イベントのソース: `スプレッドシートから`
  - イベントの種類: `編集時`
  - 保存後に表示される認可ダイアログで権限を許可
- 同様にもう一つトリガーを追加し、定期同期を設定
  - 実行する関数: `scheduledSyncTrigger`
  - イベントのソース: `時間主導型`
  - イベントの種類: 任意の間隔（例: `5 分おき`）

カスタムメニュー（ボタン方式）:
- `onOpen` で「Bar Ease Hongo」メニューを作成
  - AI補完依頼（選択行）
  - 元情報で公開（選択行）
  - 優先公開情報(AI補完情報)で公開（選択行）
  - 公開取りやめ（選択行）
  - 現状強制同期（選択行）
  - 最新情報取得（全体）
- AI完了時の Callback 受信用に `doPost` を実装（Web App として公開）

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

### 関数一覧 (GAS)
| 関数 | カテゴリ | 目的 / 動作 | 呼び出し形態 / トリガー | 備考 |
|------|----------|-------------|--------------------------|------|
| `setupMenuSheet` | 初期化 | ヘッダ列追加 / ID 採番 / 検証 / 保護設定 | 初回手動 | 既存列は重複スキップ |
| `handleSheetEdit` | 編集処理 | 行編集に応じ承認/AIステータス補正 & Webhook/Sync 呼出 | インストール型編集トリガー | 認可必須 |
| `scheduledSyncTrigger` | 同期 | 全行バッチ同期 + 削除検出 | 時間主導 | フルスキャン 25件チャンク |
| `manualSync` | 同期 | 即時フル同期 | 手動 | デバッグ用途 |
| `fetchAiSuggestions({ overwrite })` | AI Pull | DynamoDB 候補を空セルへ反映 | 時間主導 | `overwrite:true` で強制上書き |
| `manualFetchAiSuggestions` | AI Pull | 候補取得手動実行 | 手動 | 初回認可確認 |
| `callSignedApi` | 署名 | POST HMAC 生成送信 | 内部 | `timestamp + '.' + body` |
| `callSignedGet` | 署名 | GET HMAC 生成送信 | 内部 | `timestamp + '.GET'` |
| `syncSheetState` | 同期内部 | upsert + 削除判定 | `scheduledSyncTrigger` | knownIds 比較 |
| `collectRowForSync` | 変換 | 行→正規化オブジェクト | 内部 | 空 ID 行除外 |
| `recordKnownId` / `getKnownIds` | 状態 | 既知 ID 管理 | 内部 | ScriptProperties 保存 |

### 署名仕様 (GET / POST)
| メソッド | 署名対象文字列 | 典型例 | 用途 |
|----------|----------------|---------|------|
| POST | `timestamp + '.' + body-json` | `1696660000000.{"action":"upsert"}` | `/webhook`, `/sync/menu` |
| GET  | `timestamp + '.GET'` | `1696660000000.GET` | `/ai/suggestions` |

計算: `sig = hex( HMAC_SHA256(payloadString, secret)).toLowerCase()` → ヘッダ `X-Timestamp`, `X-Signature`。許容時差 ±5 分。失敗時は 401 (`invalid signature`)。

### トラブルシュート (GAS / AI Pull)
| 症状 | 区分 | 原因 | 対処 |
|------|------|------|------|
| 401 invalid signature (POST) | Webhook/Sync | シークレット不一致 / 時計ずれ | シークレット再設定 / 端末時刻同期 |
| 401 invalid signature (GET) | AI Pull | `.GET` 付与漏れ | 署名文字列を `timestamp + '.GET'` へ修正 |
| 候補が更新されない | AI Pull | `AI_SUGGESTIONS_URL` 未設定 / Approved 行 | Script Properties / 行状態確認 |
| Approved 行が上書き | AI Pull | overwrite:true 誤用 | overwrite:false 運用 |
| JSON parse error | AI Pull | API 500 / 返却不正 | CloudWatch Logs 確認 |
| 削除が反映されない | Sync | `scheduledSyncTrigger` 未設定 | 時間主導トリガー追加 |
| ID 採番漏れ | 初期化 | `setupMenuSheet` 未実行 | 再実行して ID 採番 |
| 画像が公開されない | Webhook | ステージングキー空 / 承認未実施 | 候補URL入力後承認フラグ更新 |
| DynamoDB に行が無い | Sync | 単純 onEdit 使用 | インストール型編集トリガー再設定 |
| 高頻度呼び出し懸念 | AI Pull | トリガー間隔短すぎ | 15 分以上へ延長 |
| シークレット漏洩 | セキュリティ | 複数場所へ貼付 | `.env` + Script Properties に限定 |

### AI サジェスト Pull の統合運用
AI 補完候補（説明文 / 画像URL）を `GET /ai/suggestions` で取得し、シートの空セルに自動投入します。`nightlyCompletionHandler` で DynamoDB に格納された候補を **GAS が Pull** する方式です。

#### 承認フロー
1. `nightlyCompletionHandler` / 追加ロジックで DynamoDB に候補格納
2. 時間トリガーで `manualFetchAiSuggestions()` 実行 → シート空セルへ反映 (`AIステータス`: NeedsReview)
3. 人間レビュー後 `承認フラグ` = 承認 → Webhook → 画像コピー & `menu.json` / `embeddings.json` 再生成
4. CloudFront キャッシュ経由で 5 分以内にフロントへ反映

#### 運用 Tips
- 再取得強制: Apps Script コンソールで `fetchAiSuggestions({ overwrite:true })`
- Approved 行はスキップして再上書きを避ける実装
- 候補未取得時は `AIステータス` を `None` または空で維持

---

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
- makers.json 自動生成パイプライン
- Claude リランキング（Top-K 再スコアリング）
- CloudFront Invalidation 自動化
- E2E テスト（Playwright）

## 運用フロー（新仕様）

### 公開制御
- **元情報で公開**: 従来通り手入力情報でメニュー表示
- **優先公開情報(AI補完情報)で公開**: AI補完済み情報でメニュー表示
- **公開取りやめ**: メニューから除外（非公開状態）

### 状態管理
- `公開状態`: 公開/非公開（Webアプリでの表示可否）
- `表示情報`: 元情報/優先公開情報(AI補完情報)（表示内容の選択）
- 優先公開列編集時は自動で「公開状態」をクリア（再承認が必要）

## オペレーションガイド (統合)

### 1. Lambda の依存解決ポリシー
SST Ion (esbuild) によるバンドルで完結させ、`nodejs.install` は使用しません。Lambda パッケージング時の `failed to run npm install` エラー回避とデプロイ高速化が目的です。

### 2. 共通パッケージ構造
`@bar-ease/common` (`packages/common`) に Bedrock ラッパ (`invokeClaude`, `createEmbedding`, 環境ログ, allow-list, カスタムエラー) を集約し、Lambda 間でのロジック重複を排除します。新規共通処理はここに追加してください。

### 3. Bedrock 権限最小化
IAM ポリシーは使用モデル ARN のみに限定:
- Claude 3 Haiku: `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`
- Titan Embeddings v2: `bedrock:InvokeModel`
モデル ID は環境変数 (`BEDROCK_MODEL_CLAUDE`, `BEDROCK_MODEL_EMBEDDING`) で差し替え可能。ラッパ内で allow-list プレフィックス検証を行い想定外モデル使用を早期検出します。

### 4. デプロイ手順 (再掲)
```bash
pnpm install                 # 初回のみ
AWS_PROFILE=barease-dev pnpm deploy:sst:dev
AWS_PROFILE=barease-prod pnpm deploy:sst:prod
```
失敗例が `nodejs.install` 起因の場合は該当設定を除去してください。

### 5. ログ / メトリクス監視 (推奨)
CloudWatch Logs でフィルタパターンを作成:
- `[timestamp=*Z, ... "[bedrock] invokeClaude success" ...]`
- `[timestamp=*Z, ... "[bedrock] createEmbedding success" ...]`
→ メトリクス化しアラーム閾値 (例: 1 時間ゼロ件で通知) を設定。


### 7. トラブルシューティング
| 症状 | 想定原因 | 対処 |
|------|----------|------|
| `failed to run npm install` | 旧 `nodejs.install` 使用 | 該当記述削除し再デプロイ |
| Bedrock AccessDenied | ARN/リージョン不一致 | `sst.config.ts` の ARN と環境変数確認 |
| `@bar-ease/common` 型解決失敗 | exports / tsconfig 不整合 | `tsconfig.base.json` と `package.json` の `exports` を整合 |
| AI 候補が更新されない | トリガー未設定 / 署名不一致 | GAS 時間トリガー / `WEBHOOK_SECRET` を再確認 |
| Approved 行が再書き換え | overwrite=true 強制上書き | 通常は overwrite:false を使用 |

### 8. 将来最適化案
- Embedding 差分更新 (ハッシュ比較で未変更スキップ)
- `menu.json` CloudFront キャッシュ戦略チューニング (`stale-while-revalidate` 導入検討)
- 失敗リクエストの DLQ (SQS) 化
- Bedrock 呼び出しコストの Athena 分析 (CloudTrail Lake or CUR 利用)

---

---

## Bedrock モデルアクセス変更と SST v3 での権限付与

**更新日時**: 2025-10-06 16:09 (JST)

- 2025-09-29 以降、Amazon Bedrock の「モデルアクセス」ページは廃止され、**サーバーレス基盤モデルは自動有効化**。アクセス制御は **IAM / SCP** で実施します。
- 本プロジェクトでは **NightlyMenuCompletion（AI 補完）** と **Recommend（レコメンド）** の 2 関数に対し、**最小権限**で Bedrock を許可しました。
  - NightlyMenuCompletion: `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` を **Claude 3 Haiku** のモデル ARN に限定付与  
  - Recommend: `bedrock:InvokeModel` を **Titan Text Embeddings v2** のモデル ARN に限定付与
- **モデル ID / 既定値**
  - Claude 3 Haiku: `anthropic.claude-3-haiku-20240307-v1:0`
  - Titan Embeddings v2: `amazon.titan-embed-text-v2:0`
- **ARN 生成規則（東京リージョン `ap-northeast-1`）**
  - `arn:aws:bedrock:ap-northeast-1::foundation-model/<MODEL_ID>`

※ モデル差し替えは `.env` などで `BEDROCK_MODEL_CLAUDE` / `BEDROCK_MODEL_EMBEDDING` を変更するだけで可能です。

上記 Bedrock 方針は「オペレーションガイド 3. Bedrock 権限最小化」に統合されています。重複するため運用観点の最新情報は同ガイド節を参照してください。
