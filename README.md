# Bar Ease Hongo メニュー配信システム（GAS完結版）

Google スプレッドシートを唯一の管理画面として扱い、**Google Apps Script (GAS) + Gemini 2.0 Flash Exp** で完結するメニュー配信システムです。ブラウザリロードで即座に反映され、AI補完とAIおすすめ機能も搭載しています。

---

## 🎯 現行システム構成（GAS完結版）

- **Googleスプレッドシート**: メニュー管理（SSOT）
- **Google Apps Script (GAS)**: Webアプリ配信 + AI機能
- **Gemini 2.0 Flash Experimental**: AIレコメンド＋AI補完エンジン
- **GitHub**: ソースコード管理

### 主な機能

✅ **メニュー一覧表示**: Webアプリで承認済み商品を即時配信（~1000件）  
✅ **クライアント検索**: ブラウザ内で検索/絞込/ソート（サーバー負荷なし）  
✅ **AI補完**: Gemini 2.0 Flash Expで商品情報を自動補完（公式情報優先、欠損値のみ）  
✅ **AIおすすめ**: Gemini 2.0 Flash Expで再ランク＋理由生成（80〜120字）  
✅ **リアルタイム反映**: ブラウザリロードで即座に最新データを表示（時間トリガー不要）  
✅ **高速キャッシュ**: CacheServiceで10分間キャッシュ（2回目以降0.1秒以下）  
✅ **AI_Logs**: レコメンド履歴を自動記録

---

## 📁 リポジトリ構成

```
├── apps-script/           # GAS完結版の実装
│   ├── Code.gs           # メインロジック（doGet, recommend, 承認反映）
│   └── index.html        # Webアプリ UI（Vanilla JS）
├── contracts/            # APIコントラクト（将来のAWS再統合用）
│   └── recommend.ts      # レコメンドAPI型定義（固定）
├── docs/                 # ドキュメント
│   ├── README_OWNER.md   # オーナー向け運用ガイド
│   └── cleanup-notes.md  # レガシー資産管理ノート
├── data/fixtures/        # サンプルデータ
├── gas/                  # 旧GASスクリプト（参考用）
└── legacy/               # 旧AWS構成（アーカイブ）
    ├── frontend/         # Next.js 14 フロントエンド
    ├── infra/            # SST v3 インフラ定義
    ├── services/         # Lambda 関数群
    └── packages/         # 共通パッケージ（core, common）
```

---

## 🚀 クイックスタート（オーナー向け）

### 1. Googleスプレッドシート準備

1. メニュー管理用のスプレッドシートを作成
2. シート名を「**メニュー**」に設定
3. 既存データがあればそのまま残す

### 2. Apps Script プロジェクト作成

1. スプレッドシートで `拡張機能` → `Apps Script` を選択
2. `Code.gs` を作成し、`apps-script/Code.gs` の内容を貼り付け
3. `index.html` を作成し、`apps-script/index.html` の内容を貼り付け
4. プロジェクト名を「**Bar Ease Hongo**」に変更

### 3. APIキー設定

1. [Google AI Studio](https://aistudio.google.com/app/apikey) で Gemini APIキーを取得
2. Apps Script エディタで ⚙️ → `プロジェクトの設定` → `スクリプト プロパティ`
3. 以下を追加:
   - `GEMINI_API_KEY`: `your-api-key`

### 4. 初期セットアップ実行

1. `Code.gs` で関数選択ドロップダウンから `setupMenuSheet` を選択
2. 実行ボタン ▶️ をクリック
3. 認可ダイアログで `続行` → アカウント選択 → `許可`
4. 完了後、スプレッドシートに列が追加される

### 5. Webアプリとして公開

1. `デプロイ` → `新しいデプロイ`
2. 種類: `ウェブアプリ`
3. 設定:
   - **次のユーザーとして実行**: `自分`
   - **アクセスできるユーザー**: `全員`
4. `デプロイ` をクリック
5. WebアプリのURLをコピー

### 6. 動作確認

1. WebアプリのURLをブラウザで開く
2. メニュー一覧タブで商品が表示されることを確認
3. AIおすすめタブで動作確認

詳細は **[docs/README_OWNER.md](./docs/README_OWNER.md)** を参照してください。

---

## 📊 コスト比較

| 構成 | 月額コスト |
|------|----------|
| **GAS完結版（現行）** | **~$0.50/月** |
| AWS構成（旧） | ~$13.00/月 |

**コスト削減**: 約 **96%** 削減

---

## 🔄 旧AWS構成について

旧AWS + Next.js構成は `legacy/` ディレクトリにアーカイブされています:

- `legacy/frontend`: Next.js 14 フロントエンド
- `legacy/infra`: SST v3 インフラ定義
- `legacy/services`: Lambda 関数群（AI補完、Webhook、レコメンド）
- `legacy/packages`: 共通パッケージ

### AWS構成の再起動

将来的にAWS構成に戻す必要がある場合（SaaS化、大規模化等）の手順は **[docs/cleanup-notes.md](./docs/cleanup-notes.md)** を参照してください。

### 旧構成の主な機能（参考）

- **Lambda**: `/ai/request`, `/ai/result`, `/webhook`, `/recommend`
- **DynamoDB**: シートデータ保存（source/published分離）
- **Bedrock**: Claude 3 Haiku (AI補完), Titan Embeddings (レコメンド)
- **S3**: menu.json, embeddings.json, 画像アセット
- **Next.js 14**: App Router、モバイル最適化フロントエンド

---

## 🎨 デザインコンセプト

- **背景**: #0B0B0D（黒）
- **テキスト**: #F5F5F5（白）/ #D9D9D9（グレー）
- **アクセント**: #C9A227（金）
- **フォント**: セリフ系タイトル + サンセリフ本文
- **レイアウト**: モバイルファーストのレスポンシブデザイン

---

## 📖 ドキュメント

| ドキュメント | 対象 | 内容 |
|------------|------|------|
| [README_OWNER.md](./docs/README_OWNER.md) | オーナー | 運用ガイド（初期設定、日常運用、トラブルシューティング） |
| [cleanup-notes.md](./docs/cleanup-notes.md) | 開発者 | レガシー資産管理（停止、アーカイブ、再起動手順） |
| [仕様書.md](./docks/仕様書.md) | 開発者 | 旧システムの仕様書（参考） |

---

## 🔧 開発者向け情報

### APIコントラクト（固定）

将来のAWS再統合に備え、レコメンドAPIの型定義は固定されています:

- **ファイル**: `contracts/recommend.ts`
- **型**: `RecommendRequest`, `RecommendResponse`, `RecommendError`
- **実装**: 現在はGemini、将来はEmbeddings（AWS Lambda）に無痛切替可能

### GAS実装の主要関数

| 関数 | 目的 |
|------|------|
| `doGet()` | Webアプリのエントリーポイント（HTML配信） |
| `getMenuDataForClient()` | クライアント向けメニューデータ取得（CacheService対応） |
| `recommend()` | AIおすすめ機能（Gemini 2.0 Flash Exp） |
| `requestAiCompletion()` | AI補完実行（Gemini 2.0 Flash Exp） |
| `showInMenu()` / `hideFromMenu()` | メニュー表示制御（複数行対応） |
| `clearMenuCache()` | キャッシュクリア |
| `setupMenuSheet()` | 初期セットアップ |

### ディレクトリ構造の変更履歴

**2025-10-11: GAS完結版への移行**

- `apps/frontend` → `legacy/frontend`
- `infra` → `legacy/infra`
- `services` → `legacy/services`
- `packages` → `legacy/packages`（ただし `contracts` は保持）
- 新規作成: `apps-script/` （GAS実装）

---

## 🛠️ トラブルシューティング

### メニューに商品が表示されない

1. スプレッドシートで `メニュー表示状態` が「メニューに表示」になっているか確認
2. カスタムメニュー `Bar Ease Hongo` → `今すぐ反映` を実行

### AIおすすめが動作しない

1. カスタムメニュー `Bar Ease Hongo` → `設定を確認` を実行
2. `GEMINI_API_KEY` が「✓ 設定済み」になっているか確認
3. 未設定の場合は、[Google AI Studio](https://aistudio.google.com/app/apikey) で取得して設定

### その他の問題

詳細は **[docs/README_OWNER.md](./docs/README_OWNER.md)** の「トラブルシューティング」セクションを参照してください。

---

## 📝 今後の展望

### 短期（GAS完結版の改善）

- [ ] キャッシュ制御の最適化（CacheService導入）
- [ ] エラーハンドリングの強化
- [ ] AI_Logs の可視化ダッシュボード

### 中期（機能拡張）

- [ ] 在庫管理機能
- [ ] オーダー履歴管理
- [ ] 多言語対応（英語、中国語）

### 長期（SaaS化）

- [ ] マルチテナント対応
- [ ] AWS構成への再移行（Embeddings検索、Claude再ランキング）
- [ ] 課金システム統合

---

## 🤝 コントリビューション

このプロジェクトは Bar Ease Hongo 専用です。機能追加や改善提案は Issue または Pull Request でお願いします。

---

## 📄 ライセンス

Proprietary - Bar Ease Hongo 専用

---

## 📞 サポート

問題が発生した場合は、以下の情報を添えて開発チームに連絡してください:

- 発生した問題の詳細
- エラーメッセージ
- Apps Script の実行ログ
- AI_Logs シートの最新5件

---

**最終更新**: 2025-10-11  
**バージョン**: GAS完結版 v1.0
