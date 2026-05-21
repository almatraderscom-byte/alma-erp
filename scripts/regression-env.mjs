#!/usr/bin/env node
/**
 * Load regression env from .env.regression.local (gitignored) without logging secrets.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function loadRegressionEnvFiles() {
  for (const name of ['.env.local', '.env', '.env.regression.local']) {
    const path = resolve(root, name)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      const k = t.slice(0, i).trim()
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  }

  if (!process.env.REGRESSION_COOKIE) {
    const cookiePath = resolve(root, '.regression-cookie')
    if (existsSync(cookiePath)) {
      const raw = readFileSync(cookiePath, 'utf8').trim()
      if (raw) process.env.REGRESSION_COOKIE = raw
    }
  }

  if (!process.env.REGRESSION_BASE_URL) {
    process.env.REGRESSION_BASE_URL = 'https://alma-erp-six.vercel.app'
  }
}
