/**
 * レコメンドAPIコントラクト（固定）
 * 
 * 実装は当面Gemini再ランク、将来Embeddings（AWS/Lambda）に無痛切替可能
 */

/** レコメンドリクエスト */
export type RecommendRequest = {
  /** ユーザーの嗜好 */
  prefs: {
    /** ベース（ウイスキー、ラム等） */
    base?: string;
    /** 味わい（スモーキー、フルーティー等） */
    taste?: string;
    /** 最大価格 */
    maxPrice?: number;
    /** その他メモ */
    memo?: string;
  };
  /** 候補アイテム（最大20件） */
  candidates: Array<{
    /** アイテムID */
    id: string;
    /** 商品名 */
    name: string;
    /** ベース */
    base?: string;
    /** 味わい */
    taste?: string;
    /** 価格 */
    price?: number;
    /** 度数 */
    abv?: number;
    /** タグ */
    tags?: string[];
    /** 説明文 */
    description?: string;
  }>;
};

/** レコメンド成功レスポンス */
export type RecommendResponse = {
  /** おすすめアイテム（通常3件） */
  items: Array<{
    /** アイテムID */
    id: string;
    /** おすすめ理由（80〜120字） */
    reason: string;
    /** 提供方法（オプション） */
    serve?: string;
  }>;
  /** 補足メッセージ */
  note?: string;
  /** メタ情報 */
  meta?: {
    /** 使用モデル */
    model?: string;
    /** レイテンシ（ミリ秒） */
    latencyMs?: number;
    /** トークン使用量 */
    tokenUsage?: {
      input?: number;
      output?: number;
    };
  };
};

/** レコメンドエラー */
export type RecommendError = {
  error: true;
  /** エラーメッセージ */
  message: string;
  /** エラーコード */
  code?: 'RATE_LIMIT' | 'INVALID_INPUT' | 'MODEL_ERROR' | 'UNKNOWN';
};

/** レコメンドAPIレスポンス（成功またはエラー） */
export type RecommendApiResponse =
  | { error?: false; data: RecommendResponse }
  | RecommendError;

