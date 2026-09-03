/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@govyzer/ui'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'no-referrer' },
          { key: 'x-frame-options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default nextConfig;
