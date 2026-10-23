/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Runs instrumentation.ts at server start. Its background work is opt-in per env
  // flag (STARTUP_RECOVERY_ENABLED, TRAILER_SCANNER_ENABLED), so without them the
  // server behaves as before.
  experimental: { instrumentationHook: true },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.amazonaws.com',
      },
      {
        protocol: 'https',
        hostname: '**.blob.core.windows.net',
      },
    ],
  },
};

module.exports = nextConfig;
