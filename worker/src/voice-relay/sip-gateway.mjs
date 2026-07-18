/**
 * Milestone 1 — pure-Node SIP+RTP gateway on the Mac (Bangladesh IP), placing an
 * outbound call through Amber IT and playing a Sarvam Bulbul greeting. Proves
 * SIP register + INVITE(auth) + RTP μ-law out + DID caller-ID, before adding STT.
 *
 * Run:  SARVAM_API_KEY=... node sip-gateway.mjs 01779640373
 */
import dgram from 'node:dgram'
import crypto from 'node:crypto'

const SIP_HOST = process.env.SIP_HOST || '202.4.97.37'
const SIP_PORT = Number(process.env.SIP_PORT || 8190)
const USER = process.env.SIP_USER || ''
const PASS = process.env.SIP_PASS || ''
const CALLERID = process.env.SIP_CALLERID || USER // From-user (some PBXs require the DID)
const SARVAM_KEY = process.env.SARVAM_API_KEY || ''
const TARGET = process.argv[2] || '01779640373'

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const rnd = (n = 8) => crypto.randomBytes(n).toString('hex')

// ── μ-law (G.711) ────────────────────────────────────────────────────────────
const BIAS = 0x84, CLIP = 32635
function pcm16ToMuLawByte(sample) {
  let sign = (sample >> 8) & 0x80
  if (sign) sample = -sample
  if (sample > CLIP) sample = CLIP
  sample += BIAS
  let exp = 7
  for (let m = 0x4000; (sample & m) === 0 && exp > 0; exp--, m >>= 1) {}
  const mant = (sample >> (exp + 3)) & 0x0f
  return ~(sign | (exp << 4) | mant) & 0xff
}
function pcm16ToMuLaw(pcm) {
  const n = pcm.length >> 1, out = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) out[i] = pcm16ToMuLawByte(pcm.readInt16LE(i * 2))
  return out
}
function wavToPcm16(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4)
      if (id === 'data') return buf.subarray(off + 8, off + 8 + size)
      off += 8 + size + (size & 1)
    }
    return buf.subarray(44)
  }
  return buf
}

// ── Sarvam Bulbul TTS → μ-law frames (8 kHz) ─────────────────────────────────
async function ttsMuLaw(text) {
  const r = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language_code: 'bn-IN', model: 'bulbul:v2', speaker: 'anushka', speech_sample_rate: 8000 }),
  })
  const j = await r.json()
  if (!j.audios?.[0]) throw new Error('TTS failed: ' + JSON.stringify(j).slice(0, 120))
  return pcm16ToMuLaw(wavToPcm16(Buffer.from(j.audios[0], 'base64')))
}

// ── SIP client ───────────────────────────────────────────────────────────────
const sip = dgram.createSocket('udp4')
let localIP = '0.0.0.0'
const callId = rnd(12) + '@mac'
const fromTag = rnd(6)
const branch = () => 'z9hG4bK' + rnd(8)
let cseq = 1

function authHeader(method, uri, realm, nonce, hdrName = 'Authorization') {
  const ha1 = md5(`${USER}:${realm}:${PASS}`)
  const ha2 = md5(`${method}:${uri}`)
  const resp = md5(`${ha1}:${nonce}:${ha2}`)
  return `${hdrName}: Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${resp}", algorithm=MD5\r\n`
}

function send(msg) { sip.send(Buffer.from(msg), SIP_PORT, SIP_HOST) }

// Wait for a response matching a CSeq method, resolve with the raw text
const waiters = []
sip.on('message', (buf) => {
  const t = buf.toString()
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].test(t)) { const w = waiters.splice(i, 1)[0]; w.resolve(t) }
  }
})
function expect(test, ms = 8000) {
  return new Promise((resolve, reject) => {
    const w = { test, resolve }
    waiters.push(w)
    setTimeout(() => { const idx = waiters.indexOf(w); if (idx >= 0) { waiters.splice(idx, 1); reject(new Error('SIP timeout')) } }, ms)
  })
}
const status = (t) => parseInt(t.split('\r\n')[0].split(' ')[1], 10)
const header = (t, name) => (t.match(new RegExp(`^${name}:\\s*(.*)$`, 'im')) || [])[1]?.trim()
const digestParams = (t) => {
  const h = header(t, 'WWW-Authenticate') || header(t, 'Proxy-Authenticate') || ''
  const p = {}
  for (const m of h.matchAll(/(\w+)="?([^",]+)"?/g)) p[m[1]] = m[2]
  return { realm: p.realm, nonce: p.nonce, proxy: /Proxy-Authenticate/i.test(t) }
}

async function register() {
  const uri = `sip:${SIP_HOST}`
  const mk = (auth = '') => (
    `REGISTER ${uri} SIP/2.0\r\n` +
    `Via: SIP/2.0/UDP ${localIP}:${sip.address().port};rport;branch=${branch()}\r\n` +
    `Max-Forwards: 70\r\nFrom: <sip:${USER}@${SIP_HOST}>;tag=${fromTag}\r\n` +
    `To: <sip:${USER}@${SIP_HOST}>\r\nCall-ID: ${callId}\r\nCSeq: ${cseq++} REGISTER\r\n` +
    `Contact: <sip:${USER}@${localIP}:${sip.address().port}>\r\nExpires: 300\r\n${auth}Content-Length: 0\r\n\r\n`
  )
  send(mk())
  let r = await expect((t) => /CSeq:\s*\d+\s+REGISTER/i.test(t) && status(t) >= 200 || /401|407/.test(t.split('\r\n')[0]))
  if (status(r) === 401 || status(r) === 407) {
    const { realm, nonce } = digestParams(r)
    send(mk(authHeader('REGISTER', uri, realm, nonce)))
    r = await expect((t) => /CSeq:\s*\d+\s+REGISTER/i.test(t) && status(t) >= 200)
  }
  console.log('[sip] REGISTER ->', r.split('\r\n')[0])
  return status(r) === 200
}

async function invite(number) {
  const rtpPort = 40000 + (crypto.randomBytes(1)[0] % 1000) * 2
  const rtp = dgram.createSocket('udp4')
  await new Promise((res) => rtp.bind(rtpPort, () => res()))
  const toTag = null
  const ruri = `sip:${number}@${SIP_HOST}`
  const sdp =
    `v=0\r\no=- ${Date.now()} ${Date.now()} IN IP4 ${localIP}\r\ns=call\r\n` +
    `c=IN IP4 ${localIP}\r\nt=0 0\r\nm=audio ${rtpPort} RTP/AVP 0 101\r\n` +
    `a=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na=sendrecv\r\n`
  const inviteCseq = cseq++
  const mk = (auth = '') => (
    `INVITE ${ruri} SIP/2.0\r\n` +
    `Via: SIP/2.0/UDP ${localIP}:${sip.address().port};rport;branch=${branch()}\r\n` +
    `Max-Forwards: 70\r\nFrom: "AI" <sip:${CALLERID}@${SIP_HOST}>;tag=${fromTag}\r\n` +
    `To: <${ruri}>\r\nCall-ID: ${callId}\r\nCSeq: ${inviteCseq} INVITE\r\n` +
    `Contact: <sip:${USER}@${localIP}:${sip.address().port}>\r\n${auth}` +
    `Content-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`
  )
  send(mk())
  let r = await expect((t) => /CSeq:\s*\d+\s+INVITE/i.test(t) && (status(t) === 401 || status(t) === 407 || status(t) >= 200), 12000)
  if (status(r) === 401 || status(r) === 407) {
    const { realm, nonce, proxy } = digestParams(r)
    // ACK the error response
    ackError(r, ruri, inviteCseq)
    send(mk(authHeader('INVITE', ruri, realm, nonce, proxy ? 'Proxy-Authorization' : 'Authorization')))
    r = await expect((t) => /CSeq:\s*\d+\s+INVITE/i.test(t) && status(t) >= 200, 30000)
  }
  console.log('[sip] INVITE ->', r.split('\r\n')[0])
  if (status(r) !== 200) { console.log('[sip] FULL RESPONSE:\n'+r); rtp.close(); throw new Error('call not answered'); }
  // parse remote SDP for their RTP ip:port
  const body = r.split('\r\n\r\n')[1] || ''
  const rip = (body.match(/c=IN IP4 ([\d.]+)/) || [])[1] || SIP_HOST
  const rport = parseInt((body.match(/m=audio (\d+)/) || [])[1] || '0', 10)
  const rTag = (header(r, 'To') || '').match(/tag=([^;>\s]+)/)?.[1]
  // ACK the 200 OK
  send(
    `ACK ${ruri} SIP/2.0\r\nVia: SIP/2.0/UDP ${localIP}:${sip.address().port};rport;branch=${branch()}\r\n` +
    `Max-Forwards: 70\r\nFrom: "AI" <sip:${CALLERID}@${SIP_HOST}>;tag=${fromTag}\r\n` +
    `To: <${ruri}>;tag=${rTag}\r\nCall-ID: ${callId}\r\nCSeq: ${inviteCseq} ACK\r\nContent-Length: 0\r\n\r\n`
  )
  console.log(`[rtp] answered — remote media ${rip}:${rport}, ours :${rtpPort}`)
  return { rtp, rip, rport, rTag, ruri, inviteCseq }
}

function ackError(r, ruri, inviteCseq) {
  const rTag = (header(r, 'To') || '').match(/tag=([^;>\s]+)/)?.[1] || ''
  send(
    `ACK ${ruri} SIP/2.0\r\nVia: SIP/2.0/UDP ${localIP}:${sip.address().port};rport;branch=${branch()}\r\n` +
    `Max-Forwards: 70\r\nFrom: "AI" <sip:${CALLERID}@${SIP_HOST}>;tag=${fromTag}\r\n` +
    `To: <${ruri}>;tag=${rTag}\r\nCall-ID: ${callId}\r\nCSeq: ${inviteCseq} ACK\r\nContent-Length: 0\r\n\r\n`
  )
}

// ── RTP: stream μ-law out at 20 ms/frame ─────────────────────────────────────
function streamMuLaw(rtp, rip, rport, mu, onDone) {
  const ssrc = crypto.randomBytes(4).readUInt32BE(0)
  let seq = crypto.randomBytes(2).readUInt16BE(0), ts = 0, off = 0
  // latch: if we receive RTP, send back to that source (symmetric, NAT-safe)
  let dstIp = rip, dstPort = rport
  rtp.on('message', (_m, rinfo) => { dstIp = rinfo.address; dstPort = rinfo.port })
  const timer = setInterval(() => {
    if (off >= mu.length) { clearInterval(timer); onDone && onDone(); return }
    const payload = mu.subarray(off, off + 160); off += 160
    const pkt = Buffer.allocUnsafe(12 + payload.length)
    pkt[0] = 0x80; pkt[1] = 0x00; pkt.writeUInt16BE(seq++ & 0xffff, 2)
    pkt.writeUInt32BE(ts >>> 0, 4); pkt.writeUInt32BE(ssrc, 8); payload.copy(pkt, 12)
    ts = (ts + 160) >>> 0
    rtp.send(pkt, dstPort, dstIp)
  }, 20)
  return timer
}

function bye(call) {
  send(
    `BYE ${call.ruri} SIP/2.0\r\nVia: SIP/2.0/UDP ${localIP}:${sip.address().port};rport;branch=${branch()}\r\n` +
    `Max-Forwards: 70\r\nFrom: "AI" <sip:${CALLERID}@${SIP_HOST}>;tag=${fromTag}\r\n` +
    `To: <${call.ruri}>;tag=${call.rTag}\r\nCall-ID: ${callId}\r\nCSeq: ${cseq++} BYE\r\nContent-Length: 0\r\n\r\n`
  )
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SARVAM_KEY) throw new Error('SARVAM_API_KEY missing')
  await new Promise((res) => sip.bind(0, () => res()))
  // discover our LAN IP (used in SIP/SDP; SBC latches RTP symmetrically for NAT)
  if (process.env.PUBLIC_IP) { localIP = process.env.PUBLIC_IP } else
  localIP = Object.values(await import('node:os').then((m) => m.networkInterfaces()))
    .flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1'
  console.log('[sip] local', localIP + ':' + sip.address().port, '→', SIP_HOST + ':' + SIP_PORT)
  if (!(await register())) throw new Error('registration failed')
  console.log('[tts] synthesizing greeting…')
  const mu = await ttsMuLaw('আসসালামু আলাইকুম বস। এটা একটা টেস্ট কল, বাংলাদেশি নম্বর থেকে। শুনতে পেলে জানাবেন।')
  console.log('[sip] calling', TARGET, '…')
  const call = await invite(TARGET)
  console.log('[rtp] playing greeting…')
  streamMuLaw(call.rtp, call.rip, call.rport, mu, () => {
    setTimeout(() => { console.log('[sip] hangup'); bye(call); call.rtp.close(); process.exit(0) }, 800)
  })
  // safety hangup
  setTimeout(() => { try { bye(call) } catch {} process.exit(0) }, 60000)
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
