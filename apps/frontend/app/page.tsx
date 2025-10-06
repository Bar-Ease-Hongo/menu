import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="max-w-md space-y-4">
        <p className="font-display text-3xl text-accent">Bar Ease Hongo</p>
        <h1 className="font-display text-4xl">Discover Your Next Dram</h1>
        <p className="text-lg text-zinc-300">
          厳選したウイスキーリストと、お好みに合わせたAIレコメンドをお楽しみください。
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Link
          className="rounded-full border border-accent px-6 py-3 font-medium text-accent transition hover:bg-accent hover:text-background"
          href="/menu"
        >
          メニューを見る
        </Link>
        <Link
          className="rounded-full border border-zinc-700 px-6 py-3 font-medium text-zinc-200 transition hover:bg-zinc-800"
          href="/recommend"
        >
          おすすめを探す
        </Link>
      </div>
    </main>
  );
}
