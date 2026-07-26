# Roadmap 1 — the agent finishes the job by itself

**Own session. Own branch (`claude/roadmap-plan-8e52ff` today).**
Sister roadmap: `docs/roadmap-2-skill-architecture.md` — run it in a SEPARATE
session, on its OWN branch. Owner's instruction, 2026-07-26.

The goal in his words: give the agent a job, and it plans, works, reports and
finishes — without dribbling twenty-second fragments and approval cards at him.

---

## Where the SEO work actually stands (measured live, not reported)

Every number below comes from fetching the live pages myself. The agent's own
count is never the evidence — that lesson cost most of a day.

| | |
|---|---|
| product pages in sitemap | **89** |
| meta description ≥ 50 chars | **87** ✅ |
| title 10–70 chars | **87** ✅ |
| **remaining** | **2 pages** |

The two stragglers are `ইসলামিক ৭টি বইয়ের কম্বো প্যাকেজ (7-b)` and `mm03`. Both
render **no title and no meta tag at all** (0 chars), so this is not "copy not
written yet" — those pages are missing the tags, which is a storefront template
question, not an ERP copy question. Do not hand it to the SEO fix skill.

The agent's own audit of the 50 catalogue products agrees and adds detail:
`lowSlug: 2 · missingMeta: 0 · weakTitle: 8 · weakAlt: 0 · thinDescription: 4`.

**So: the meta/description job the owner originally asked for is DONE.** What is
left is small and different in kind — 2 slugs, 8 weak titles, 4 thin
descriptions, and the 2 tagless pages.

### The finding that reframed the whole job

The audit's headline — "52+ images without alt" — was almost entirely FALSE. A
decorative image is *supposed* to carry `alt=""`, and so is an image inside an
`aria-label`led control. Measured live: product and category pages have **0**
real missing alt; only the homepage `.scard` blocks have 16, and those live in
the **storefront repo**. Both the crawler and the verifier were corrected.

The real problem was meta descriptions, and that is what got fixed.

---

## What shipped this session (all on the branch, none merged)

| | |
|---|---|
| A drafted SEO batch no longer expires in 30 minutes | the loop that made him approve four different cards |
| Approval loader starts on the CLICK, not after the write | the "agent is asleep" complaint |
| After an approval the head gets the FACTS (how many applied, what is still pending) | it kept saying "waiting for approval" for finished work |
| Process section opens the moment work starts | at 10s the screen was blank; measured |
| Live thinking during a worker-run continuation | that path only polled messages; the placeholder was a false promise |
| Which skill is running, as a system line + in the agent's own first line | he showed me ChatGPT doing it |
| New chats default to Auto, not Sonnet | every new chat silently pinned the priciest head |
| Context meter survives a model switch; compaction follows the WINDOW, not dollars | his two explicit asks |
| A switched head is told it is continuing, not starting | so it stops re-introducing itself |
| Progress update every 3 silent tool rounds | "koyek ta dhap sesh kore amk age update daw" |
| Plan-first on a big job — read, plan, ask everything once, then execute | "ami tar ei kajer plan e dekhte pai ni" |

---

## Still broken — start here

1. **`draft_seo_fixes` blocked by the duplicate guard, and the agent lied about
   it.** Verified live at the end of this session: the tool returned *"একই কাজ এই
   টার্নে আগেই হয়েছে/স্টেজ হয়েছে — ডুপ্লিকেট আটকানো হলো"*, no card was created, and
   the agent still wrote "card বানাচ্ছি"। Two defects in one: the guard fires on a
   legitimately different batch, and a failed staging call does not stop the
   claim. **This is the top of the list.**
2. **The agent asserts card state instead of reading it.** Fixed for the
   post-approval continuation only; a normal turn still says "অনুমোদনের অপেক্ষায়
   আছি" with no card in existence.
3. **Non-stop work is still not real.** He asked for a job that runs 13 minutes
   without stopping. It still ends turns early and waits.
4. **The 2 tagless pages** (`7-b`, `mm03`) need a storefront fix, not agent copy.
5. **Nothing is merged to main.** Everything is on the branch, live-verified
   piece by piece.

---

## How he wants this tested (his correction, and it stands)

- **Never claim from code.** Every claim needs a live screenshot from his Chrome.
  I broke this repeatedly and he caught it every time.
- **Test the way HE types** — one plain sentence, no coaching the agent with tool
  names or step lists.
- **Test the FLOW, not only the result:** did thinking appear immediately, could
  he open it, did an update arrive between phases, did it finish without asking
  him five times.
- **One path tested is not two paths tested.** A typed message and a
  post-approval continuation are different code paths; I verified one and claimed
  both, and he caught that too.
- **Set a real watcher before saying "after the deploy I'll…".** `vercel inspect
  --logs` returns EMPTY in a background shell — that is why three watchers
  silently never fired. Compare the alias's deployment URL instead, and check the
  watcher is actually reading values before trusting it.

---

## Standing authorisation

He authorised me to approve the SEO cards on his behalf until this job is
finished. That authorisation is for SEO copy on his own site, through the normal
approval cards — nothing wider.
