# Plan-Drive must feel like watching Claude work — locked goals

Owner ruling, 2026-07-26, after watching two trivial tasks sit for over an hour.

## What he actually saw

His iOS panel said **"Running 2"**. The API said otherwise:

```json
{"state":"escalated","nextTickAt":null,"lastDrivenAt":"19:01","attempt":1,"steps":["done"],"cost":5}
{"state":"escalated","nextTickAt":null,"lastDrivenAt":"18:58","attempt":1,"steps":["done"],"cost":41}
```

Each plan ran **one step, in about a minute**, the completion gate said "not
done", and the plan stopped with nothing scheduled. It had been dead for an hour
while the screen called it Running. His summary was exactly right: *"plan drive
নামেই আছে, কাজের বেলায় জিরো"* — the same task typed into the chat finishes in two
minutes.

## The goals (locked — every one of these must be true before "done")

**G1 — the screen never lies about state.**
A parked plan is never labelled "Running". Each plan ships an explicit,
owner-readable status ("চলছে" / "আপনার সিদ্ধান্ত দরকার" / "অনুমোদনের অপেক্ষায়"),
and the panel counts them separately.

**G2 — a small task must not park on the first miss.**
A not-done verdict appends corrective work and keeps going (bounded). Parking is
for something that genuinely needs Boss, not for the first imperfect answer.

**G3 — the todo list comes first, then visible step-by-step progress.**
When work starts, its steps are published immediately (pending), and the running
step is visible WHILE it runs — with what it is doing and how long it has been at
it. Not a blank box that fills in after the fact.

**G4 — queued work is visible as running work.**
A worker job (audit, crawl, long task) shows in the UI as a live task —
"১টি কাজ চলছে · SEO অডিট · ২ মিনিট" — for as long as it runs, on web and native.

**G5 — the agent wakes itself and delivers.**
The moment the work finishes, the result lands in the chat by itself. Boss never
has to ask "is it done?".

**G6 — a time budget, honestly reported.**
Ordinary work finishes inside ~20-30 minutes. Work that cannot says so, with the
reason and what it needs — it does not sit silently.

**G7 — web shows what iOS shows.**
The same panel, the same statuses, the same live progress.

**G8 — Boss can steer work WHILE it runs, without breaking it.**
His words: *"majhe moddhe tmr thought e kichu bhul cinta dekhlew ami instant tmk
inform kori r sei message ta auto running obosthay tmi current kaj nosto na kore
catch korte paro"*. A message sent during a run reaches the work in flight and
adapts it — it does not queue behind it, get lost, or restart it. Chat turns
already do this (`/turn/:id/steer` + `claimTurnSteeringMessages`); Plan-Drive
steps now claim the same way, from the plan's own thread.

**G9 — the whole experience is modelled on how Claude Code works, deliberately.**
Not "an agent that eventually produces an answer": state its understanding, put
up the todo list, work visibly step by step, narrate what it just learned, take
correction mid-flight, and finish. The measure is whether Boss can watch without
asking a single "what is happening?" question.

## Standard this is held to

> "ami jodi tmk claude app e ei session e ei same task ta ditam, tmi jevabe live
> shuru korte, shuru te age todo set korte erpor step by step ami shob UI te
> dekhte petam" — the owner, 2026-07-26.

The bar is not "the plan engine technically advanced". The bar is that he can
watch it happen, understand it without asking, and never feel he is waiting on a
blank screen.
