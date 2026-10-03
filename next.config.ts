import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module and must stay external to the server bundle.
  serverExternalPackages: ['better-sqlite3'],
  experimental: {
    // Directory-based route handlers may read the raw request stream.
    proxyTimeout: 30_000,
  },
}

export default nextConfig