import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Source files import siblings with a `.js` suffix (matching the style used
  // across src/connectors, src/workers, etc. and the ESM spec for emitted
  // output). Webpack needs help mapping `./foo.js` → `./foo.ts` at build time.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
