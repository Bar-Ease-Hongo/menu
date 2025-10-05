'use client';

import { useState } from 'react';

import type { RecommendFilters, RecommendItemResult } from '@bar-ease/core';

interface RecommendFormProps {
  defaultFilters?: RecommendFilters;
}

const RECOMMEND_ENDPOINT = process.env.NEXT_PUBLIC_RECOMMEND_API ?? '/api/recommend';

export function RecommendForm({ defaultFilters }: RecommendFormProps) {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<RecommendFilters>(defaultFilters ?? {});
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<RecommendItemResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(RECOMMEND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, filters, limit: 5 })
      });

      if (!res.ok) {
        throw new Error('レコメンドの取得に失敗しました');
      }

      const data = (await res.json()) as { items: RecommendItemResult[] };
      setResults(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4 rounded-3xl border border-zinc-800 bg-black/40 p-6">
        <div className="space-y-2">
          <label className="text-sm font-medium text-zinc-300" htmlFor="recommend-text">
            気分や好みを自由に入力
          </label>
          <textarea
            id="recommend-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            placeholder="スモーキーでフルーティー、甘さ控えめのものが飲みたい"
            className="w-full resize-none rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent focus:outline-none"
          />
        </div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-zinc-300">クイックフィルタ</legend>
          <div className="flex flex-wrap gap-2 text-sm">
            {['low', 'mid', 'high'].map((abv) => (
              <button
                key={abv}
                type="button"
                onClick={() =>
                  setFilters((prev) => ({
                    ...prev,
                    abv: prev.abv === abv ? undefined : (abv as 'low' | 'mid' | 'high')
                  }))
                }
                className={`rounded-full border px-4 py-1 capitalize transition ${
                  filters.abv === abv
                    ? 'border-accent bg-accent text-background'
                    : 'border-zinc-700 text-zinc-200 hover:border-accent'
                }`}
              >
                度数 {abv}
              </button>
            ))}
            {['low', 'mid', 'high'].map((price) => (
              <button
                key={price}
                type="button"
                onClick={() =>
                  setFilters((prev) => ({
                    ...prev,
                    priceRange: prev.priceRange === price ? undefined : (price as 'low' | 'mid' | 'high')
                  }))
                }
                className={`rounded-full border px-4 py-1 capitalize transition ${
                  filters.priceRange === price
                    ? 'border-accent bg-accent text-background'
                    : 'border-zinc-700 text-zinc-200 hover:border-accent'
                }`}
              >
                価格 {price}
              </button>
            ))}
          </div>
        </fieldset>
        <button
          type="submit"
          disabled={loading || !text}
          className="w-full rounded-full border border-accent bg-accent px-6 py-3 font-semibold text-background transition hover:bg-transparent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? '提案中…' : 'おすすめを表示'}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
      {results.length > 0 && (
        <section className="space-y-4">
          <h2 className="font-display text-2xl text-accent">おすすめの一杯</h2>
          <div className="space-y-3">
            {results.map((item) => (
              <article key={item.id} className="space-y-2 rounded-3xl border border-zinc-800 bg-black/30 p-4">
                <header className="flex items-center justify-between">
                  <div>
                    <p className="font-display text-xl text-foreground">{item.name}</p>
                    <p className="text-sm text-zinc-400">{item.maker}</p>
                  </div>
                  <span className="text-xs text-zinc-500">score {item.score.toFixed(2)}</span>
                </header>
                {item.reason && <p className="text-sm text-zinc-200">{item.reason}</p>}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
