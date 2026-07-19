/**
 * Standalone CLI for a commit-pinned skill import — NO dotenv (reads process.env, so it
 * runs under `node --env-file=.env` on the box or with a pm2-injected env). Used by the
 * skill-import-smoke workflow so the proof doesn't depend on dev-only deps.
 *
 * Usage: node scripts/skill-import-cli.mjs <repo> <commit> <name> [subdir]
 */
import { runSkillImport } from '../src/skill-import/run.mjs'

const [repo, commit, name, subdir = ''] = process.argv.slice(2)
if (!repo || !commit || !name) {
  console.error('usage: skill-import-cli <repo> <commit> <name> [subdir]')
  process.exit(2)
}

const result = await runSkillImport({ repo, commit, name, subdir })
console.log(JSON.stringify(result))
if (!result.ok) process.exit(1)
