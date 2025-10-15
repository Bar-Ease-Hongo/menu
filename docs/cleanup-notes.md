# レガシー資産管理ノート

このドキュメントは、AWS + Next.js 構成から GAS 完結版への移行に伴う、旧資産の停止・アーカイブ・再起動手順を記載します。

---

## 📁 アーカイブ済み資産

以下の資産は `legacy/` ディレクトリに移動済みです:

| 旧ディレクトリ | 移動先 | 内容 |
|--------------|--------|------|
| `apps/frontend` | `legacy/frontend` | Next.js 14 フロントエンド |
| `infra` | `legacy/infra` | SST v3 インフラ定義 |
| `services` | `legacy/services` | Lambda 関数群 |
| `packages` | `legacy/packages` | 共通パッケージ（core, common） |

**保持された資産**:
- `contracts/recommend.ts`: APIコントラクト（将来のAWS再統合用）
- `gas/onEdit.gs`: 旧GASスクリプト（参考用）
- `data/fixtures`: サンプルデータ

---

## ⛔ AWS リソースの停止手順

### 1. Lambda 関数の停止

現在デプロイされているLambda関数は、AWS上で課金が発生している可能性があります。以下の手順で停止します:

```bash
# ステージング環境の削除
AWS_PROFILE=barease-dev pnpm remove:sst:dev

# 本番環境の削除（慎重に！）
AWS_PROFILE=barease-prod pnpm remove:sst:prod
```

**注意**: `remove:sst:*` コマンドは以下のリソースを削除します:
- Lambda 関数
- API Gateway
- DynamoDB テーブル
- S3 バケット（menu.json, embeddings.json, 画像）
- IAM ロール / ポリシー

**削除前の確認事項**:
- [ ] S3バケット内の重要データをバックアップ
- [ ] DynamoDB テーブルのエクスポート
- [ ] CloudWatch Logs の保存期間設定

### 2. S3 バケットのバックアップ

削除前に重要データをバックアップします:

```bash
# menu.json のバックアップ
aws s3 cp s3://${MENU_BUCKET_NAME}/menu.json ./backups/menu.json --profile barease-prod

# embeddings.json のバックアップ
aws s3 cp s3://${MENU_BUCKET_NAME}/embeddings.json ./backups/embeddings.json --profile barease-prod

# 画像のバックアップ（オプション）
aws s3 sync s3://${PUBLIC_IMAGE_BUCKET_NAME}/ ./backups/images/ --profile barease-prod
```

### 3. DynamoDB のエクスポート

```bash
# テーブルをJSONファイルにエクスポート
aws dynamodb scan --table-name ${SHEET_TABLE_NAME} \
  --profile barease-prod \
  > ./backups/dynamodb-export.json
```

### 4. Secrets の記録

```bash
# シークレットの値を記録（後で再デプロイ時に使用）
pnpm exec sst secrets value GasWebhookSecret --stage prod > ./backups/secrets.txt
```

**⚠️ 警告**: `secrets.txt` には機密情報が含まれるため、`.gitignore` に追加し、絶対にコミットしないでください。

### 5. CloudWatch Logs の設定

Lambda削除後もログを保持したい場合:

1. AWS Console → CloudWatch → ロググループ
2. 各Lambda関数のロググループを選択
3. `アクション` → `ログの保持期間を設定`
4. 適切な期間（例: 30日、90日）を選択

---

## 🔄 AWS 構成の再起動手順

将来的にAWS構成に戻す場合の手順:

### 1. Legacy 資産の復元

```bash
# リポジトリルートで実行
cd /Users/hiroki/Projects/Bar-Ease-Hongo

# フロントエンドの復元
mv legacy/frontend apps/

# インフラの復元
mv legacy/infra ./

# Lambdaサービスの復元
mv legacy/services ./

# パッケージの復元
mv legacy/packages/common packages/
mv legacy/packages/core/src/menu.ts packages/core/src/
mv legacy/packages/core/src/recommend.ts packages/core/src/
mv legacy/packages/core/src/sheet.ts packages/core/src/

# contracts は既にあるのでスキップ
```

### 2. 依存パッケージのインストール

```bash
# Node.jsバージョンの確認
nvm use

# パッケージのインストール
pnpm install
```

### 3. 環境変数の設定

```bash
# .env.example をコピー
cp .env.example .env

# .env を編集
vim .env
```

必要な環境変数:
```bash
# AWS
AWS_REGION=ap-northeast-1
AWS_PROFILE=barease-prod

# Bedrock
BEDROCK_MODEL_CLAUDE=anthropic.claude-3-haiku-20240307-v1:0
BEDROCK_MODEL_EMBEDDING=amazon.titan-embed-text-v2:0

# S3
MENU_BUCKET_NAME=bar-ease-hongo-menu-prod
PUBLIC_IMAGE_BUCKET_NAME=bar-ease-hongo-images-prod
STAGING_IMAGE_BUCKET_NAME=bar-ease-hongo-staging-prod

# DynamoDB
SHEET_TABLE_NAME=bar-ease-hongo-sheet-prod

# GAS
GAS_WEBHOOK_SECRET=<backups/secrets.txt の値>
GAS_WEBHOOK_ENDPOINT=<デプロイ後に設定>

# Next.js
NEXT_PUBLIC_MENU_JSON_URL=https://${MENU_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/menu.json
NEXT_PUBLIC_RECOMMEND_API=https://<API_GATEWAY_URL>/recommend
```

### 4. インフラのデプロイ

```bash
# ステージング環境
AWS_PROFILE=barease-dev pnpm deploy:sst:dev

# 本番環境
AWS_PROFILE=barease-prod pnpm deploy:sst:prod
```

デプロイ後、以下の出力を記録:
- `ApiUrl`: API Gateway のURL
- `MenuBucket`: S3バケット名
- `FrontendUrl`: CloudFront URL（Next.jsサイト）

### 5. Secrets の復元

```bash
# backups/secrets.txt から値を取得
cat backups/secrets.txt

# Secretsに設定
pnpm exec sst secrets set GasWebhookSecret <値> --stage prod
```

### 6. DynamoDB データの復元

```bash
# JSONファイルからインポート
aws dynamodb put-item --table-name ${SHEET_TABLE_NAME} \
  --profile barease-prod \
  --cli-input-json file://backups/dynamodb-export.json
```

### 7. S3 データの復元

```bash
# menu.json の復元
aws s3 cp ./backups/menu.json s3://${MENU_BUCKET_NAME}/menu.json --profile barease-prod

# embeddings.json の復元
aws s3 cp ./backups/embeddings.json s3://${MENU_BUCKET_NAME}/embeddings.json --profile barease-prod

# 画像の復元（オプション）
aws s3 sync ./backups/images/ s3://${PUBLIC_IMAGE_BUCKET_NAME}/ --profile barease-prod
```

### 8. GAS の更新

1. Apps Script エディタで `Code.gs` を開く
2. AWS依存コード（`callSignedApi`, `callSignedGet` 等）のコメントアウトを解除
3. スクリプト プロパティに以下を追加:
   - `AI_REQUEST_URL`: `<ApiUrl>/ai/request`
   - `WEBHOOK_URL`: `<ApiUrl>/webhook`
   - `AI_RESULT_URL`: `<ApiUrl>/ai/result`
   - `WEBHOOK_SECRET`: `<backups/secrets.txt の値>`

### 9. Next.js フロントエンドのデプロイ

```bash
# ビルド
pnpm build:frontend

# SST経由でデプロイ（CloudFront + S3）
pnpm deploy:sst:prod
```

### 10. 動作確認

1. **Lambda 関数**: AWS Console → Lambda で各関数の実行ログを確認
2. **API Gateway**: Postman等で `/ai/request`, `/webhook`, `/recommend` をテスト
3. **DynamoDB**: AWS Console → DynamoDB でテーブル内容を確認
4. **S3**: `menu.json` のURLをブラウザで開いて表示確認
5. **Next.js**: CloudFront URL を開いてメニュー一覧・AIおすすめを動作確認
6. **GAS**: カスタムメニューから「AI補完を実行」「メニューに表示」を試行

---

## 📊 コスト比較

### GAS完結版（現行）

| サービス | 月額コスト（概算） |
|---------|----------------|
| Google Apps Script | 無料（クォータ内） |
| Gemini 1.5 Flash | ~$0.50（月500リクエスト想定） |
| Googleスプレッドシート | 無料 |
| **合計** | **~$0.50/月** |

### AWS構成（旧）

| サービス | 月額コスト（概算） |
|---------|----------------|
| Lambda | ~$2.00 |
| API Gateway | ~$1.00 |
| DynamoDB | ~$1.50 |
| S3 | ~$0.50 |
| CloudFront | ~$1.00 |
| Bedrock (Claude 3 Haiku) | ~$5.00 |
| Bedrock (Titan Embeddings) | ~$2.00 |
| **合計** | **~$13.00/月** |

**コスト削減**: 約 **96%** 削減（$13.00 → $0.50）

---

## 🔐 セキュリティ考慮事項

### GAS完結版

- **APIキー管理**: スクリプト プロパティに保存（フロント露出なし）
- **認証**: Google アカウント認証（Apps Script標準）
- **データアクセス**: スプレッドシートの共有設定で制御

### AWS構成

- **Secrets 管理**: AWS Secrets Manager または SST Secrets
- **認証**: HMAC署名検証（GAS ⇔ Lambda）
- **IAM**: 最小権限の原則
- **VPC**: 不要（サーバーレス構成）

---

## 📝 メモ

### 移行理由

1. **コスト削減**: AWS月額~$13 → GAS月額~$0.50
2. **運用簡素化**: 単一プラットフォーム（Google Workspace）で完結
3. **スケーラビリティ**: 1000件程度のメニューならGASで十分
4. **保守性**: AWSインフラの管理コスト削減

### 今後の検討事項

- **SaaS化**: マルチテナント対応時はAWS構成に戻す可能性あり
- **スケール**: 月間10万リクエスト超の場合はAWS検討
- **高度な機能**: Embeddings検索が必要な場合はAWS Lambda `/recommend` を再有効化

---

## チェックリスト

### AWS停止前

- [ ] S3バケットのバックアップ完了
- [ ] DynamoDB エクスポート完了
- [ ] Secrets の記録完了
- [ ] CloudWatch Logs の保持期間設定完了
- [ ] 重要なCloudFormation Stackのエクスポート

### AWS再起動前

- [ ] Legacy 資産の復元完了
- [ ] 依存パッケージのインストール完了
- [ ] 環境変数の設定完了
- [ ] バックアップファイルの確認完了
- [ ] AWSクレデンシャルの確認完了

### AWS再起動後

- [ ] Lambda 関数の動作確認
- [ ] API Gateway のエンドポイント確認
- [ ] DynamoDB データの確認
- [ ] S3 ファイルの確認
- [ ] Next.js サイトの動作確認
- [ ] GAS との連携確認
- [ ] エンドツーエンドテスト実施

---

**最終更新**: 2025-10-11

