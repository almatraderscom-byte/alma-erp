import { createClient } from "@supabase/supabase-js"
const env = process.env
const r = await fetch("https://api.sarvam.ai/text-to-speech", { method:"POST", headers:{"api-subscription-key":env.SARVAM_API_KEY,"Content-Type":"application/json"}, body: JSON.stringify({text:"আসসালামু আলাইকুম বস। এটা ফাইনাল টেস্ট কল। বাংলাদেশি নম্বর, আমাদের নিজের সিস্টেম, আর সারভামের বাংলা কণ্ঠ — সব একসাথে কাজ করছে। এখন থেকে আপনার এজেন্ট এই নম্বর দিয়েই কল করতে পারবে ইনশাআল্লাহ। আল্লাহ হাফেজ বস।", target_language_code:"bn-IN", model:"bulbul:v2", speaker:"anushka", speech_sample_rate:8000}) })
const j = await r.json()
if (!j.audios?.[0]) { console.error("TTS_FAIL"); process.exit(1) }
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const path = "calls/ngslive_" + Date.now() + ".wav"
await sb.storage.from("agent-files").upload(path, Buffer.from(j.audios[0],"base64"), { contentType:"audio/wav", upsert:true })
const { data: signed } = await sb.storage.from("agent-files").createSignedUrl(path, 3600)
const url = signed.signedUrl
const escUrl = url.replace(/&/g, "&amp;")
console.log("audio:", url.slice(0, 90))
const XML = `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${escUrl}</Play><Hangup/></Response>`
const body = new URLSearchParams({ to:"01779640373", from:"2323", responseXml: XML })
const res = await fetch("https://alma-traders.infosoftbd.com/api/v1/call", { method:"POST", headers:{ "X-Authorization": env.NGS_KEY, "X-Authorization-Secret": env.NGS_SECRET, "Content-Type": "application/x-www-form-urlencoded" }, body })
console.log("HTTP", res.status, "::", (await res.text()).slice(0,300))
