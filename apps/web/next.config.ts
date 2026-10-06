import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@suhbat/contracts', '@suhbat/database', '@suhbat/shared', '@suhbat/ui'],
  allowedDevOrigins: ['*.e2b.app'],
};

export default nextConfig;
