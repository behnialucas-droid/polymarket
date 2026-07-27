import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig & { turbopack?: { root?: string } } = {
  serverExternalPackages: ['postgres'],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
