import type { NextConfig } from 'next'

/**
 * The public host, when the app is served behind a proxy that does not forward it in
 * `x-forwarded-host`. Server Actions reject a request whose Origin differs from the host the
 * server sees, so the browser-facing host from APP_URL has to be allowed explicitly.
 */
function publicHosts(): string[] {
  const raw = process.env.PAGESURE_PUBLIC_ORIGIN?.trim() || process.env.APP_URL?.trim()
  if (!raw) return []
  try {
    return [new URL(raw).host]
  } catch {
    return []
  }
}

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module and must stay external to the server bundle.
  serverExternalPackages: ['better-sqlite3'],
  experimental: {
    // Directory-based route handlers may read the raw request stream.
    proxyTimeout: 30_000,
    serverActions: {
      allowedOrigins: publicHosts(),
    },
  },
}

export default nextConfig