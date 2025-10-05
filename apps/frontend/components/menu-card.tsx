import Image from 'next/image';
import Link from 'next/link';

import type { MenuItem } from '@bar-ease/core';

interface MenuCardProps {
  item: MenuItem;
}

export function MenuCard({ item }: MenuCardProps) {
  const fmt = new Intl.NumberFormat('ja-JP');
  const prices: string[] = [];
  if (item.price30ml != null) prices.push(`30ml ¥${fmt.format(item.price30ml)}`);
  if (item.price15ml != null) prices.push(`15ml ¥${fmt.format(item.price15ml)}`);
  if (item.price10ml != null) prices.push(`10ml ¥${fmt.format(item.price10ml)}`);
  return (
    <article className="flex flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-black/40 backdrop-blur">
      <div className="relative h-56 w-full">
        {item.imageUrl ? (
          <Image
            src={item.imageUrl}
            alt={`${item.name} ${item.maker}`}
            fill
            priority={false}
            sizes="(max-width: 768px) 100vw, 33vw"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-zinc-500">
            No Image
          </div>
        )}
      </div>
        <div className="space-y-4 p-5">
          <div className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-accent">{item.category}</span>
            <h3 className="font-display text-xl text-foreground">{item.name}</h3>
            <p className="text-sm text-zinc-400">{item.maker}</p>
            <p className="line-clamp-3 text-sm text-zinc-300">{item.description}</p>
            {prices.length > 0 && (
              <p className="text-sm text-accent">{prices.join(' / ')}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {item.tags.map((tag) => (
              <span key={tag} className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300">
                #{tag}
            </span>
          ))}
        </div>
        <Link
          href={`/menu/${item.id}`}
          className="inline-flex items-center justify-center rounded-full border border-accent px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent hover:text-background"
        >
          詳しく見る
        </Link>
      </div>
    </article>
  );
}
