import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { MenuItem } from '@bar-ease/core';

import { fetchMenu } from '../../../lib/menu';

interface MenuDetailPageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: MenuDetailPageProps): Promise<Metadata> {
  const { id } = params;
  const { items } = await fetchMenu();
  const item = items.find((menuItem) => menuItem.id === id);

  if (!item) {
    return {
      title: '商品が見つかりません | Bar Ease Hongo'
    };
  }

  return {
    title: `${item.name} | Bar Ease Hongo`,
    description: item.description
  };
}

export default async function MenuDetailPage({ params }: MenuDetailPageProps) {
  const { items } = await fetchMenu();
  const item = items.find((menuItem) => menuItem.id === params.id && menuItem.status === 'Published');

  if (!item) {
    notFound();
  }

  const detailSections: Array<{ label: string; value?: string | number | string[] }> = [
    { label: 'カテゴリ', value: item.category },
    { label: '蒸溜所', value: item.distillery },
    { label: '熟成年数', value: item.maturationPeriod },
    { label: '樽種', value: item.caskType },
    { label: 'アルコール度数', value: item.alcoholVolume ? `${item.alcoholVolume}%` : undefined }
  ];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <Link href="/menu" className="text-sm text-zinc-400 hover:text-accent">
        ← メニュー一覧へ戻る
      </Link>
      <article className="overflow-hidden rounded-3xl border border-zinc-800 bg-black/40 shadow-lg">
        <div className="relative h-80 w-full">
          {item.imageUrl ? (
            <Image src={item.imageUrl} alt={`${item.name} ${item.maker}`} fill className="object-cover" priority />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-zinc-500">No Image</div>
          )}
        </div>
        <div className="space-y-6 p-6">
          <header className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-accent">{item.category}</span>
            <h1 className="font-display text-3xl text-foreground">{item.name}</h1>
            <p className="text-sm text-zinc-400">{item.maker}</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {item.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300">
                  #{tag}
                </span>
              ))}
            </div>
          </header>

          <section className="space-y-3 text-sm leading-relaxed text-zinc-200">
            <h2 className="font-medium text-zinc-300">テイスティングノート</h2>
            <p>{item.description}</p>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            {/* 価格 */}
            {(item.price30ml != null || item.price15ml != null || item.price10ml != null) && (
              <div className="rounded-2xl border border-zinc-800 bg-black/30 p-4 md:col-span-2">
                <p className="text-xs uppercase tracking-wide text-zinc-500">価格</p>
                <p className="mt-2 text-sm text-zinc-100">
                  {[
                    item.price30ml != null ? `30ml ¥${new Intl.NumberFormat('ja-JP').format(item.price30ml)}` : null,
                    item.price15ml != null ? `15ml ¥${new Intl.NumberFormat('ja-JP').format(item.price15ml)}` : null,
                    item.price10ml != null ? `10ml ¥${new Intl.NumberFormat('ja-JP').format(item.price10ml)}` : null
                  ]
                    .filter(Boolean)
                    .join(' / ')}
                </p>
              </div>
            )}
            {detailSections
              .filter((section) => section.value)
              .map((section) => (
                <div key={section.label} className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
                  <p className="text-xs uppercase tracking-wide text-zinc-500">{section.label}</p>
                  <p className="mt-2 text-sm text-zinc-100">
                    {Array.isArray(section.value) ? section.value.join(', ') : section.value}
                  </p>
                </div>
              ))}
          </section>
        </div>
      </article>
    </main>
  );
}
