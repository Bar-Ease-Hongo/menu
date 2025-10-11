// 元情報（スプレッドシート手入力）
export interface SourceData {
  name?: string;
  maker?: string;
  category?: string;
  tags?: string; // カンマ区切り
  description?: string;
  alcoholVolume?: string | number;
  imageUrl?: string;
  country?: string;
  manufacturer?: string;
  distributor?: string;
  distillery?: string;
  type?: string;
  caskNumber?: string;
  caskType?: string;
  maturationPlace?: string;
  maturationPeriod?: string;
  availableBottles?: string | number;
  price30ml?: string | number;
  price15ml?: string | number;
  price10ml?: string | number;
  notes?: string;
}

// 優先公開情報（AI補完 or 人手修正後の最終値）
export interface PublishedData {
  name?: string;
  maker?: string;
  category?: string;
  tags?: string; // カンマ区切り
  description?: string;
  alcoholVolume?: string | number;
  imageUrl?: string;
  country?: string;
  type?: string;
  caskType?: string;
  maturationPeriod?: string;
}

// フラグ・状態管理
export interface ItemFlags {
  aiRequested?: boolean;      // AI補完依頼中
  aiCompleted?: boolean;       // AI補完済み
  aiFailed?: boolean;          // AI補完失敗
  publishApproved?: boolean;   // メニューに表示承認済み
  sourceHash?: string;         // 元情報ハッシュ（重複防止）
  publishedHash?: string;      // 優先公開情報ハッシュ
}

// DynamoDB保存形式
export interface SheetEntity {
  pk: string;
  sk: string;
  id: string;
  source: SourceData;
  published?: PublishedData;
  aiSuggested?: Partial<PublishedData>; // AI候補（参考用）
  flags: ItemFlags;
  createdAt?: string;
  syncedAt?: string;
  updatedAt?: string;
}

// GAS→Lambda同期用（後方互換維持）
export interface SheetRow {
  id: string;
  name?: string;
  status?: string;
  maker?: string;
  makerSlug?: string;
  category?: string;
  tags?: string;
  description?: string;
  aiSuggestedDescription?: string;
  aiSuggestedImageUrl?: string;
  imageUrl?: string;
  stagingKey?: string;
  publicKey?: string;
  aiStatus?: string;
  approveFlag?: string;
  approvedBy?: string;
  approvedAt?: string;
  updatedAt?: string;
  country?: string;
  manufacturer?: string;
  distributor?: string;
  distillery?: string;
  type?: string;
  caskNumber?: string;
  caskType?: string;
  maturationPlace?: string;
  maturationPeriod?: string;
  alcoholVolume?: string;
  availableBottles?: string;
  price30ml?: string;
  price15ml?: string;
  price10ml?: string;
  notes?: string;
  // 新フォーマット対応
  source?: SourceData;
  published?: PublishedData;
  flags?: ItemFlags;
}
