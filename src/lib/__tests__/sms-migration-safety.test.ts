import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

describe('SMS migration safety', () => {
  it('normalizes malformed legacy JSON before the allow-list migration casts it', async () => {
    const migrations = path.join(process.cwd(), 'prisma', 'migrations')
    const sanitizerName = '20260808082500_sanitize_sms_enabled_types_json'
    const allowListName = '20260808083000_enable_penalty_appeal_reviewed_sms'
    expect(sanitizerName.localeCompare(allowListName)).toBeLessThan(0)

    const sql = await readFile(path.join(migrations, sanitizerName, 'migration.sql'), 'utf8')
    expect(sql).toContain('EXCEPTION WHEN invalid_text_representation')
    expect(sql).toContain('SET "enabledTypesJson" = NULL')
  })
})
