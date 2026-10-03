import { cookies } from 'next/headers'
import { destroySession } from '@/lib/auth/session'

export const runtime = 'nodejs'

export async function POST(): Promise<Response> {
  await destroySession()
  const store = await cookies()
  store.delete('pagesure_session')
  return new Response(null, { status: 204 })
}