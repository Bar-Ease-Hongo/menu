import type { Metadata } from 'next';
import Link from 'next/link';

import { MenuFilter } from '../../components/menu-filter';
import { MenuCard } from '../../components/menu-card';
import { fetchMenu, fetchMakers, filterMenu } from '../../lib/menu';

interface MenuPageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

export const metadata: Metadata = {
  title: 'メニュー一覧 | Bar Ease Hongo'
};

export default async function MenuPage({ searchParams }: MenuPageProps) {
  const keyword = typeof searchParams.keyword === 'string' ? searchParams.keyword : undefined;
  const maker = typeof searchParams.maker === 'string' ? searchParams.maker : undefined;
  const category = typeof searchParams.category === 'string' ? searchParams.category : undefined;

  const [{ items }, makers] = await Promise.all([fetchMenu(), fetchMakers()]);

  const categories = Array.from(new Set(items.map((item) => item.category).filter(Boolean)));
  const filteredItems = filterMenu(items, { keyword, maker, category });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div>
        <Link href="/" className="text-sm text-zinc-400 hover:text-accent">
          ← トップへ戻る
        </Link>
      </div>
      <header className="space-y-2">
        <h1 className="font-display text-3xl text-accent">メニュー一覧</h1>
        <p className="text-sm text-zinc-400">承認済み商品のみ表示しています。</p>
      </header>
      <MenuFilter makers={makers} categories={categories} initialKeyword={keyword} initialMaker={maker} initialCategory={category} />
      <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {filteredItems.map((item) => (
          <MenuCard key={item.id} item={item} />
        ))}
        {filteredItems.length === 0 && (
          <p className="text-center text-zinc-400 md:col-span-2 xl:col-span-3">
            条件に一致する商品がありませんでした。フィルタ条件を変えてお試しください。
          </p>
        )}
      </section>
    </main>
  );
}
