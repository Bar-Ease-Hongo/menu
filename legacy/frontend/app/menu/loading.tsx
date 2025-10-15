export default function MenuLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="flex animate-pulse flex-col gap-4">
        {[...Array(6)].map((_, index) => (
          <div key={index} className="h-40 w-full rounded-3xl bg-zinc-900/60" />
        ))}
      </div>
    </main>
  );
}
