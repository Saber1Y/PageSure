import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'

/**
 * Fonts are self-hosted with next/font/local rather than next/font/google.
 *
 * next/font/google tries to fetch from fonts.googleapis.com at build time, which fails
 * on an offline or proxied machine and silently falls back to a system font. The Geist
 * woff2 files ship with Next, so they are vendored into src/app/fonts and loaded from
 * disk. Same typography, no network dependency.
 */
const geistSans = localFont({
  variable: '--font-geist-sans',
  display: 'swap',
  src: [
    { path: './fonts/geist-latin.woff2', weight: '100 900', style: 'normal' },
    { path: './fonts/geist-latin-ext.woff2', weight: '100 900', style: 'normal' },
  ],
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'sans-serif'],
})

const geistMono = localFont({
  variable: '--font-geist-mono',
  display: 'swap',
  src: [
    { path: './fonts/geist-mono-latin.woff2', weight: '100 900', style: 'normal' },
    { path: './fonts/geist-mono-latin-ext.woff2', weight: '100 900', style: 'normal' },
  ],
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
  title: 'PageSure',
  description:
    'Machine-payment gateway for APIs and digital services. HTTP-native Stellar MPP payments with provider policy enforcement.',
  openGraph: {
    title: 'PageSure, let machines pay for APIs',
    description:
      'HTTP-native Stellar payments with provider-controlled access policy. Charge per request, or settle a session in one transaction.',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-[100dvh] bg-canvas text-ink antialiased">{children}</body>
    </html>
  )
}