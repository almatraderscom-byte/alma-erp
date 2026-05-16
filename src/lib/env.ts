const BASE_REQUIRED_SERVER_ENV = ['DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'NEXT_PUBLIC_API_URL'] as const
const PRODUCTION_REQUIRED_SERVER_ENV = ['API_SECRET', 'CRON_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM'] as const

export function validateEnv() {
  const required = process.env.NODE_ENV === 'production'
    ? [...BASE_REQUIRED_SERVER_ENV, ...PRODUCTION_REQUIRED_SERVER_ENV]
    : [...BASE_REQUIRED_SERVER_ENV]
  const missing = required.filter(key => !process.env[key]?.trim())
  const placeholder = required.filter(key => /REPLACE_|YOUR_/i.test(process.env[key] || ''))
  return {
    ok: missing.length === 0 && placeholder.length === 0,
    missing,
    placeholder,
  }
}

export function assertEnv() {
  const result = validateEnv()
  if (!result.ok) {
    throw new Error(`Environment invalid. Missing: ${result.missing.join(', ') || 'none'}; placeholders: ${result.placeholder.join(', ') || 'none'}`)
  }
  return result
}
