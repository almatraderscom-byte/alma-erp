/* ALMA Companion — popup logic: pairing, status, kill switch. */

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve))
}

const el = (id) => document.getElementById(id)

async function render() {
  const s = await send({ type: 'status' })
  const paired = s && s.paired
  el('pairView').style.display = paired ? 'none' : 'block'
  el('liveView').style.display = paired ? 'block' : 'none'
  el('hdr').className = paired && !s.paused ? 'on' : ''

  if (paired) {
    el('statusText').innerHTML = s.paused
      ? 'অবস্থা: <b>থামানো আছে</b> — এজেন্ট এখন কিছু করতে পারবে না।'
      : 'অবস্থা: <b>সক্রিয়</b> — এজেন্ট এই Chrome-এ কাজ করতে পারবে, আপনি লাইভ দেখবেন।'
    el('toggleBtn').textContent = s.paused ? 'চালু করুন' : 'থামান'
    el('toggleBtn').style.background = s.paused ? '#c9a84c' : '#e57373'
    el('toggleBtn').style.color = s.paused ? '#1a1505' : '#1a1505'
    el('pauseHint').textContent = s.paused
      ? 'নিরাপত্তার জন্য থামিয়ে রাখলে এজেন্ট কোনো কমান্ড চালাবে না।'
      : 'যেকোনো সময় "থামান" চেপে এক ক্লিকে বন্ধ করতে পারবেন।'
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

render()
