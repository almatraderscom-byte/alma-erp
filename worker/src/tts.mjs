/**
 * Google TTS helper — bn-IN-Chirp3-HD-Charon voice.
 * Returns MP3 audio as a Buffer.
 */

import { createSign } from 'crypto'

const SENTENCE_ENDS = ['।', '?', '!', '.']

function stripMarkdown(text) {
  return text
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
  try { return JSON.parse(raw) } catch { return null }
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

  const tmpIn  = join(tmpdir(), `alma_tts_${Date.now()}.mp3`)
  const tmpOut = join(tmpdir(), `alma_tts_${Date.now()}.wav`)
  try {
    await writeFile(tmpIn, mp3Buffer)
    await execFileAsync('ffmpeg', [
      '-y', '-i', tmpIn,
      '-ar', '8000', '-ac', '1', '-f', 'wav',
      tmpOut,
    ])
    return await readFile(tmpOut)
  } finally {
    unlink(tmpIn).catch(() => {})
    unlink(tmpOut).catch(() => {})
  }
}
