/**
 * Known-people registry — the owner + staff reference photos the camera watches
 * match against. Photos live in the private agent-files bucket under
 * known-people/<personId>/<n>.<ext>; the DB row keeps the storage paths.
 *
 * Used by face-match.ts (identification) and the /agent/known-people admin page.
 * All helpers are server-side only.
 */
import { prisma } from '@/lib/prisma'
import { agentStorageUpload, agentStorageDownload, agentStorageSignedUrls } from '@/agent/lib/storage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const BUSINESS_ID = 'ALMA_LIFESTYLE'
export const MAX_PHOTOS_PER_PERSON = 3

export interface KnownPerson {
  id: string
  name: string
  role: string
  photoPaths: string[]
  active: boolean
  note: string | null
  createdAt: Date
}

interface KnownPersonRow {
  id: string
  name: string
  role: string
  photoPaths: unknown
  active: boolean
  note: string | null
  createdAt: Date
}

function toKnownPerson(row: KnownPersonRow): KnownPerson {
  const paths = Array.isArray(row.photoPaths)
    ? (row.photoPaths as unknown[]).filter((p): p is string => typeof p === 'string')
    : []
  return { ...row, photoPaths: paths }
}

export async function listKnownPeople(opts?: { includeInactive?: boolean }): Promise<KnownPerson[]> {
  const rows = (await db.agentKnownPerson.findMany({
    where: { businessId: BUSINESS_ID, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { createdAt: 'asc' },
  })) as KnownPersonRow[]
  return rows.map(toKnownPerson)
}

function extForMime(mimeType: string): string {
  if (/png/i.test(mimeType)) return 'png'
  if (/webp/i.test(mimeType)) return 'webp'
  return 'jpg'
}

export interface NewPhoto {
  base64: string
  mimeType: string
}

/** Create a person and upload their reference photos. */
export async function createKnownPerson(input: {
  name: string
  role?: string
  note?: string
  photos: NewPhoto[]
}): Promise<KnownPerson> {
  const name = input.name.trim()
  if (!name) throw new Error('name required')
  const photos = input.photos.slice(0, MAX_PHOTOS_PER_PERSON)
  if (photos.length === 0) throw new Error('at least one reference photo required')

  const row = (await db.agentKnownPerson.create({
    data: {
      businessId: BUSINESS_ID,
      name,
      role: (input.role ?? 'staff').trim() || 'staff',
      note: input.note?.trim() || null,
      photoPaths: [],
    },
  })) as KnownPersonRow

  const paths: string[] = []
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i]!
    const objectPath = `known-people/${row.id}/${Date.now()}-${i}.${extForMime(p.mimeType)}`
    await agentStorageUpload(objectPath, Buffer.from(p.base64, 'base64'), p.mimeType, { upsert: true })
    paths.push(objectPath)
  }

  const updated = (await db.agentKnownPerson.update({
    where: { id: row.id },
    data: { photoPaths: paths },
  })) as KnownPersonRow
  return toKnownPerson(updated)
}

/** Append reference photos to an existing person (capped at MAX_PHOTOS_PER_PERSON). */
export async function addKnownPersonPhotos(personId: string, photos: NewPhoto[]): Promise<KnownPerson> {
  const row = (await db.agentKnownPerson.findUnique({ where: { id: personId } })) as KnownPersonRow | null
  if (!row) throw new Error('person not found')
  const existing = toKnownPerson(row).photoPaths
  const room = Math.max(0, MAX_PHOTOS_PER_PERSON - existing.length)
  const toAdd = photos.slice(0, room)
  const paths = [...existing]
  for (let i = 0; i < toAdd.length; i++) {
    const p = toAdd[i]!
    const objectPath = `known-people/${personId}/${Date.now()}-${i}.${extForMime(p.mimeType)}`
    await agentStorageUpload(objectPath, Buffer.from(p.base64, 'base64'), p.mimeType, { upsert: true })
    paths.push(objectPath)
  }
  const updated = (await db.agentKnownPerson.update({
    where: { id: personId },
    data: { photoPaths: paths },
  })) as KnownPersonRow
  return toKnownPerson(updated)
}

/** Replace ALL reference photos (native "ছবি বদল") — old storage objects are
 *  orphan-safe (private bucket), so cleanup failures never block the swap. */
export async function replaceKnownPersonPhotos(personId: string, photos: NewPhoto[]): Promise<KnownPerson> {
  const row = (await db.agentKnownPerson.findUnique({ where: { id: personId } })) as KnownPersonRow | null
  if (!row) throw new Error('person not found')
  const next = photos.slice(0, MAX_PHOTOS_PER_PERSON)
  if (next.length === 0) throw new Error('at least one reference photo required')
  const paths: string[] = []
  for (let i = 0; i < next.length; i++) {
    const p = next[i]!
    const objectPath = `known-people/${personId}/${Date.now()}-${i}.${extForMime(p.mimeType)}`
    await agentStorageUpload(objectPath, Buffer.from(p.base64, 'base64'), p.mimeType, { upsert: true })
    paths.push(objectPath)
  }
  const updated = (await db.agentKnownPerson.update({
    where: { id: personId },
    data: { photoPaths: paths },
  })) as KnownPersonRow
  return toKnownPerson(updated)
}

export async function updateKnownPerson(
  personId: string,
  data: { name?: string; role?: string; active?: boolean; note?: string },
): Promise<KnownPerson> {
  const updated = (await db.agentKnownPerson.update({
    where: { id: personId },
    data: {
      ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      ...(data.role !== undefined ? { role: data.role.trim() || 'staff' } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.note !== undefined ? { note: data.note.trim() || null } : {}),
    },
  })) as KnownPersonRow
  return toKnownPerson(updated)
}

export async function deleteKnownPerson(personId: string): Promise<void> {
  // Row first (source of truth); storage objects are private and orphan-safe,
  // so a failed cleanup never blocks the delete.
  await db.agentKnownPerson.delete({ where: { id: personId } })
}

/** Signed thumbnail URLs for the admin page (personId → first-photo URL). */
export async function knownPeopleThumbUrls(people: KnownPerson[]): Promise<Record<string, string>> {
  const firstPaths = people.map((p) => p.photoPaths[0]).filter((p): p is string => !!p)
  const signed = await agentStorageSignedUrls(firstPaths, 3600).catch(() => ({} as Record<string, string>))
  const out: Record<string, string> = {}
  for (const p of people) {
    const first = p.photoPaths[0]
    if (first && signed[first]) out[p.id] = signed[first]!
  }
  return out
}

export interface KnownPersonWithImages {
  id: string
  name: string
  role: string
  images: Array<{ base64: string; mimeType: string }>
}

/**
 * Load active people WITH their reference photo bytes, for a vision match call.
 * A person whose photos all fail to download is skipped (best-effort — one bad
 * storage object must not blind the whole watch).
 */
export async function loadKnownPeopleWithImages(): Promise<KnownPersonWithImages[]> {
  const people = await listKnownPeople()
  const out: KnownPersonWithImages[] = []
  for (const person of people) {
    const images: Array<{ base64: string; mimeType: string }> = []
    for (const path of person.photoPaths.slice(0, MAX_PHOTOS_PER_PERSON)) {
      try {
        const buf = await agentStorageDownload(path)
        const mimeType = path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
        images.push({ base64: buf.toString('base64'), mimeType })
      } catch (err) {
        console.warn('[known-people] photo download failed:', path, err instanceof Error ? err.message : err)
      }
    }
    if (images.length > 0) out.push({ id: person.id, name: person.name, role: person.role, images })
  }
  return out
}
