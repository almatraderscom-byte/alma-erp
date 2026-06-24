'use client'

/**
 * Owner-side preview of the staff mobile experience. This is an illustrative
 * mock (matching the approved demo) so the owner can see exactly what staff get
 * on their phones. It is intentionally non-interactive — the real, data-driven
 * staff app is rendered by <StaffApp> for actual staff users.
 */
import Confetti from './confetti'

export default function StaffPreview({ headerDate }: { headerDate: string }) {
  return (
    <>
      <div className="phead">
        <div>
          <div className="kicker">স্টাফ অভিজ্ঞতা · মোবাইল অ্যাপ</div>
          <h1>👷 স্টাফ অফিস ভিউ</h1>
          <p>স্টাফ মোবাইল অ্যাপ থেকে কাজ দেখে, রেজাল্ট জমা দেয়, আর Boss-এর ফিডব্যাক সাথে সাথে পায়।</p>
        </div>
      </div>

      <div className="stage">
        {/* phone 1: task list */}
        <div className="phone">
          <div className="notch"></div>
          <div className="pscreen">
            <div className="stitle">আমার কাজ · {headerDate}</div>
            <div className="sh1">আসসালামু আলাইকুম, Eyafi</div>
            <div className="ssub">আজ ৮টি কাজ · ৫টি সম্পন্ন, ৩টি বাকি</div>

            <div className="alert">
              <div className="t">⚠️ কাজের আপডেট চাওয়া হয়েছে</div>
              <div className="d">&ldquo;ওয়েবসাইটে ৩টি নতুন প্রোডাক্ট যোগ&rdquo; — Boss আপডেট চেয়েছেন। কাজের ছবি/আপডেট দিন।</div>
              <div className="cd">⏱ ১০ মিনিটের মধ্যে না দিলে Boss-কে জানানো হবে · ৫ মিনিট বাকি</div>
              <button className="btn primary sm" style={{ alignSelf: 'flex-start' }}>
                📤 এখনই আপডেট দিন
              </button>
            </div>

            <div className="award-mini">
              <Confetti mini />
              <div className="inner">
                <div className="crownwrap">
                  <span className="crown" style={{ fontSize: 20, top: -12 }}>
                    👑
                  </span>
                  <div className="photo">E</div>
                </div>
                <div>
                  <span className="tag">🏆 এই সপ্তাহের সেরা পারফরমার</span>
                  <h3>আপনিই সেরা, মাশাআল্লাহ! 🎉</h3>
                  <div className="sub">৩৪টি কাজ · ৯২% অনুমোদন · টিমের #১</div>
                </div>
              </div>
            </div>

            <div className="stask">
              <div className="top">
                <h4>শীতের কালেকশন — ৫টি প্রোডাক্ট ছবি</h4>
                <span className="badge b-redo">সংশোধন</span>
              </div>
              <div className="d">📦 প্রোডাক্ট ফটো · QC ৭৮/১০০</div>
              <div className="ntf">🔔 Boss নতুন কমেন্ট দিয়েছে — দেখুন</div>
            </div>
            <div className="stask">
              <div className="top">
                <h4>ঈদ অফার পোস্টার — Facebook</h4>
                <span className="badge b-pending">অপেক্ষায়</span>
              </div>
              <div className="d">🎨 অ্যাড ক্রিয়েটিভ · জমা দেওয়া হয়েছে</div>
            </div>
            <div className="stask">
              <div className="top">
                <h4>ওয়েবসাইটে ৩টি নতুন প্রোডাক্ট যোগ</h4>
                <span className="badge b-active">চলছে</span>
              </div>
              <div className="d">🌐 লিস্টিং আপডেট · এখনো জমা দেননি</div>
            </div>
            <div className="stask" style={{ opacity: 0.65 }}>
              <div className="top">
                <h4>স্টোরি ব্যানার ডিজাইন</h4>
                <span className="badge b-done">সম্পন্ন ✓</span>
              </div>
              <div className="d">🎨 অ্যাড ক্রিয়েটিভ · Boss অনুমোদন করেছেন</div>
            </div>

            <button className="selfbtn">✨ নিজে থেকে একটা কাজ করেছি — জমা দিন</button>
            <div className="stask" style={{ borderStyle: 'dashed', borderColor: 'rgba(139,92,246,.4)' }}>
              <div className="top">
                <h4>৩টি পুরোনো প্রোডাক্টের নতুন ছবি</h4>
                <span className="self-badge">নিজ উদ্যোগে</span>
              </div>
              <div className="d">
                💡 অতিরিক্ত কাজ · <span style={{ color: '#fcd34d' }}>Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট</span>
              </div>
            </div>

            <div className="stitle" style={{ marginTop: 22 }}>
              আমার পারফরম্যান্স
            </div>
            <div className="perf">
              <div className="pc">
                <div className="v num" style={{ color: '#6ee7b7' }}>
                  ৮৬%
                </div>
                <div className="l">এই সপ্তাহ</div>
              </div>
              <div className="pc">
                <div className="v num" style={{ color: '#7dd3fc' }}>
                  ৩৪
                </div>
                <div className="l">এই মাস সম্পন্ন</div>
              </div>
              <div className="pc">
                <div className="v num" style={{ color: '#fcd34d' }}>
                  ৪.৬
                </div>
                <div className="l">গড় QC স্কোর</div>
              </div>
            </div>
            <div className="bar">
              <i style={{ width: '86%' }}></i>
            </div>
          </div>
          <div className="pnav">
            <a className="act">
              <span className="i">📋</span>কাজ
            </a>
            <a>
              <span className="i">💬</span>মেসেজ
            </a>
            <a>
              <span className="i">📊</span>পারফরম্যান্স
            </a>
            <a>
              <span className="i">👤</span>প্রোফাইল
            </a>
          </div>
        </div>

        {/* phone 2: task detail / thread */}
        <div className="phone">
          <div className="notch"></div>
          <div className="pscreen">
            <button className="backbtn">← আমার কাজ</button>
            <h4 style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}>শীতের কালেকশন — ৫টি প্রোডাক্ট ছবি</h4>
            <div className="row" style={{ display: 'flex', gap: 8, margin: '10px 0 4px', flexWrap: 'wrap' }}>
              <span className="badge b-redo">🔄 সংশোধন দরকার</span>
              <span className="chip" style={{ fontSize: 11, padding: '5px 10px' }}>
                📦 প্রোডাক্ট ফটো
              </span>
            </div>

            <div className="instr" style={{ margin: '14px 0' }}>
              <div className="h">🧠 কাজটি যেভাবে করবেন</div>
              <p>সাদা ব্যাকগ্রাউন্ডে ৫টি ছবি। ভালো লাইটিং, কোনো ভাঁজ নয়। ALMA brand frame বসান।</p>
            </div>

            <div className="msgs" style={{ padding: 0 }}>
              <div className="msg">
                <span className="av e">E</span>
                <div className="bubble">
                  <div className="mh">
                    <span className="nm">আপনি</span>
                    <span className="tm">১০:৩২</span>
                  </div>
                  <div className="content" style={{ fontSize: 13 }}>
                    ৫টি ছবি জমা দিলাম।
                    <div className="proof">
                      <div className="pimg ph1" style={{ width: 90, height: 70 }}></div>
                      <div className="pimg ph2" style={{ width: 90, height: 70 }}></div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="msg owner">
                <span className="av o">M</span>
                <div className="bubble">
                  <div className="mh">
                    <span className="nm">Boss</span>
                    <span className="tm">১০:৪৫</span>
                  </div>
                  <div className="content" style={{ fontSize: 13 }}>
                    ৩নং আর ৫নং ছবির লাইটিং একটু কম। ওই দুইটা আবার তুলে দাও, বাকি ৩টা ঠিক আছে মাশাআল্লাহ।
                  </div>
                </div>
              </div>
            </div>

            <div
              style={{
                background: 'var(--bg-1)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--r-md)',
                padding: 14,
                marginTop: 8,
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>📎 সংশোধিত রেজাল্ট জমা দিন</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn" style={{ flex: 1, justifyContent: 'center' }}>
                  📷 ছবি তুলুন
                </button>
                <button className="btn" style={{ flex: 1, justifyContent: 'center' }}>
                  🖼️ গ্যালারি
                </button>
              </div>
              <div
                className="ibox"
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  background: 'var(--bg-0)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-pill)',
                  padding: '6px 6px 6px 14px',
                  marginTop: 10,
                }}
              >
                <input
                  placeholder="কমেন্ট লিখুন…"
                  style={{ flex: 1, background: 'transparent', border: 0, color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }}
                />
                <button className="btn primary sm">পাঠান</button>
              </div>
            </div>

            <div className="note" style={{ marginTop: 14, fontSize: 12.5 }}>
              <span className="i">🔔</span>
              <div>
                Boss অনুমোদন দিলে কাজটি <b>সম্পন্ন</b> হবে। নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="note" style={{ maxWidth: 820, margin: '26px auto 0' }}>
        <span className="i">💡</span>
        <div>
          <b>টেলিগ্রামের ভূমিকা এখন শুধু নোটিফিকেশন:</b> &ldquo;নতুন কাজ এসেছে&rdquo;, &ldquo;Boss কমেন্ট দিয়েছে&rdquo;, &ldquo;অনুমোদন
          হয়েছে&rdquo; — এক ট্যাপে অ্যাপে চলে আসবে। সব আলোচনা, ছবি ও অনুমোদন এখন Office Hub-এ, তাই ব্যক্তিগত চ্যাট পরিষ্কার থাকে আর AI কম
          টোকেন খরচ করে।
        </div>
      </div>
    </>
  )
}
