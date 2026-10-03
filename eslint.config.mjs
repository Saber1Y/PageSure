import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

/**
 * eslint-config-next 16 ships native flat configs, so no FlatCompat shim is used.
 * The shim path fails with "Converting circular structure to JSON" against the
 * React plugin in this version.
 */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'next-env.d.ts',
      'contracts/**',
    ],
  },
]

export default eslintConfig