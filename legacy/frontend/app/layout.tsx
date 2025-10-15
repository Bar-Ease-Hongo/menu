import type { Metadata } from 'next';
import './globals.css';
import { Noto_Sans_JP, Playfair_Display } from 'next/font/google';

const notoSans = Noto_Sans_JP({ subsets: ['latin'], variable: '--font-body' });
const playfairDisplay = Playfair_Display({ subsets: ['latin'], variable: '--font-display' });

export const metadata: Metadata = {
  title: 'Bar Ease Hongo Menu',
  description: 'Bar Ease Hongo のメニューとおすすめをスマートに表示するモバイル最適化アプリ。'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className={`${notoSans.variable} ${playfairDisplay.variable}`}>
      <body>{children}</body>
    </html>
  );
}
