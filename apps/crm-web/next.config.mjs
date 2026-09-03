/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@govyzer/ui'],
  experimental: { optimizePackageImports: ['@govyzer/ui'] },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'x-frame-options', value: 'DENY' },
          { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
