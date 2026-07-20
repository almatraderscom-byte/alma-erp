#!/usr/bin/env node
// SPEC-001 — Architecture inventory and request-path map.
// Scans the live repository and emits a deterministic inventory of the request
// path: API zones, agent code, and direct provider/model/tool/database calls.
// Usage: node scripts/architecture/inventory.mjs [--json]
import { walk, rel, read, exists, stableJson } from './_shared.mjs';

const PROVIDER_PATTERNS = [
  ['google-generative', /generativelanguage\.googleapis\.com|@google\/(generative-ai|genai)/],
  ['google-tts', /texttospeech\.googleapis\.com/],
  ['openrouter', /openrouter\.ai/],
  ['anthropic', /api\.anthropic\.com|@anthropic-ai\//],
  ['openai-whisper', /api\.openai\.com/],
  ['telegram', /api\.telegram\.org/],
  ['facebook-graph', /graph\.facebook\.com/],
  ['twilio', /api\.twilio\.com|from ['"]twilio['"]/],
];

const DB_PATTERN = /\bprisma\b|from ['"]@prisma\/client['"]|\.\$queryRaw|\.\$executeRaw/;

function classifyZone(path) {
  if (path.startsWith('src/app/api/agent/')) return 'legacy-agent-api';
  if (path.startsWith('src/app/api/assistant/')) return 'assistant-api';
  if (path.startsWith('src/app/api/')) return 'erp-api';
  if (path.startsWith('src/agent/contracts/')) return 'agent-contracts';
  if (path.startsWith('src/agent/')) return 'agent-code';
  if (path.startsWith('src/lib/')) return 'shared-lib';
  if (path.startsWith('src/app/')) return 'erp-app';
  return 'other';
}

function main() {
  const files = walk('src', { exts: ['.ts', '.tsx', '.mjs', '.js'] });
  const zones = {};
  const providerCalls = {};
  const dbCallers = [];

  for (const abs of files) {
    const path = rel(abs);
    const zone = classifyZone(path);
    zones[zone] = (zones[zone] ?? 0) + 1;

    const src = read(abs);
    for (const [name, re] of PROVIDER_PATTERNS) {
      if (re.test(src)) {
        (providerCalls[name] ??= []).push(path);
      }
    }
    if (DB_PATTERN.test(src)) dbCallers.push(path);
  }

  const inventory = {
    contractVersion: '1.0.0',
    requestPath: [
      'Admission Control Plane',
      'Cost Governor',
      'Context Compiler',
      'Capability Broker',
      'Policy/Approval',
      'Durable Workflow',
      'Secure Tool Gateway',
      'Evidence Verification',
      'Response Gate',
      'Audit + Cost + Evaluation',
    ],
    scanned: { files: files.length },
    zones,
    providerCalls: Object.fromEntries(
      Object.entries(providerCalls).map(([k, v]) => [k, { count: v.length, files: v.slice(0, 25) }]),
    ),
    databaseCallers: { count: dbCallers.length, sample: dbCallers.slice(0, 25) },
    ownedZones: {
      'docs/architecture': exists('docs/architecture'),
      'scripts/architecture': exists('scripts/architecture'),
      'src/agent/contracts': exists('src/agent/contracts'),
    },
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(stableJson(inventory) + '\n');
    return;
  }

  console.log('# AIOS Architecture Inventory');
  console.log(`files scanned: ${inventory.scanned.files}`);
  console.log('\nzones:');
  for (const [z, n] of Object.entries(zones).sort()) console.log(`  ${z}: ${n}`);
  console.log('\nprovider call sites:');
  for (const [k, v] of Object.entries(inventory.providerCalls).sort())
    console.log(`  ${k}: ${v.count}`);
  console.log(`\ndatabase caller files: ${inventory.databaseCallers.count}`);
}

main();
