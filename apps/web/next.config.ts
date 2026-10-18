import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@suhbat/contracts',
    '@suhbat/database',
    '@suhbat/shared',
    '@suhbat/ui',
    // Imported lazily by the recording gateway; only the test/injected path loads it.
    '@suhbat/recording-api',
  ],
  allowedDevOrigins: ['*.e2b.app'],
  // Do not write AGENTS.md / CLAUDE.md into the app directory on `next dev`.
  agentRules: false,
};

export default nextConfig;
