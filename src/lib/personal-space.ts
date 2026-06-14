import { prisma } from '@/lib/prisma'
import {
  PERSONAL_MODE_SENTINEL,
  PERSONAL_PROJECT_NAME,
} from '@/agent/lib/personal-prompt'

const LEGACY_PERSONAL_NAMES = ['Personal', 'ব্যক্তিগত'] as const

/** Get or create the reserved Personal project. Returns its id. */
export async function ensurePersonalProject(): Promise<string> {
  const existing = await prisma.agentProject.findFirst({
    where: {
      OR: [
        { name: PERSONAL_PROJECT_NAME },
        { systemInstructions: PERSONAL_MODE_SENTINEL },
        { name: { in: [...LEGACY_PERSONAL_NAMES] } },
      ],
    },
    select: { id: true, name: true, systemInstructions: true },
  })

  if (existing) {
    if (
      existing.name !== PERSONAL_PROJECT_NAME
      || existing.systemInstructions !== PERSONAL_MODE_SENTINEL
    ) {
      await prisma.agentProject.update({
        where: { id: existing.id },
        data: {
          name: PERSONAL_PROJECT_NAME,
          description: 'ব্যক্তিগত ও পারিবারিক — personal advisor mode',
          systemInstructions: PERSONAL_MODE_SENTINEL,
        },
      })
    }
    return existing.id
  }

  const created = await prisma.agentProject.create({
    data: {
      name: PERSONAL_PROJECT_NAME,
      description: 'ব্যক্তিগত ও পারিবারিক — personal advisor mode',
      systemInstructions: PERSONAL_MODE_SENTINEL,
    },
  })
  return created.id
}

export function isPersonalProject(
  project?: { name?: string | null; systemInstructions?: string | null } | null,
): boolean {
  if (!project) return false
  if (project.systemInstructions === PERSONAL_MODE_SENTINEL) return true
  const name = project.name?.trim() ?? ''
  return name === PERSONAL_PROJECT_NAME || LEGACY_PERSONAL_NAMES.includes(name as typeof LEGACY_PERSONAL_NAMES[number])
}
