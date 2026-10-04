/**
 * Service slugs.
 *
 * A slug is the public identity of a service: it is the `/v1/:slug` path an agent calls, it
 * appears in curl snippets, and it ends up in payment challenges as `externalId`. Two properties
 * follow, and both are enforced here rather than left to the database.
 *
 * 1. It is GLOBAL, not per-tenant. `/v1/:slug` carries no organization context, so
 *    `resolveServiceBySlug` cannot filter by tenant, and `services_slug_idx` is a single unique
 *    index across every row. Two tenants cannot pick the same slug.
 *
 * 2. It shares a URL space with fixed gateway routes. `/v1/[slug]/session` is a real route, so a
 *    service called `session` would collide with the channel endpoints for the same prefix.
 *
 * There was no validator before this: every slug in the tree was a hand-written literal in the
 * seed, and the only constraint was the unique index. A slug containing a space, a slash or a
 * question mark produced a URL that simply could not be requested.
 */

/** Long enough to be descriptive, short enough to stay readable in a payment challenge. */
const MAX_LENGTH = 40

/**
 * Reserved because the gateway mounts fixed routes under `/v1/[slug]/`.
 *
 * `session` is the important one: it is a real route, not a hypothetical.
 */
const RESERVED = new Set(['session', 'new', 'api', 'overview', 'settings', 'login'])

/** Anything a caller could put in a path segment that would not survive a round trip. */
const VALID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SlugRejection =
  | 'empty'
  | 'characters'
  | 'length'
  | 'reserved'
  | 'leading_dash'
  | 'trailing_dash'

/**
 * Derive a candidate slug from a human name.
 *
 * Best-effort and deliberately lossy: accented characters are stripped rather than
 * transliterated, because a wrong guess the user can see and correct beats a clever
 * transformation they cannot. The result is still validated by `validateSlug` before use.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/, '')
}

/**
 * Validate a slug, returning the reason it was refused rather than a bare boolean.
 *
 * The caller needs the reason: "that name is reserved" and "that contains a slash" are different
 * corrections for the user, and collapsing them into one message teaches nothing.
 *
 * Assumes `slugify` has already run if case folding was wanted; a slug reaching this function
 * with uppercase in it is refused rather than silently lowered, because the slug the user can see
 * is the slug that gets stored, and quietly changing it is how you end up with `/v1/Search`.
 */
export function validateSlug(slug: string): { ok: true; slug: string } | { ok: false; reason: SlugRejection } {
  const value = slug.trim()

  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (value !== value.toLowerCase()) return { ok: false, reason: 'characters' }
  if (value.length > MAX_LENGTH) return { ok: false, reason: 'length' }
  if (value.startsWith('-')) return { ok: false, reason: 'leading_dash' }
  if (value.endsWith('-')) return { ok: false, reason: 'trailing_dash' }
  if (!VALID.test(value)) return { ok: false, reason: 'characters' }
  if (RESERVED.has(value)) return { ok: false, reason: 'reserved' }

  return { ok: true, slug: value }
}
