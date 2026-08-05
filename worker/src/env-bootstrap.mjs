/**
 * MUST be the first import in worker/src/index.mjs.
 * ESM evaluates all imports before module body — dotenv here runs before other modules load.
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const configuredEnvFile = String(process.env.WORKER_ENV_FILE ?? '').trim()
dotenv.config({
  path: configuredEnvFile || join(__dir, '../.env'),
  override: true,
})
