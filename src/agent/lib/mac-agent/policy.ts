/**
 * M1 — the safety core of Mac control: what may run on the owner's own Mac.
 *
 * The agent can ask for a shell command. This module decides, deterministically
 * and with no model in the loop, which of three things happens:
 *
 *   GREEN — runs immediately. A short allowlist of read-only inspection commands
 *           the owner asks for many times a day (git status, npm test, ls).
 *   AMBER — the exact command text goes to the owner's phone as an approval card;
 *           nothing runs until he taps ✅.
 *   RED   — refused outright. NOT approvable — no card is even offered, because a
 *           tap is a bad place to defend against `sudo rm -rf ~`.
 *
 * Design rules that matter more than the lists themselves:
 *
 * 1. **Worst segment wins.** A shell line is split on every separator (`;`, `&&`,
 *    `||`, `|`, newline) and each segment is judged on its own. `git status; rm -rf ~`
 *    must never inherit `git status`'s green.
 * 2. **Obfuscation is never GREEN.** Command substitution, `eval`, backticks and
 *    base64 pipes hide the real command from the classifier, so they can only ever
 *    be AMBER (owner reads the literal text) or RED — never auto-run.
 * 3. **RED is scanned against the WHOLE line too**, not just parsed segments, so a
 *    quoting trick that defeats the splitter still trips the dangerous-pattern net.
 * 4. **This runs twice** — once here on the server before enqueueing, and again
 *    inside the Mac daemon before executing. A compromised or buggy server still
 *    cannot make the daemon run a RED command (defence in depth; the daemon is the
 *    thing standing next to the owner's files).
 *
 * Nothing here is owner-tunable on purpose: an env var or KV row that widens the
 * green list is exactly the thing an attacker (or a confused head model) would go
 * for. Widening requires a code change, review, and a deploy.
 */

export type PolicyLevel = 'green' | 'amber' | 'red'

export interface PolicyVerdict {
  level: PolicyLevel
  /** Owner-readable Bangla reason — shown on the card or in the refusal. */
  reasonBn: string
  /** Stable machine reason for logs/tests. */
  code: string
}

/** Hard caps. A command that asks for more is clamped, never granted. */
export const MAC_EXEC_LIMITS = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  /** Output beyond this is truncated with a marker — protects the DB row and the head's context. */
  maxOutputChars: 100_000,
} as const

/**
 * Directories the daemon will ever set as a working directory. Anything else is
 * not auto-runnable (falls to AMBER), so a stray `cd /` can't quietly become a
 * green `ls`. Paths are prefixes, matched after `~` expansion by the caller.
 */
export const DEFAULT_ALLOWED_DIRS = [
  '~/alma-erp',
  '~/alma-companion',
  '~/Desktop/alma-lifestyle',
  '~/Documents/Codex',
] as const

// ---------------------------------------------------------------------------
// RED — refused, never approvable
// ---------------------------------------------------------------------------

interface DangerRule {
  re: RegExp
  code: string
  bn: string
}

/**
 * Patterns that end the conversation. Each is deliberately broad: a false RED
 * costs the owner one manual command in his own terminal, a false GREEN/AMBER
 * costs him his machine.
 */
const RED_RULES: DangerRule[] = [
  // Privilege escalation. `sudo` anywhere in the line, in any segment.
  { re: /(^|[\s;&|(])(sudo|doas)\b/, code: 'sudo', bn: 'sudo দিয়ে চালানো যাবে না — root ক্ষমতা এজেন্টের হাতে দেওয়া হয় না।' },
  { re: /(^|[\s;&|(])su\s+-?\s*(root|[a-z_][a-z0-9_-]*)?\s*$/, code: 'su', bn: 'ইউজার সুইচ (su) করা যাবে না।' },
  { re: /(^|[\s;&|(])passwd\b/, code: 'passwd', bn: 'পাসওয়ার্ড বদলানোর কমান্ড চালানো যাবে না।' },

  // Recursive delete of a home / system / wildcard root.
  {
    re: /\brm\b[^\n;|&]*\s-[a-z]*[rf][a-z]*\b[^\n;|&]*\s(\/|~|\$HOME|\/Users|\/System|\/Applications|\/Library|\*)(\s|$|\/)/,
    code: 'rm_rf_root',
    bn: 'হোম বা সিস্টেম ফোল্ডার রিকার্সিভ ডিলিট — কোনো অবস্থাতেই না।',
  },
  { re: /\brm\b[^\n;|&]*\s-[a-z]*[rf][a-z]*\s+\/(\s|$)/, code: 'rm_rf_root', bn: 'রুট ডিরেক্টরি ডিলিট — কোনো অবস্থাতেই না।' },

  // Disk / filesystem level destruction.
  { re: /(^|[\s;&|(])(diskutil|mkfs(\.\w+)?|newfs(_\w+)?|fdisk|gpt)\b/, code: 'disk_tool', bn: 'ডিস্ক পার্টিশন/ফরম্যাট টুল চালানো যাবে না।' },
  { re: /(^|[\s;&|(])dd\b[^\n]*\bof=/, code: 'dd_write', bn: 'dd দিয়ে র ডিস্ক লেখা যাবে না।' },
  { re: />\s*\/dev\/(disk|rdisk)/, code: 'dev_write', bn: 'ডিস্ক ডিভাইসে সরাসরি লেখা যাবে না।' },
  { re: /(^|[\s;&|(])hdiutil\b[^\n]*\berase\b/, code: 'disk_tool', bn: 'ডিস্ক ইরেজ করা যাবে না।' },

  // Power / OS state.
  { re: /(^|[\s;&|(])(shutdown|reboot|halt)\b/, code: 'power', bn: 'Mac বন্ধ/রিস্টার্ট এজেন্ট করবে না — আপনি নিজে করবেন।' },

  // System-integrity and privacy controls.
  { re: /(^|[\s;&|(])(csrutil|spctl|tccutil)\b/, code: 'sip', bn: 'সিস্টেম সিকিউরিটি সেটিং বদলানো যাবে না।' },
  { re: /(^|[\s;&|(])security\s+(dump|find|unlock|add)-/, code: 'keychain', bn: 'Keychain পড়া/খোলা যাবে না।' },

  // Credential material. Reading OR writing — a leak is as bad as a wipe.
  // Widened after review: the first list missed `~/.config/gh/hosts.yml`, which
  // holds a live GitHub OAuth token, and several equally ordinary ones.
  {
    re: /(\.ssh\/|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\bid_dsa\b|\.aws\/credentials|\.git-credentials|\.npmrc\b|\bAuthKey_\w+\.p8|\.codex\/auth\.json|\.claude\.json|\/auth\.json|\.config\/gh\/|\.netrc\b|\.pgpass\b|\.docker\/config\.json|\.kube\/config|\.gnupg|\.pypirc\b|\.terraformrc\b|credentials\.json|service[-_]account.*\.json|\.pem\b|\.p12\b|\.keystore\b|secrets?\.(json|ya?ml|env|txt))/i,
    code: 'credentials',
    bn: 'কী/পাসওয়ার্ড ফাইল ছোঁয়া যাবে না।',
  },
  { re: /(^|[\s;&|(])(cat|less|more|head|tail|cp|scp|rsync|open)\b[^\n]*\.env(\.|\s|$)/, code: 'credentials', bn: '.env ফাইলের গোপন তথ্য পড়া/পাঠানো যাবে না।' },

  // Remote code execution — the classic "curl | sh".
  { re: /\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/, code: 'curl_pipe_sh', bn: 'ইন্টারনেট থেকে স্ক্রিপ্ট নামিয়ে সরাসরি চালানো যাবে না।' },
  { re: /(^|[\s;&|(])eval\b/, code: 'eval', bn: 'eval দিয়ে লুকানো কমান্ড চালানো যাবে না।' },
  { re: /\bbase64\b[^\n]*(-d|--decode)[^\n]*\|/, code: 'base64_pipe', bn: 'base64 ডিকোড করে চালানো যাবে না।' },

  // Self-preservation: the agent may not disable, unload, or edit its own daemon.
  { re: /(^|[\s;&|(])launchctl\b/, code: 'launchctl', bn: 'ব্যাকগ্রাউন্ড সার্ভিস লোড/আনলোড করা যাবে না।' },
  { re: /(alma-mac-agent|com\.alma\.macagent)/, code: 'self_target', bn: 'এজেন্ট নিজের সার্ভিস ফাইল বদলাতে পারবে না।' },
  { re: /(^|[\s;&|(])(killall|pkill)\b/, code: 'kill_broad', bn: 'একসাথে প্রসেস মেরে ফেলার কমান্ড চালানো যাবে না।' },

  // Ownership / permission sweeps over a whole tree.
  { re: /(^|[\s;&|(])chmod\b[^\n]*\s-R\b[^\n]*\s(777|a\+rwx)/, code: 'chmod_world', bn: 'পুরো ফোল্ডার সবার জন্য খুলে দেওয়া যাবে না।' },
  { re: /(^|[\s;&|(])chown\b[^\n]*\s-R\b[^\n]*\s(\/|~|\$HOME)(\s|$|\/)/, code: 'chown_home', bn: 'হোম/রুট ফোল্ডারের মালিকানা বদলানো যাবে না।' },

  // Scheduled-job wipe and history rewrite of shared branches.
  { re: /(^|[\s;&|(])crontab\s+-r\b/, code: 'crontab_wipe', bn: 'সব শিডিউল জব মুছে ফেলা যাবে না।' },
  { re: /(^|[\s;&|(])git\b[^\n]*\bpush\b[^\n]*(--force(?!-with-lease)|\s-f(\s|$))/, code: 'force_push', bn: 'force push এজেন্ট করবে না — ইতিহাস মুছে যেতে পারে, আপনি নিজে করবেন।' },

  // Fork bomb.
  { re: /:\(\)\s*\{.*\|.*&.*\}/, code: 'fork_bomb', bn: 'ক্ষতিকর লুপ কমান্ড।' },
]

// ---------------------------------------------------------------------------
// GREEN — auto-run, read-only inspection
// ---------------------------------------------------------------------------

/**
 * Tools whose FIRST argument decides safety. `git status` is read-only, `git push`
 * is not, so a bare tool name is never enough.
 */
const GREEN_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'stash', 'describe', 'blame', 'shortlog'],
  // Package managers: version/metadata reads only. `npm test` and `npm run build`
  // execute whatever package.json says — in this repo `build` already deletes
  // cache files — so they are state-changing by definition and now take a tap
  // (Codex review round 2). Same reasoning retired cargo/go/npx build+test.
  npm: ['ls', 'view', 'outdated', '-v', '--version'],
  pnpm: ['ls', '-v', '--version'],
  yarn: ['-v', '--version'],
  gh: ['pr', 'run', 'issue', 'repo', 'api', 'auth'],
}

/** `npm run <script>` — only these scripts auto-run; anything else needs a tap. */
const GREEN_NPM_SCRIPTS = ['test', 'build', 'lint', 'typecheck', 'test:unit', 'check'] as const

/** `gh <sub> <verb>` — read-only verbs only (never `pr merge`, never `run cancel`). */
const GREEN_GH_VERBS = ['view', 'list', 'checks', 'status', 'diff'] as const

/** Single-word tools that only ever read. */
const GREEN_SIMPLE = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'grep', 'rg', 'echo', 'date', 'uname', 'whoami', 'sw_vers', 'which', 'type',
  'basename', 'dirname', 'realpath',
])

/**
 * Interpreters. `node -v` is a harmless capability check; `node script.js` runs
 * whatever that file says, which is the entire machine. Caught by an early test —
 * having them in the plain read-only set auto-ran arbitrary code.
 */
const GREEN_VERSION_ONLY = new Set(['node', 'python3', 'python', 'ruby', 'deno', 'bun'])
const VERSION_FLAGS = ['-v', '--version', '-V']

/** For the read-only tools above, flags that make them NOT read-only. */
const WRITE_FLAGS: Record<string, readonly string[]> = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint'],
  rg: ['--files-with-matches-replace'],
  node: ['-e', '--eval', '-p', '--print'],
  python3: ['-c'],
  // `eslint --fix` rewrites the project. Caught in review: it was green purely
  // because the executable name was on the list.
  eslint: ['--fix', '--fix-type', '--output-file'],
  prettier: ['-w', '--write'],
  vitest: ['-u', '--update'],
  tsc: ['--build', '-b', '--outDir', '--declaration'],
}

/**
 * Flags that turn a reader into a writer on almost any tool. Applied to EVERY
 * green candidate, not just the ones with a bespoke list above, so a tool added
 * later cannot quietly inherit a write mode. Deliberately excludes ambiguous
 * short flags like `-i` (grep's ignore-case) and `-o` (grep's only-matching) —
 * a false amber costs a tap, a false green costs the owner his files.
 */
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

/** Shell syntax that hides the real command from this classifier. */
// Includes glob characters: the shell expands `.e*` to `.env` AFTER we
// classify, so a green `cat` was reading secrets (Codex review round 2). A
// literal-only command is the only kind we can actually judge.
const METACHARACTERS = /[;&|<>`$(){}\n\\*?\[\]]/

// ---------------------------------------------------------------------------

/** Strip leading `FOO=bar` env assignments so `FOO=1 rm -rf ~` still parses as rm. */
function stripEnvPrefix(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  return tokens.slice(i)
}

/** `/usr/bin/git` and `git` are the same tool for policy purposes. */
function toolName(token: string): string {
  const base = token.split('/').pop() ?? token
  return base.trim()
}

/**
 * Split a shell line into independently-judged segments. Deliberately simple and
 * quote-unaware: over-splitting can only make the verdict STRICTER (more segments
 * to satisfy), never looser, and the whole-line RED scan backs it up.
 */
export function splitSegments(command: string): string[] {
  return command
    .split(/(?:\|\||&&|[;\n|&])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Shell forms that mean the same thing but do not look the same to a regex.
 * `rm -rf "$HOME"`, `rm -rf ${HOME}` and `rm -rf '~'` all wipe the home folder,
 * and all three slipped past the unquoted-only pattern (found in review).
 *
 * Quote characters are simply removed and `${VAR}` is folded to `$VAR`. Doing
 * this can only ever make a command look MORE dangerous, never less — so a
 * mistake here costs an unnecessary refusal, not a wiped disk.
 */
function normalizeForDanger(text: string): string {
  return text
    .replace(/\$\{(\w+)\}/g, '$$$1')
    .replace(/["']/g, '')
}

/** First RED rule the text trips, or null. Checks the literal AND the unquoted form. */
function firstRedRule(text: string): DangerRule | null {
  const normalized = normalizeForDanger(text)
  for (const rule of RED_RULES) {
    if (rule.re.test(text) || rule.re.test(normalized)) return rule
  }
  return null
}

/**
 * Does any argument point OUTSIDE the working directory?
 *
 * This is what stops `cat ~/.config/gh/hosts.yml` — a green `cat` reading a live
 * GitHub token — without needing to enumerate every secret file that exists. The
 * cwd allowlist only ever constrained where a command RUNS; an absolute or
 * tilde-prefixed argument walks straight out of it. A relative path cannot,
 * because `..` is refused separately.
 */
function hasEscapingPathArg(args: readonly string[]): boolean {
  return args.some((raw) => {
    const a = raw.replace(/^["']|["']$/g, '')
    return a.startsWith('/') || a.startsWith('~') || a.includes('..')
  })
}

/** Is this ONE already-split segment a green read-only command? */
function isGreenSegment(segment: string): boolean {
  if (METACHARACTERS.test(segment)) return false

  const tokens = stripEnvPrefix(segment.split(/\s+/).filter(Boolean))
  if (tokens.length === 0) return false

  const tool = toolName(tokens[0])
  const args = tokens.slice(1)

  // A tool that reads but can be flipped into writing by a flag.
  const banned = WRITE_FLAGS[tool]
  if (banned && args.some((a) => banned.includes(a))) return false
  if (args.some((a) => UNIVERSAL_WRITE_FLAGS.includes(a))) return false

  // Reading (or listing, or grepping) somewhere other than the project folder is
  // never automatic — that is where the owner's secrets live.
  if (hasEscapingPathArg(args)) return false

  // Interpreters: only a version probe, never a script or an inline program.
  if (GREEN_VERSION_ONLY.has(tool)) {
    return args.length === 1 && VERSION_FLAGS.includes(args[0])
  }

  // `find` is read-only only without its action flags (checked above).
  if (tool === 'find') return true

  if (GREEN_SIMPLE.has(tool)) return true

  const subs = GREEN_SUBCOMMANDS[tool]
  if (!subs) return false
  const sub = args[0]
  if (!sub || !subs.includes(sub)) return false

  // Tool-specific second level.
  // Only the LISTING forms of `git branch`. `git branch new-name` creates a ref
  // and `git branch -D x` force-deletes one (Codex review round 2).
  if (tool === 'git' && sub === 'branch') {
    return args.slice(1).every((a) => ['-a', '--all', '-r', '-l', '--list', '-v', '-vv', '--verbose'].includes(a))
  }
  if (tool === 'git' && sub === 'stash') return args[1] === 'list'
  if (tool === 'git' && sub === 'remote') return args[1] === '-v' || args.length === 1
  if ((tool === 'npm' || tool === 'pnpm' || tool === 'yarn') && sub === 'run') {
    return args[1] !== undefined && (GREEN_NPM_SCRIPTS as readonly string[]).includes(args[1])
  }
  if (tool === 'gh') {
    // `gh api` can POST; only bare GETs are read-only, and that needs arg analysis
    // we deliberately don't do here — send it for a tap instead.
    if (sub === 'api' || sub === 'auth') return false
    return args[1] !== undefined && (GREEN_GH_VERBS as readonly string[]).includes(args[1])
  }

  return true
}

/**
 * A move or copy that can silently OVERWRITE is refused, not merely carded.
 *
 * Found live on 2026-08-03. `mac-file-organizer` exists to tidy his Downloads
 * without ever losing a file, and its SKILL.md says "always `mv -n`" in three
 * places. On two consecutive live runs the head still proposed a bare
 * `mv ~/Downloads/*.pdf ~/Downloads/Reports/` — which, with a same-named file
 * at the destination, destroys the original with no undo and no Trash. Writing
 * the rule more loudly did not change the behaviour the second time either.
 *
 * So it moves to where every rule in this system that has actually held lives:
 * the classifier. RED rather than AMBER on purpose — this is not a risk the
 * owner should be asked to accept in a tap, and the refusal is *repairable*:
 * add `-n` and the same command goes through as a normal approval card.
 */
function clobberingMove(segment: string): PolicyVerdict | null {
  // Quotes are stripped before tokenizing: a perfectly ordinary wrapper —
  // `sh -c 'mv "$src" "$dst"'` — yields the token `'mv`, which an exact
  // comparison walks straight past (Codex round 3). Removing quote characters
  // can only ever make more things LOOK like a move, never fewer.
  const unquoted = segment.replace(/["'`]/g, ' ')
  const tokens = stripEnvPrefix(unquoted.split(/\s+/).filter(Boolean))
  // Not just the FIRST token: `find ~/Downloads -iname '*.pdf' -exec mv {} DIR/ \;`
  // moves every match and the mv is buried mid-line (the head proposed exactly
  // that once the first-token-only version shipped). Any bare `mv`/`cp` word in
  // the segment is checked, wherever it sits.
  for (let i = 0; i < tokens.length; i++) {
    const tool = toolName(tokens[i])
    if (tool !== 'mv' && tool !== 'cp') continue
    // Its own arguments end at the exec terminator, not at the line end.
    const rest: string[] = []
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]
      if (t === ';' || t === '\\;' || t === '+') break
      rest.push(t)
    }
    const guarded = rest.some((t) => {
      if (t === '--no-clobber' || t === '--interactive') return true
      return /^-[a-zA-Z]*[ni][a-zA-Z]*$/.test(t)
    })
    if (guarded) continue
    return {
      level: 'red',
      code: 'clobbering_move',
      reasonBn:
        `${tool} চালানো হয়নি — গন্তব্যে একই নামের ফাইল থাকলে সেটা চাপা পড়ে চিরতরে হারিয়ে যেত। `
        + `\`${tool} -n\` (no-clobber) দিয়ে আবার দাও; তখন কার্ড হয়ে আপনার কাছে যাবে।`,
    }
  }
  return null
}

export interface ClassifyOptions {
  /** Resolved (tilde-expanded) working directory the command would run in. */
  cwd?: string
  /** Resolved allowed directory prefixes. Defaults to DEFAULT_ALLOWED_DIRS. */
  allowedDirs?: readonly string[]
}

/**
 * The whole decision. Pure — no I/O, no clock, no model — so it is fully unit
 * testable and identical on the server and inside the daemon.
 */
export function classifyCommand(rawCommand: string, opts: ClassifyOptions = {}): PolicyVerdict {
  const command = (rawCommand ?? '').trim()

  if (!command) {
    return { level: 'red', code: 'empty', reasonBn: 'কোনো কমান্ড দেওয়া হয়নি।' }
  }
  if (command.length > 4_000) {
    return { level: 'red', code: 'too_long', reasonBn: 'কমান্ডটা অস্বাভাবিক লম্বা — চালানো হবে না।' }
  }

  // 1. RED on the whole line first: a quoting trick that beats the splitter still
  //    has to get past this.
  const whole = firstRedRule(command)
  if (whole) return { level: 'red', code: whole.code, reasonBn: whole.bn }

  // 2. RED per segment (patterns anchored at a segment start, e.g. a bare `sudo`
  //    that only begins after a `&&`).
  const segments = splitSegments(command)
  for (const seg of segments) {
    const hit = firstRedRule(seg)
    if (hit) return { level: 'red', code: hit.code, reasonBn: hit.bn }
  }

  // 2b. An overwriting mv/cp — a data-loss shape the prompt could not stop.
  for (const seg of segments) {
    const clobber = clobberingMove(seg)
    if (clobber) return clobber
  }

  // 3. A working directory outside the allowlist never auto-runs. `..` escapes are
  //    refused outright rather than normalised — normalising is where bugs live.
  if (opts.cwd) {
    if (opts.cwd.includes('..')) {
      return { level: 'red', code: 'cwd_traversal', reasonBn: 'ফোল্ডারের পথে `..` থাকলে চালানো হবে না।' }
    }
    const allowed = opts.allowedDirs ?? DEFAULT_ALLOWED_DIRS
    const inside = allowed.some((dir) => opts.cwd === dir || opts.cwd!.startsWith(`${dir}/`))
    if (!inside) {
      return {
        level: 'amber',
        code: 'cwd_outside_allowlist',
        reasonBn: 'অনুমোদিত ফোল্ডারের বাইরে চালাতে চাইছে — আপনার অনুমতি লাগবে।',
      }
    }
  }

  // 4. GREEN only when EVERY segment is independently green.
  const allGreen = segments.length > 0 && segments.every(isGreenSegment)
  if (allGreen) {
    return { level: 'green', code: 'read_only', reasonBn: 'শুধু পড়ার কমান্ড — নিজে থেকেই চালানো হলো।' }
  }

  return {
    level: 'amber',
    code: 'needs_approval',
    reasonBn: 'এই কমান্ডটা আপনার অনুমতি ছাড়া চালাবো না।',
  }
}

/**
 * Redact credential PATHS out of command output before the head ever sees it.
 *
 * The RED rules stop a command that NAMES a secret file. They cannot stop a
 * command whose output happens to LIST one: `mdfind key`, `find ~ -name "*.pem"`
 * and `ls -R ~` are all ordinary approval-gated commands whose stdout can carry
 * `~/.ssh/id_ed25519` straight into the model's context (Codex, on a skill file
 * of mine that claimed this was already blocked in code — it was not).
 *
 * Paths only, and only the line they appear on. This is not a content scanner:
 * it removes the pointer, not the file, and says so where it removed something
 * so nobody — model or owner — is left thinking the listing was complete.
 */
const SENSITIVE_PATH_RE =
  /(^|[\s:"'=])((?:[~/][^\s:"']*)?(?:\.ssh\/[^\s:"']*|\.aws\/credentials|\.git-credentials|\.npmrc|\.netrc|\.pgpass|\.gnupg[^\s:"']*|\.config\/gh\/[^\s:"']*|\.kube\/config|\.docker\/config\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|AuthKey_\w+\.p8|[^\s:"']*\.(?:pem|p12|keystore)|[^\s:"']*\.env(?:\.[\w.]+)?|[^\s:"']*service[-_]account[^\s:"']*\.json))/gi

export function redactSensitivePaths(text: string): { text: string; redacted: number } {
  if (!text) return { text, redacted: 0 }
  let redacted = 0
  const out = text.replace(SENSITIVE_PATH_RE, (_m, lead: string) => {
    redacted += 1
    return `${lead}[গোপন ফাইলের পথ — সরানো হয়েছে]`
  })
  return { text: out, redacted }
}

/** Clamp a requested timeout into the allowed band. */
export function resolveTimeoutMs(requested?: number): number {
  if (!Number.isFinite(requested) || !requested || requested <= 0) return MAC_EXEC_LIMITS.defaultTimeoutMs
  return Math.min(Math.round(requested), MAC_EXEC_LIMITS.maxTimeoutMs)
}

/** Truncate captured output, telling the reader that it happened. */
export function capOutput(text: string): string {
  if (text.length <= MAC_EXEC_LIMITS.maxOutputChars) return text
  return `${text.slice(0, MAC_EXEC_LIMITS.maxOutputChars)}\n…(আউটপুট বড় হওয়ায় কেটে দেওয়া হয়েছে)`
}
