/* ALMA Companion — popup logic: pairing, status, kill switch. */

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve))
}

const el = (id) => document.getElementById(id)

// Auto-suggest a device name based on the OS so multi-device targeting
// ("Windows Chrome" vs "Mac Chrome") works out of the box. The owner can
// still edit the field before pairing.
function suggestDeviceName() {
  const f = el('deviceName')
  if (!f) return
  const ua = (navigator.userAgent || '').toLowerCase()
  const plat = (navigator.platform || '').toLowerCase()
  let os = 'Chrome'
  if (ua.includes('windows') || plat.includes('win')) os = 'My Windows Chrome'
  else if (ua.includes('mac') || plat.includes('mac')) os = 'My Mac Chrome'
  else if (ua.includes('linux') || plat.includes('linux')) os = 'My Linux Chrome'
  else if (ua.includes('cros')) os = 'My Chromebook'
  else os = 'My Chrome'
  f.value = os
}

async function render() {
  const s = await send({ type: 'status' })
  const paired = s && s.paired
  const heartbeatAge = s && s.lastSuccessfulPollAt ? Date.now() - s.lastSuccessfulPollAt : Infinity
  const serverConnected = paired && !s.paused && heartbeatAge < 90000
  el('pairView').style.display = paired ? 'none' : 'block'
  el('liveView').style.display = paired ? 'block' : 'none'
  el('hdr').className = serverConnected ? 'on' : paired && !s.paused ? 'warn' : ''

  if (paired) {
    if (s.paused) {
      el('statusText').innerHTML = 'অবস্থা: <b>থামানো আছে</b> — এজেন্ট এখন কিছু করতে পারবে না।'
    } else if (serverConnected) {
      el('statusText').innerHTML = 'অবস্থা: <b>সার্ভারের সাথে যুক্ত</b> — এজেন্ট এই Chrome-এ কাজ করতে পারবে, আপনি লাইভ দেখবেন।'
    } else {
      const mins = Number.isFinite(heartbeatAge) ? Math.max(1, Math.floor(heartbeatAge / 60000)) : null
      const when = mins ? `${mins} মিনিট ধরে ` : ''
      el('statusText').innerHTML =
        `অবস্থা: <b class="bad">সুইচ চালু, কিন্তু সার্ভার সংযোগ নেই</b> — ${when}heartbeat পৌঁছায়নি। ` +
        'Chrome/ইন্টারনেট চালু রাখুন; নিজে থেকেই আবার চেষ্টা হচ্ছে।'
    }
    el('toggleBtn').textContent = s.paused ? 'চালু করুন' : 'থামান'
    el('toggleBtn').style.background = s.paused ? '#c9a84c' : '#e57373'
    el('toggleBtn').style.color = s.paused ? '#1a1505' : '#1a1505'
    el('pauseHint').textContent = s.paused
      ? 'নিরাপত্তার জন্য থামিয়ে রাখলে এজেন্ট কোনো কমান্ড চালাবে না।'
      : serverConnected
        ? 'যেকোনো সময় "থামান" চেপে এক ক্লিকে বন্ধ করতে পারবেন।'
        : (s.lastError || `Server: ${s.baseUrl}`)
  }
}

el('pairBtn').addEventListener('click', async () => {
  el('pairErr').textContent = ''
  el('pairBtn').disabled = true
  const r = await send({
    type: 'pair',
    code: el('code').value,
    baseUrl: el('baseUrl').value,
    deviceName: el('deviceName').value,
  })
  el('pairBtn').disabled = false
  if (!r || !r.ok) {
    el('pairErr').textContent = (r && r.error) || 'যুক্ত করা গেল না'
    return
  }
  render()
})

el('toggleBtn').addEventListener('click', async () => {
  const s = await send({ type: 'status' })
  await send({ type: 'setPaused', paused: !s.paused })
  render()
})

el('unpairBtn').addEventListener('click', async () => {
  await send({ type: 'unpair' })
  render()
})

suggestDeviceName()
render()
