import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

import type { MenuItem, MenuResponse, RecommendFilters } from '@bar-ease/core';

const MENU_URL = process.env.NEXT_PUBLIC_MENU_JSON_URL ?? '';
const MAKERS_URL = process.env.NEXT_PUBLIC_MAKERS_JSON_URL ?? '';
const ROOT_DIR = process.cwd();
const FIXTURE_DIR = path.join(ROOT_DIR, 'data', 'fixtures');

async function resolveFixtureDir(): Promise<string> {
  // Try current working directory and walk up a few levels to find top-level data/fixtures
  const maxUp = 4;
  let root = ROOT_DIR;
  for (let i = 0; i <= maxUp; i++) {
    const candidate = path.join(root, 'data', 'fixtures');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not found, move up
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }

  // Fallback to original location (may throw later)
  return FIXTURE_DIR;
}

async function readFixtureJson<T>(filename: string): Promise<T | null> {
  try {
    const dir = await resolveFixtureDir();
    const filePath = path.join(dir, filename);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data) as T;
  } catch (error) {
    console.warn(`[menu] フォールバックの読み込みに失敗しました (${filename})`, error);
    return null;
  }
}

function normalizeMakerList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        const maker = (value as { maker?: string }).maker;
        if (typeof maker === 'string') return maker;
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function emptyMenu(): MenuResponse {
  return { items: [], total: 0, updatedAt: new Date().toISOString() };
}

export interface MenuQueryParams {
  keyword?: string;
  maker?: string;
  category?: string;
  tags?: string;
}

export async function fetchMenu(): Promise<MenuResponse> {
  if (!MENU_URL) {
    const fallback = await readFixtureJson<MenuResponse>('menu.sample.json');
    return fallback ?? emptyMenu();
  }

  try {
    const res = await fetch(MENU_URL, {
      cache: 'no-store'
    });

    if (!res.ok) {
      if (res.status === 404) {
        const fallback = await readFixtureJson<MenuResponse>('menu.sample.json');
        return fallback ?? emptyMenu();
      }
      throw new Error(`menu.json の取得に失敗しました: ${res.status}`);
    }

    return (await res.json()) as MenuResponse;
  } catch (err) {
    console.error('[menu] menu.json の取得に失敗しました', err);
    const fallback = await readFixtureJson<MenuResponse>('menu.sample.json');
    return fallback ?? emptyMenu();
  }
}

export async function fetchMakers(): Promise<string[]> {
  if (!MAKERS_URL) {
    const fallback = await readFixtureJson<{ makers: unknown }>('makers.sample.json');
    return normalizeMakerList(fallback?.makers);
  }

  try {
    const res = await fetch(MAKERS_URL, {
      next: { revalidate: 300 }
    });

    if (!res.ok) {
      if (res.status === 404) {
        const fallback = await readFixtureJson<{ makers: unknown }>('makers.sample.json');
        return normalizeMakerList(fallback?.makers);
      }
      return [];
    }

    const data = (await res.json()) as { makers?: unknown };
    return normalizeMakerList(data.makers);
  } catch (error) {
    console.error('[menu] makers.json の取得に失敗しました', error);
    const fallback = await readFixtureJson<{ makers: unknown }>('makers.sample.json');
    return normalizeMakerList(fallback?.makers);
  }
}

export function filterMenu(items: MenuItem[], { keyword, maker, category, tags }: MenuQueryParams) {
  const keywordLower = keyword?.toLowerCase();
  const tagList = tags?.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [];

  return items.filter((item) => {
    if (item.status !== 'Published' || item.aiStatus !== 'Approved') {
      return false;
    }

    if (maker && item.makerSlug !== maker && item.maker !== maker) {
      return false;
    }

    if (category && item.category !== category) {
      return false;
    }

    if (keywordLower) {
      const target = `${item.name} ${item.maker} ${item.category} ${item.description} ${item.tags.join(' ')}`.toLowerCase();
      if (!target.includes(keywordLower)) {
        return false;
      }
    }

    if (tagList.length > 0) {
      const lowerTags = item.tags.map((tag) => tag.toLowerCase());
      const missing = tagList.some((tag) => !lowerTags.includes(tag));
      if (missing) {
        return false;
      }
    }

    return true;
  });
}

export function toFiltersFromQuery(params: MenuQueryParams): RecommendFilters {
  return {
    category: params.category ? [params.category] : undefined,
    maker: params.maker ? [params.maker] : undefined,
    // UIからABV/価格帯は別途指定。ここではタグで推測はしない。
  };
}
