/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true
  },
  images: {
    // sharp ネイティブモジュールの Lambda 生成を避けるため一時的に最適化を無効化
    // (SST deploy 中の "failed to run npm install" 対策)。
    // 画像最適化が必要になったら CloudFront / 外部最適化サービス導入後に戻す。
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.amazonaws.com'
      },
      {
        protocol: 'https',
        hostname: '**.cloudfront.net'
      },
      {
        protocol: 'https',
        hostname: 'example.com'
      }
    ]
  }
};

export default nextConfig;
