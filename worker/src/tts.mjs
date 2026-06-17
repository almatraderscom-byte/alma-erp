/**
 * Google TTS helper — bn-IN-Chirp3-HD-Charon voice.
 * Returns MP3 audio as a Buffer.
 */

import { createSign } from 'crypto'
import { logCost, calcTtsCostUsd } from './cost-log.mjs'

const SENTENCE_ENDS = ['।', '?', '!', '.']

/**
 * Strip markdown / normalize text for TTS (Google + ElevenLabs).
 */
export function stripMarkdown(text) {
  return text
    // Islamic honorific ligatures → clear Bangla for natural TTS
    .replace(/\uFDFA/g, ' সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম ')
    .replace(/\uFDFB/g, ' জাল্লা জালালুহু ')
    .replace(/\u0639\u0644\u064A\u0647\u0020\u0627\u0644\u0633\u0644\u0627\u0645/g, ' আলাইহিস সালাম ')
    .replace(/\u0631\u0636\u064A\u0020\u0627\u0644\u0644\u0647\u0020\u0639\u0646\u0647/g, ' রাদিয়াল্লাহু আনহু ')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split text into TTS-safe chunks (max 200 chars) at sentence boundaries.
 * @param {string} text
 * @param {number} [maxChars=200]
 * @returns {string[]}
 */
export function splitTextForTts(text, maxChars = 200) {
  const cleaned = stripMarkdown(text)
  if (!cleaned) return []
  if (cleaned.length <= maxChars) return [cleaned]

  const chunks = []
  let remaining = cleaned

  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars)
    let splitAt = -1

    for (const delim of SENTENCE_ENDS) {
      const idx = slice.lastIndexOf(delim)
      if (idx > splitAt) splitAt = idx
    }

    if (splitAt <= 0) {
      splitAt = maxChars
    } else {
      splitAt += 1
    }

    const chunk = remaining.slice(0, splitAt).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

function getCredentials() {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS
  if (!raw) return null
  try { return JSON.parse(raw) } catch (err) {
    console.warn('[tts] GOOGLE_TTS_CREDENTIALS JSON parse failed:', err.message)
    return null
  }
}

async function getAccessToken(creds) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(creds.private_key, 'base64url')
  const jwt = `${header}.${payload}.${signature}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`)
  const data = await res.json()
  return data.access_token
}

async function synthesizeChunk(text, accessToken) {
  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'bn-IN', name: 'bn-IN-Chirp3-HD-Charon' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Google TTS error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return Buffer.from(data.audioContent, 'base64')
}

/**
 * @param {string} text  Raw text (markdown will be stripped)
 * @param {number} [maxChars=600]  Total character budget across all chunks
 * @returns {Promise<Buffer>}  MP3 audio buffer
 */
export async function synthesizeSpeech(text, maxChars = 600) {
  const creds = getCredentials()
  if (!creds) throw new Error('GOOGLE_TTS_CREDENTIALS not set or invalid JSON')

  const cleaned = stripMarkdown(text).slice(0, maxChars)
  const chunks = splitTextForTts(cleaned, 200)
  if (chunks.length === 0) throw new Error('No text to synthesize')

  const accessToken = await getAccessToken(creds)
  const buffers = []

  for (const chunk of chunks) {
    buffers.push(await synthesizeChunk(chunk, accessToken))
  }

  void logCost({
    provider: 'google_tts',
    kind: 'tts',
    units: { characters: cleaned.length, voice: 'bn-IN-Chirp3-HD-Charon' },
    costUsd: calcTtsCostUsd(cleaned.length),
    dedupKey: `tts:worker:${cleaned.length}:${cleaned.slice(0, 24)}`,
  })

  return Buffer.concat(buffers)
}

/**
 * Converts MP3 buffer → 8 kHz mono WAV for Twilio telephony.
 * Requires ffmpeg installed on the VPS.
 * @param {Buffer} mp3Buffer
 * @returns {Promise<Buffer>}  WAV buffer
 */
export async function mp3ToTelephonyWav(mp3Buffer) {
  const { execFile } = await import('child_process')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const { writeFile, readFile, unlink } = await import('fs/promises')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  const ts = Date.now()
  const tmpIn  = join(tmpdir(), `alma_tts_${ts}.mp3`)
  const tmpOut = join(tmpdir(), `alma_tts_${ts}.wav`)
  try {
    await writeFile(tmpIn, mp3Buffer)
    await execFileAsync('ffmpeg', [
      '-y', '-i', tmpIn,
      '-ar', '8000', '-ac', '1', '-f', 'wav',
      tmpOut,
    ], { timeout: 30_000 })
    return await readFile(tmpOut)
  } finally {
    unlink(tmpIn).catch((err) => console.warn('[tts] temp cleanup failed:', tmpIn, err.message))
    unlink(tmpOut).catch((err) => console.warn('[tts] temp cleanup failed:', tmpOut, err.message))
  }
}
