export type MenuStatus = 'Published' | 'Draft';
export type AiStatus = 'None' | 'NeedsReview' | 'Approved' | 'Rejected';
export type ApproveFlag = 'Approved' | 'Rejected' | '-';

export interface MenuItem {
  id: string;
  status: MenuStatus;
  name: string;
  maker: string;
  makerSlug: string;
  category: string;
  tags: string[];
  description: string;
  aiSuggestedDescription?: string;
  aiSuggestedImageUrl?: string;
  imageUrl: string;
  aiStatus: AiStatus;
  approveFlag: ApproveFlag;
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
  alcoholVolume?: number;
  availableBottles?: number;
  price30ml?: number;
  price15ml?: number;
  price10ml?: number;
  notes?: string;
  abvClass?: 'low' | 'mid' | 'high';
  priceClass?: 'low' | 'mid' | 'high';
}

export interface MakerSummary {
  maker: string;
  makerSlug: string;
  country?: string;
  itemCount: number;
}

export interface MenuResponse {
  items: MenuItem[];
  total: number;
  updatedAt: string;
}

export interface RecommendFilters {
  abv?: 'low' | 'mid' | 'high';
  priceRange?: 'low' | 'mid' | 'high';
  category?: string[];
  maker?: string[];
}
