/**
 * Phase-0 SIP trunk probes (NGS-replacement plan, 2026-07-25).
 *
 *   node sip-probe.mjs register            — REGISTER + de-register (probe 1, PASSED)
 *   node sip-probe.mjs outbound 01XXXXXXXXX — REGISTER, INVITE the number, play a
 *                                             2s beep over RTP on answer, BYE (probe 2)
 *   node sip-probe.mjs inbound [seconds]   — REGISTER and WAIT (default 90s) for an
 *                                             incoming INVITE: log the From header
 *                                             (caller-ID — THE motivation), answer
 *                                             200+SDP, count inbound RTP packets,
 *                                             then clean up + de-register (probe 3)
 *
 * Env: SIP_HOST, SIP_PORT (default 5060), SIP_USER, SIP_PASS, PUBLIC_IP.
 * Self-contained on purpose — runs from /tmp on the VPS, creds never in git.
 */
import dgram from 'node:dgram'
import { createHash, randomBytes } from 'node:crypto'

const HOST = process.env.SIP_HOST
const PORT = Number(process.env.SIP_PORT || 5060)
const USER = process.env.SIP_USER
const PASS = process.env.SIP_PASS
const PUBLIC_IP = process.env.PUBLIC_IP || '31.97.237.40'
const MODE = process.argv[2] || 'register'
const ARG = process.argv[3]

if (!HOST || !USER || !PASS) { console.error('need SIP_HOST/SIP_USER/SIP_PASS'); process.exit(1) }

const md5 = (s) => createHash('md5').update(s).digest('hex')
const branch = () => 'z9hG4bK' + randomBytes(6).toString('hex')
const newTag = () => randomBytes(4).toString('hex')

const sip = dgram.createSocket('udp4')
const rtp = dgram.createSocket('udp4')
let rtpPort = 0

// ── μ-law beep (1 kHz, for RTP-out proof) ────────────────────────────────────
function pcm16ToMuLawByte(s) {
  const BIAS = 132, CLIP = 32635
  let sign = (s >> 8) & 0x80
  if (sign) s = -s
  if (s > CLIP) s = CLIP
  s += BIAS
  let exp = 7
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1);
  const mant = (s >> (exp + 3)) & 0x0f
  return ~(sign | (exp << 4) | mant) & 0xff
}
function beepMuLaw(ms = 2000) {
  const n = 8 * ms
  const out = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 1000 * i) / 8000) * 12000)
    out[i] = pcm16ToMuLawByte(s)
  }
  return out
}

// ── SIP plumbing ─────────────────────────────────────────────────────────────
const send = (m) => sip.send(Buffer.from(m), PORT, HOST)
const firstLine = (t) => t.split('\r\n')[0]
const hdr = (t, name) => new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im').exec(t)?.[1]?.trim()

let ncCounter = 0
function digest(method, uri, txt) {
  const realm = /realm="([^"]+)"/.exec(txt)?.[1] ?? HOST
  const nonce = /nonce="([^"]+)"/.exec(txt)?.[1] ?? ''
  const opaque = /opaque="([^"]+)"/.exec(txt)?.[1]
  const qop = /qop="?([^",]+)"?/.exec(txt)?.[1]
  const ha1 = md5(`${USER}:${realm}:${PASS}`)
  const ha2 = md5(`${method}:${uri}`)
  const h = /Proxy-Authenticate/i.test(txt) ? 'Proxy-Authorization' : 'Authorization'
  if (qop) {
    const nc = (++ncCounter).toString(16).padStart(8, '0')
    const cnonce = randomBytes(8).toString('hex')
    const resp = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    return `${h}: Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${resp}", algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cnonce}"${opaque ? `, opaque="${opaque}"` : ''}\r\n`
  }
  const resp = md5(`${ha1}:${nonce}:${ha2}`)
  return `${h}: Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${resp}", algorithm=MD5${opaque ? `, opaque="${opaque}"` : ''}\r\n`
}

let cseq = 1
const regTag = newTag()
const regCallId = randomBytes(8).toString('hex') + '@probe'
function regMsg(auth = '', expires = 60) {
  const uri = `sip:${HOST}`
  return `REGISTER ${uri} SIP/2.0\r\nVia: SIP/2.0/UDP ${PUBLIC_IP}:${sip.address().port};rport;branch=${branch()}\r\nMax-Forwards: 70\r\nFrom: <sip:${USER}@${HOST}>;tag=${regTag}\r\nTo: <sip:${USER}@${HOST}>\r\nCall-ID: ${regCallId}\r\nCSeq: ${cseq++} REGISTER\r\nContact: <sip:${USER}@${PUBLIC_IP}:${sip.address().port}>\r\nExpires: ${expires}\r\nUser-Agent: alma-probe\r\n${auth}Content-Length: 0\r\n\r\n`
}

const waiters = []
sip.on('message', (buf, rinfo) => {
  const t = buf.toString()
  if (process.env.SIP_TRACE) console.log('<<', firstLine(t))
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i].test(t)) { const w = waiters.splice(i, 1)[0]; w.resolve(t); return }
  }
  if (inboundHandler) inboundHandler(t, rinfo)
})
function expect(test, ms = 10000) {
  return new Promise((resolve, reject) => {
    const w = { test, resolve }
    waiters.push(w)
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout')) } }, ms)
  })
}

async function register(expires = 60) {
  send(regMsg('', expires))
  let r = await expect((t) => /CSeq:\s*\d+\s+REGISTER/i.test(t))
  const code = Number(firstLine(r).split(' ')[1])
  if (code === 401 || code === 407) {
    send(regMsg(digest('REGISTER', `sip:${HOST}`, r), expires))
    r = await expect((t) => /CSeq:\s*\d+\s+REGISTER/i.test(t) && !/40[17]/.test(firstLine(t)))
  }
  const ok = Number(firstLine(r).split(' ')[1])
  console.log(`REGISTER(${expires}) -> ${firstLine(r)}`)
  if (ok < 200 || ok >= 300) throw new Error('register failed')
}

// ── outbound probe ───────────────────────────────────────────────────────────
async function outbound(number) {
  await register(120)
  const to = number
  const callId = randomBytes(8).toString('hex') + '@probe'
  const fromTag = newTag()
  const uri = `sip:${to}@${HOST}`
  const sdp =
    `v=0\r\no=- 1 1 IN IP4 ${PUBLIC_IP}\r\ns=probe\r\nc=IN IP4 ${PUBLIC_IP}\r\nt=0 0\r\n` +
    `m=audio ${rtpPort} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na=sendrecv\r\n`
  const inviteBase = (auth = '') =>
    `INVITE ${uri} SIP/2.0\r\nVia: SIP/2.0/UDP ${PUBLIC_IP}:${sip.address().port};rport;branch=${branch()}\r\nMax-Forwards: 70\r\nFrom: "AI" <sip:${USER}@${HOST}>;tag=${fromTag}\r\nTo: <${uri}>\r\nCall-ID: ${callId}\r\nCSeq: ${cseq++} INVITE\r\nContact: <sip:${USER}@${PUBLIC_IP}:${sip.address().port}>\r\nUser-Agent: alma-probe\r\nContent-Type: application/sdp\r\n${auth}Content-Length: ${sdp.length}\r\n\r\n${sdp}`
  send(inviteBase())
  let r = await expect((t) => t.includes(callId) && /INVITE/i.test(hdr(t, 'CSeq') ?? ''), 20000)
  let code = Number(firstLine(r).split(' ')[1])
  if (code === 401 || code === 407) {
    // ACK the failure, re-INVITE with auth
    const toHdr = hdr(r, 'To')
    send(`ACK ${uri} SIP/2.0\r\nVia: SIP/2.0/UDP ${PUBLIC_IP}:${sip.address().port};rport;branch=${branch()}\r\nMax-Forwards: 70\r\nFrom: "AI" <sip:${USER}@${HOST}>;tag=${fromTag}\r\nTo: ${toHdr}\r\nCall-ID: ${callId}\r\nCSeq: ${cseq - 1} ACK\r\nContent-Length: 0\r\n\r\n`)
    send(inviteBase(digest('INVITE', uri, r)))
  }
  console.log('INVITE sent — ringing? (waiting up to 45s for answer)')
  r = await expect((t) => {
    if (!t.includes(callId) || !/INVITE/i.test(hdr(t, 'CSeq') ?? '')) return false
    const c = Number(firstLine(t).split(' ')[1])
    return c >= 200 && c !== 401 && c !== 407
  }, 45000)
  code = Number(firstLine(r).split(' ')[1])
  console.log('final:', firstLine(r))
  if (code !== 200) { console.log('RESULT: call not answered/failed'); return cleanup(1) }
  const toHdr = hdr(r, 'To')
  send(`ACK ${uri} SIP/2.0\r\nVia: SIP/2.0/UDP ${PUBLIC_IP}:${sip.address().port};rport;branch=${branch()}\r\nMax-Forwards: 70\r\nFrom: "AI" <sip:${USER}@${HOST}>;tag=${fromTag}\r\nTo: ${toHdr}\r\nCall-ID: ${callId}\r\nCSeq: ${cseq - 1} ACK\r\nContent-Length: 0\r\n\r\n`)
  // remote RTP from SDP answer
  const rIp = /c=IN IP4 ([\d.]+)/.exec(r)?.[1]
  const rPort = Number(/m=audio (\d+)/.exec(r)?.[1])
  console.log(`answered — sending 2s beep to ${rIp}:${rPort}`)
  await sendBeep(rIp, rPort)
  // BYE
  send(`BYE ${uri} SIP/2.0\r\nVia: SIP/2.0/UDP ${PUBLIC_IP}:${sip.address().port};rport;branch=${branch()}\r\nMax-Forwards: 70\r\nFrom: "AI" <sip:${USER}@${HOST}>;tag=${fromTag}\r\nTo: ${toHdr}\r\nCall-ID: ${callId}\r\nCSeq: ${cseq++} BYE\r\nContent-Length: 0\r\n\r\n`)
  console.log('RESULT: ✅ outbound OK — ring + answer + RTP beep sent')
  return cleanup(0)
}

function sendBeep(ip, port) {
  return new Promise((resolve) => {
    const payload = beepMuLaw(2000)
    const ssrc = randomBytes(4).readUInt32BE(0)
    let seq = 1, ts = 0, off = 0
    const iv = setInterval(() => {
      if (off >= payload.length) { clearInterval(iv); resolve(); return }
      const chunk = payload.subarray(off, off + 160); off += 160
      const h = Buffer.alloc(12)
      h[0] = 0x80; h[1] = 0x00
      h.writeUInt16BE(seq++ & 0xffff, 2); h.writeUInt32BE(ts, 4); h.writeUInt32BE(ssrc, 8)
      ts += 160
      rtp.send(Buffer.concat([h, chunk]), port, ip)
    }, 20)
  })
}

// ── inbound probe ────────────────────────────────────────────────────────────
let inboundHandler = null
async function inbound(windowSec = 90) {
  await register(Math.max(windowSec + 30, 120))
  console.log(`REGISTERED. WAITING ${windowSec}s FOR AN INBOUND CALL to ${USER} — dial it now!`)
  let rtpCount = 0
  rtp.on('message', () => { rtpCount++ })
  let done = false
  inboundHandler = (t, rinfo) => {
    if (!/^INVITE /.test(t)) {
      if (/^(ACK|BYE|CANCEL|OPTIONS) /.test(t)) {
        console.log('<< request:', firstLine(t))
        if (/^BYE /.test(t)) reply200(t, rinfo)
      }
      return
    }
    console.log('📞 INBOUND INVITE RECEIVED')
    console.log('   From:', hdr(t, 'From'))
    console.log('   To:  ', hdr(t, 'To'))
    console.log('   Contact:', hdr(t, 'Contact'))
    const sdp =
      `v=0\r\no=- 1 1 IN IP4 ${PUBLIC_IP}\r\ns=probe\r\nc=IN IP4 ${PUBLIC_IP}\r\nt=0 0\r\n` +
      `m=audio ${rtpPort} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n`
    const via = hdr(t, 'Via'), from = hdr(t, 'From'), to = hdr(t, 'To'), cid = hdr(t, 'Call-ID'), cs = hdr(t, 'CSeq')
    const toTag = `${to};tag=${newTag()}`
    const resp = (code, reason, body = '', extra = '') =>
      `SIP/2.0 ${code} ${reason}\r\nVia: ${via}\r\nFrom: ${from}\r\nTo: ${toTag}\r\nCall-ID: ${cid}\r\nCSeq: ${cs}\r\nContact: <sip:${USER}@${PUBLIC_IP}:${sip.address().port}>\r\n${extra}Content-Length: ${body.length}\r\n${body ? 'Content-Type: application/sdp\r\n' : ''}\r\n${body}`
    sip.send(Buffer.from(resp(100, 'Trying')), rinfo.port, rinfo.address)
    sip.send(Buffer.from(resp(180, 'Ringing')), rinfo.port, rinfo.address)
    setTimeout(() => {
      sip.send(Buffer.from(resp(200, 'OK', sdp)), rinfo.port, rinfo.address)
      console.log('answered 200 OK — counting inbound RTP for 8s…')
      setTimeout(() => {
        console.log(`RESULT: inbound RTP packets received: ${rtpCount} ${rtpCount > 50 ? '✅' : '⚠️ (low/none)'}`)
        done = true
        cleanup(rtpCount > 50 ? 0 : 6)
      }, 8000)
    }, 1500)
  }
  function reply200(t, rinfo) {
    const resp = `SIP/2.0 200 OK\r\nVia: ${hdr(t, 'Via')}\r\nFrom: ${hdr(t, 'From')}\r\nTo: ${hdr(t, 'To')}\r\nCall-ID: ${hdr(t, 'Call-ID')}\r\nCSeq: ${hdr(t, 'CSeq')}\r\nContent-Length: 0\r\n\r\n`
    sip.send(Buffer.from(resp), rinfo.port, rinfo.address)
  }
  setTimeout(() => { if (!done) { console.log('RESULT: ⚠️ no inbound INVITE within window'); cleanup(7) } }, windowSec * 1000)
}

async function cleanup(codeExit) {
  try { send(regMsg('', 0)); const r = await expect((t) => /REGISTER/i.test(hdr(t, 'CSeq') ?? ''), 5000); const c = Number(firstLine(r).split(' ')[1]); if (c === 401 || c === 407) { send(regMsg(digest('REGISTER', `sip:${HOST}`, r), 0)); await expect((t) => /REGISTER/i.test(hdr(t, 'CSeq') ?? ''), 5000) } console.log('de-registered') } catch { /* */ }
  process.exit(codeExit)
}

sip.bind(0, () => {
  rtp.bind(0, async () => {
    rtpPort = rtp.address().port
    console.log(`probe ${MODE} — sip:${sip.address().port} rtp:${rtpPort} → ${HOST}:${PORT}`)
    try {
      if (MODE === 'register') { await register(60); await cleanup(0) }
      else if (MODE === 'outbound') { if (!ARG) { console.error('need number'); process.exit(1) } await outbound(ARG) }
      else if (MODE === 'inbound') { await inbound(Number(ARG || 90)) }
      else { console.error('unknown mode'); process.exit(1) }
    } catch (e) { console.error('PROBE ERROR:', e.message); cleanup(9) }
  })
})
