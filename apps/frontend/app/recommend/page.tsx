import type { Metadata } from 'next';
import Link from 'next/link';

import { RecommendForm } from '../../components/recommend-form';

export const metadata: Metadata = {
  title: '好みに合わせたおすすめ | Bar Ease Hongo'
};

export default function RecommendPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <div>
        <Link href="/" className="text-sm text-zinc-400 hover:text-accent">
          ← トップへ戻る
        </Link>
      </div>
      <header className="space-y-2">
        <h1 className="font-display text-3xl text-accent">今夜の一杯をAIがご提案</h1>
        <p className="text-sm text-zinc-400">気分や香り、味わいの好みを入力すると、おすすめを提示します。</p>
      </header>
      <RecommendForm />
    </main>
  );
}
