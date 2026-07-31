/**
 * The SAME classifier as src/agent/lib/mac-agent/policy.ts, re-stated here in
 * plain ESM so the daemon has zero build step and zero dependencies.
 *
 * Why a copy instead of an import: this file is the last gate before something
 * runs on the owner's actual machine. It must keep working when the repo isn't
 * built, when node_modules is missing, and — most importantly — it must NOT be
 * something the server can change remotely. A copy that ships with the daemon is
 * a copy an attacker on the server side cannot edit.
 *
 * `mac-agent/__tests__/policy-parity.test.mjs` fails the build if the two copies
 * ever disagree on any case in the shared corpus, so "copy" never means "drift".
 */

export const MAC_EXEC_LIMITS = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputChars: 100_000,
}

export const DEFAULT_ALLOWED_DIRS = [
  '~/alma-erp',
  '~/alma-companion',
  '~/Desktop/alma-lifestyle',
  '~/Documents/Codex',
]

const RED_RULES = [
  { re: /(^|[\s;&|(])(sudo|doas)\b/, code: 'sudo', bn: 'sudo দিয়ে চালানো যাবে না — root ক্ষমতা এজেন্টের হাতে দেওয়া হয় না।' },
  { re: /(^|[\s;&|(])su\s+-?\s*(root|[a-z_][a-z0-9_-]*)?\s*$/, code: 'su', bn: 'ইউজার সুইচ (su) করা যাবে না।' },
  { re: /(^|[\s;&|(])passwd\b/, code: 'passwd', bn: 'পাসওয়ার্ড বদলানোর কমান্ড চালানো যাবে না।' },
  {
    re: /\brm\b[^\n;|&]*\s-[a-z]*[rf][a-z]*\b[^\n;|&]*\s(\/|~|\$HOME|\/Users|\/System|\/Applications|\/Library|\*)(\s|$|\/)/,
    code: 'rm_rf_root',
    bn: 'হোম বা সিস্টেম ফোল্ডার রিকার্সিভ ডিলিট — কোনো অবস্থাতেই না।',
  },
  { re: /\brm\b[^\n;|&]*\s-[a-z]*[rf][a-z]*\s+\/(\s|$)/, code: 'rm_rf_root', bn: 'রুট ডিরেক্টরি ডিলিট — কোনো অবস্থাতেই না।' },
  { re: /(^|[\s;&|(])(diskutil|mkfs(\.\w+)?|newfs(_\w+)?|fdisk|gpt)\b/, code: 'disk_tool', bn: 'ডিস্ক পার্টিশন/ফরম্যাট টুল চালানো যাবে না।' },
  { re: /(^|[\s;&|(])dd\b[^\n]*\bof=/, code: 'dd_write', bn: 'dd দিয়ে র ডিস্ক লেখা যাবে না।' },
  { re: />\s*\/dev\/(disk|rdisk)/, code: 'dev_write', bn: 'ডিস্ক ডিভাইসে সরাসরি লেখা যাবে না।' },
  { re: /(^|[\s;&|(])hdiutil\b[^\n]*\berase\b/, code: 'disk_tool', bn: 'ডিস্ক ইরেজ করা যাবে না।' },
  { re: /(^|[\s;&|(])(shutdown|reboot|halt)\b/, code: 'power', bn: 'Mac বন্ধ/রিস্টার্ট এজেন্ট করবে না — আপনি নিজে করবেন।' },
  { re: /(^|[\s;&|(])(csrutil|spctl|tccutil)\b/, code: 'sip', bn: 'সিস্টেম সিকিউরিটি সেটিং বদলানো যাবে না।' },
  { re: /(^|[\s;&|(])security\s+(dump|find|unlock|add)-/, code: 'keychain', bn: 'Keychain পড়া/খোলা যাবে না।' },
  {
    re: /(\.ssh\/|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\bid_dsa\b|\.aws\/credentials|\.git-credentials|\.npmrc\b|\bAuthKey_\w+\.p8|\.codex\/auth\.json|\.claude\.json|\/auth\.json|\.config\/gh\/|\.netrc\b|\.pgpass\b|\.docker\/config\.json|\.kube\/config|\.gnupg|\.pypirc\b|\.terraformrc\b|credentials\.json|service[-_]account.*\.json|\.pem\b|\.p12\b|\.keystore\b|secrets?\.(json|ya?ml|env|txt))/i,
    code: 'credentials',
    bn: 'কী/পাসওয়ার্ড ফাইল ছোঁয়া যাবে না।',
  },
  { re: /(^|[\s;&|(])(cat|less|more|head|tail|cp|scp|rsync|open)\b[^\n]*\.env(\.|\s|$)/, code: 'credentials', bn: '.env ফাইলের গোপন তথ্য পড়া/পাঠানো যাবে না।' },
  { re: /\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/, code: 'curl_pipe_sh', bn: 'ইন্টারনেট থেকে স্ক্রিপ্ট নামিয়ে সরাসরি চালানো যাবে না।' },
  { re: /(^|[\s;&|(])eval\b/, code: 'eval', bn: 'eval দিয়ে লুকানো কমান্ড চালানো যাবে না।' },
  { re: /\bbase64\b[^\n]*(-d|--decode)[^\n]*\|/, code: 'base64_pipe', bn: 'base64 ডিকোড করে চালানো যাবে না।' },
  { re: /(^|[\s;&|(])launchctl\b/, code: 'launchctl', bn: 'ব্যাকগ্রাউন্ড সার্ভিস লোড/আনলোড করা যাবে না।' },
  { re: /(alma-mac-agent|com\.alma\.macagent)/, code: 'self_target', bn: 'এজেন্ট নিজের সার্ভিস ফাইল বদলাতে পারবে না।' },
  { re: /(^|[\s;&|(])(killall|pkill)\b/, code: 'kill_broad', bn: 'একসাথে প্রসেস মেরে ফেলার কমান্ড চালানো যাবে না।' },
  { re: /(^|[\s;&|(])chmod\b[^\n]*\s-R\b[^\n]*\s(777|a\+rwx)/, code: 'chmod_world', bn: 'পুরো ফোল্ডার সবার জন্য খুলে দেওয়া যাবে না।' },
  { re: /(^|[\s;&|(])chown\b[^\n]*\s-R\b[^\n]*\s(\/|~|\$HOME)(\s|$|\/)/, code: 'chown_home', bn: 'হোম/রুট ফোল্ডারের মালিকানা বদলানো যাবে না।' },
  { re: /(^|[\s;&|(])crontab\s+-r\b/, code: 'crontab_wipe', bn: 'সব শিডিউল জব মুছে ফেলা যাবে না।' },
  { re: /(^|[\s;&|(])git\b[^\n]*\bpush\b[^\n]*(--force(?!-with-lease)|\s-f(\s|$))/, code: 'force_push', bn: 'force push এজেন্ট করবে না — ইতিহাস মুছে যেতে পারে, আপনি নিজে করবেন।' },
  { re: /:\(\)\s*\{.*\|.*&.*\}/, code: 'fork_bomb', bn: 'ক্ষতিকর লুপ কমান্ড।' },
]

const GREEN_SUBCOMMANDS = {
  git: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'stash', 'describe', 'blame', 'shortlog'],
  npm: ['ls', 'view', 'outdated', '-v', '--version'],
  pnpm: ['ls', '-v', '--version'],
  yarn: ['-v', '--version'],
  gh: ['pr', 'run', 'issue', 'repo', 'api', 'auth'],
}

const GREEN_NPM_SCRIPTS = ['test', 'build', 'lint', 'typecheck', 'test:unit', 'check']
const GREEN_GH_VERBS = ['view', 'list', 'checks', 'status', 'diff']

const GREEN_SIMPLE = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'grep', 'rg', 'echo', 'date', 'uname', 'whoami', 'sw_vers', 'which', 'type',
  'basename', 'dirname', 'realpath',
])

const GREEN_VERSION_ONLY = new Set(['node', 'python3', 'python', 'ruby', 'deno', 'bun'])
const VERSION_FLAGS = ['-v', '--version', '-V']

const WRITE_FLAGS = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint'],
  rg: ['--files-with-matches-replace'],
  node: ['-e', '--eval', '-p', '--print'],
  python3: ['-c'],
  eslint: ['--fix', '--fix-type', '--output-file'],
  prettier: ['-w', '--write'],
  vitest: ['-u', '--update'],
  tsc: ['--build', '-b', '--outDir', '--declaration'],
}

const UNIVERSAL_WRITE_FLAGS = [
  '--fix',
  '--write',
  '--in-place',
  '--overwrite',
  '--delete',
  '--force',
  '--save',
  '--output-file',
]

const METACHARACTERS = /[;&|<>`$(){}\n\\*?\[\]]/

function stripEnvPrefix(tokens) {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  return tokens.slice(i)
}

function toolName(token) {
  return (token.split('/').pop() ?? token).trim()
}

export function splitSegments(command) {
  return command
    .split(/(?:\|\||&&|[;\n|&])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeForDanger(text) {
  return text.replace(/\$\{(\w+)\}/g, '$$$1').replace(/["']/g, '')
}

function firstRedRule(text) {
  const normalized = normalizeForDanger(text)
  for (const rule of RED_RULES) {
    if (rule.re.test(text) || rule.re.test(normalized)) return rule
  }
  return null
}

/** Any argument pointing outside the working directory (see policy.ts). */
function hasEscapingPathArg(args) {
  return args.some((raw) => {
    const a = raw.replace(/^["']|["']$/g, '')
    return a.startsWith('/') || a.startsWith('~') || a.includes('..')
  })
}

function isGreenSegment(segment) {
  if (METACHARACTERS.test(segment)) return false

  const tokens = stripEnvPrefix(segment.split(/\s+/).filter(Boolean))
  if (tokens.length === 0) return false

  const tool = toolName(tokens[0])
  const args = tokens.slice(1)

  const banned = WRITE_FLAGS[tool]
  if (banned && args.some((a) => banned.includes(a))) return false
  if (args.some((a) => UNIVERSAL_WRITE_FLAGS.includes(a))) return false
  if (hasEscapingPathArg(args)) return false

  if (GREEN_VERSION_ONLY.has(tool)) {
    return args.length === 1 && VERSION_FLAGS.includes(args[0])
  }

  if (tool === 'find') return true
  if (GREEN_SIMPLE.has(tool)) return true

  const subs = GREEN_SUBCOMMANDS[tool]
  if (!subs) return false
  const sub = args[0]
  if (!sub || !subs.includes(sub)) return false

  if (tool === 'git' && sub === 'branch') {
    return args.slice(1).every((a) => ['-a', '--all', '-r', '-l', '--list', '-v', '-vv', '--verbose'].includes(a))
  }
  if (tool === 'git' && sub === 'stash') return args[1] === 'list'
  if (tool === 'git' && sub === 'remote') return args[1] === '-v' || args.length === 1
  if ((tool === 'npm' || tool === 'pnpm' || tool === 'yarn') && sub === 'run') {
    return args[1] !== undefined && GREEN_NPM_SCRIPTS.includes(args[1])
  }
  if (tool === 'gh') {
    if (sub === 'api' || sub === 'auth') return false
    return args[1] !== undefined && GREEN_GH_VERBS.includes(args[1])
  }

  return true
}

export function classifyCommand(rawCommand, opts = {}) {
  const command = (rawCommand ?? '').trim()

  if (!command) return { level: 'red', code: 'empty', reasonBn: 'কোনো কমান্ড দেওয়া হয়নি।' }
  if (command.length > 4_000) {
    return { level: 'red', code: 'too_long', reasonBn: 'কমান্ডটা অস্বাভাবিক লম্বা — চালানো হবে না।' }
  }

  const whole = firstRedRule(command)
  if (whole) return { level: 'red', code: whole.code, reasonBn: whole.bn }

  const segments = splitSegments(command)
  for (const seg of segments) {
    const hit = firstRedRule(seg)
    if (hit) return { level: 'red', code: hit.code, reasonBn: hit.bn }
  }

  if (opts.cwd) {
    if (opts.cwd.includes('..')) {
      return { level: 'red', code: 'cwd_traversal', reasonBn: 'ফোল্ডারের পথে `..` থাকলে চালানো হবে না।' }
    }
    const allowed = opts.allowedDirs ?? DEFAULT_ALLOWED_DIRS
    const inside = allowed.some((dir) => opts.cwd === dir || opts.cwd.startsWith(`${dir}/`))
    if (!inside) {
      return {
        level: 'amber',
        code: 'cwd_outside_allowlist',
        reasonBn: 'অনুমোদিত ফোল্ডারের বাইরে চালাতে চাইছে — আপনার অনুমতি লাগবে।',
      }
    }
  }

  const allGreen = segments.length > 0 && segments.every(isGreenSegment)
  if (allGreen) {
    return { level: 'green', code: 'read_only', reasonBn: 'শুধু পড়ার কমান্ড — নিজে থেকেই চালানো হলো।' }
  }

  return { level: 'amber', code: 'needs_approval', reasonBn: 'এই কমান্ডটা আপনার অনুমতি ছাড়া চালাবো না।' }
}

export function resolveTimeoutMs(requested) {
  if (!Number.isFinite(requested) || !requested || requested <= 0) return MAC_EXEC_LIMITS.defaultTimeoutMs
  return Math.min(Math.round(requested), MAC_EXEC_LIMITS.maxTimeoutMs)
}

export function capOutput(text) {
  if (text.length <= MAC_EXEC_LIMITS.maxOutputChars) return text
  return `${text.slice(0, MAC_EXEC_LIMITS.maxOutputChars)}\n…(আউটপুট বড় হওয়ায় কেটে দেওয়া হয়েছে)`
}
