import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // node:sqlite must stay external on the server
  serverExternalPackages: [],
};

export default nextConfig;
