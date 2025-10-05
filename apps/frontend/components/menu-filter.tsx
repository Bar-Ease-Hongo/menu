'use client';

import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

interface MenuFilterProps {
  makers: string[];
  categories: string[];
  initialKeyword?: string;
  initialMaker?: string;
  initialCategory?: string;
}

export function MenuFilter({ makers, categories, initialKeyword = '', initialMaker = '', initialCategory = '' }: MenuFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [keyword, setKeyword] = useState(initialKeyword);
  const [maker, setMaker] = useState(initialMaker);
  const [category, setCategory] = useState(initialCategory);

  const queryString = useMemo(() => {
    const params = new URLSearchParams(searchParams?.toString());
    if (keyword) {
      params.set('keyword', keyword);
    } else {
      params.delete('keyword');
    }
    if (maker) {
      params.set('maker', maker);
    } else {
      params.delete('maker');
    }
    if (category) {
      params.set('category', category);
    } else {
      params.delete('category');
    }
    return params.toString();
  }, [keyword, maker, category, searchParams]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const href = `/menu${queryString ? `?${queryString}` : ''}` as Route;
      router.push(href);
    },
    [router, queryString]
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-2xl bg-muted/60 p-4 backdrop-blur">
      <div className="space-y-1">
        <label className="text-sm font-medium text-zinc-300" htmlFor="keyword">
          キーワード検索
        </label>
        <input
          id="keyword"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="スモーキー / シェリー / 12年 など"
          className="w-full rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent focus:outline-none"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-zinc-300" htmlFor="maker">
          メーカー
        </label>
        <select
          id="maker"
          value={maker}
          onChange={(event) => setMaker(event.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        >
          <option value="">すべて</option>
          {makers.map((makerValue) => (
            <option key={makerValue} value={makerValue}>
              {makerValue}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-zinc-300" htmlFor="category">
          カテゴリ
        </label>
        <select
          id="category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        >
          <option value="">すべて</option>
          {categories.map((categoryValue) => (
            <option key={categoryValue} value={categoryValue}>
              {categoryValue}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="w-full rounded-full border border-accent bg-accent px-4 py-2 font-medium text-background transition hover:bg-transparent hover:text-accent"
      >
        フィルタを適用
      </button>
    </form>
  );
}
