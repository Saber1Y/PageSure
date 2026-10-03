import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'

/**
 * Fonts are self-hosted with next/font/local rather than next/font/google.
 *
 * next/font/google tries to fetch from fonts.googleapis.com at build time, which fails
 * on an offline or proxied machine and silently falls back to a system font. The woff2
 * files are vendored into src/app/fonts and loaded from disk, so a build never depends
 * on the network.
 *
 * Sans is Space Grotesk: a geometric grotesque with a tall x-height and unusually
 * compact, round bowls. It reads as contemporary without being a fashion face, and it
 * holds up at the display sizes the marketing hero uses, where a neutral UI grotesque
 * goes slack.
 *
 * Mono stays Geist Mono. Space Grotesk has no mono cut, and this product is full of
 * hashes, addresses, amounts and header values that must stay monospaced to align.
 */
const spaceGrotesk = localFont({
  variable: '--font-space-grotesk',
  display: 'swap',
  src: [
    { path: './fonts/space-grotesk-latin.woff2', weight: '300 700', style: 'normal' },
    { path: './fonts/space-grotesk-latin-ext.woff2', weight: '300 700', style: 'normal' },
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
    <html lang="en" className={`${spaceGrotesk.variable} ${geistMono.variable}`}>
      <body className="min-h-[100dvh] bg-canvas text-ink antialiased">{children}</body>
    </html>
  )
}