import type { RecommendFilters } from './menu.js';

export interface RecommendRequestBody {
  text: string;
  filters?: RecommendFilters;
  limit?: number;
}

export interface RecommendItemResult {
  id: string;
  score: number;
  name: string;
  maker: string;
  imageUrl?: string;
  reason?: string;
}

export interface RecommendResponseBody {
  items: RecommendItemResult[];
}
