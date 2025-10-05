/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true
  },
  images: {
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
