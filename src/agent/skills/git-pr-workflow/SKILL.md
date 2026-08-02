---
name: git-pr-workflow
description: Takes finished work on Boss's Mac from branch to merged pull request: branch, commit, push, open the PR, wait for CI and the Codex bot, triage by severity, merge. Use when Boss asks to commit and push, open a PR, check CI, or merge a branch.
version: 1.0.0
keywords: commit, kommit, push koro, pull request, PR banao, PR khulo, branch banao, merge koro, ci pass, ci fail, codex bot, git push, PR er obostha
---

# branch → PR → merge

Boss-এর Mac-এ কাজ শেষ, এখন সেটা GitHub-এ তোলা ও মার্জ করা। cwd ডিফল্ট
`~/alma-erp`। **পড়ার কমান্ড সঙ্গে সঙ্গে চলে; যা কিছু বদলায় (commit, push, PR
তৈরি, merge) নিজে থেকেই Boss-এর ফোনে approval card হয়ে যায়** — আগে আলাদা করে
অনুমতি চেয়ো না, টুল ডেকে বলো কার্ড পাঠিয়েছি, তারপর `check_mac_command` দিয়ে ফল।

## ধাপ

```
- [ ] ১. এখন কী অবস্থা (status/diff/branch)
- [ ] ২. branch — main-এ সরাসরি নয়
- [ ] ৩. commit + push
- [ ] ৪. PR খোলো
- [ ] ৫. CI + Codex bot — triage
- [ ] ৬. Boss বললে merge
```

১. **অবস্থা** — `git status`, `git diff --stat`, `git log --oneline -5`,
   `git branch`। সবগুলো সঙ্গে সঙ্গে চলে। **যা বদলেছে সেটা যা করার কথা ছিল তার
   সাথে মেলে কিনা দেখো** — অপ্রত্যাশিত ফাইল থাকলে থামো এবং Boss-কে দেখাও।

২. **branch** — main-এ হলে আগে `git checkout -b <নাম>`। নাম কাজ বোঝাবে
   (`claude/<kaj>` ধাঁচে)। **main-এ সরাসরি commit করবে না।**

৩. **commit + push** — commit message **ইংরেজিতে**, conventional ধাঁচে
   (`feat: …`, `fix: …`, `docs: …`, `chore: …`), এক লাইনে কী বদলেছে।
   `git add` করার আগে `git status` দেখে নিশ্চিত হও কোনগুলো যাচ্ছে — `git add -A`
   অন্ধভাবে নয়। তারপর `git push -u origin <branch>`।
   **force push কোডেই নিষিদ্ধ** — দরকার মনে হলে থামো, Boss নিজে করবেন।

৪. **PR** — `gh pr create --fill` (বা `--title`/`--body` দিয়ে)। শরীরে: কী বদলেছে,
   কেন, কীভাবে যাচাই হয়েছে। খোলার পর `gh pr view --json url,number` দিয়ে লিংক নাও।

৫. **CI + bot** — `gh pr checks` আর `gh pr view --comments` (দুটোই সঙ্গে সঙ্গে চলে)।
   - **CI লাল হলে merge-এর কথাই তুলবে না** — কোন check, কোন লাইন, সেটা বলো।
   - **Codex bot (`chatgpt-codex-connector`) merge-এর আগের গেট।** তার কমেন্ট
     এলে নিজে triage করো এবং PR-এ উত্তর দাও, Boss-কে জিজ্ঞেস না করেই:
     **P0/P1 — merge আটকায়, একই branch-এ এখনই ঠিক করতে হবে।**
     **P2 — merge আটকায় না**; PR-এ "পরে করা হবে" লিখে thread resolve করে এগোও।
     **P3 বা তার নিচে — উত্তর দিয়ে resolve; ঠিক করা ঐচ্ছিক।**
     এই মইটাই review-লুপ থামায় — নইলে bot প্রতি রাউন্ডে নতুন ছোট জিনিস পাবে।
   - bot কিছু না বললে সেটাও বলো ("bot এখনো কিছু বলেনি"), চুপ থেকো না।

৬. **merge** — **Boss বললে তবেই**। `gh pr merge --squash` (কার্ড হয়ে যাবে)।
   merge-এর পর `git checkout main && git pull` দিয়ে Mac-টা হালনাগাদ রাখো —
   দুই Mac-এর কাজ এখানেই হারায়।

## এক তথ্য, এক কার্ড — লুপে পড়ো না

approve হওয়ার পর কমান্ডের ফল চ্যাটেই ফিরে আসে — **সেটাই ওই ধাপের উত্তর**। একই
তথ্য আবার জানতে **দ্বিতীয় কার্ড কখনো বানাবে না**; ফলটা পড়ে সোজা পরের ধাপে যাও।
(২০২৬-০৮-০৩ লাইভে ঠিক এটাই হয়েছিল — তালিকা হাতে পাওয়ার পরেও প্রায় একই তালিকার
আরেকটা কার্ড গিয়েছিল, আর Boss-কে দুইবার approve করতে হয়েছিল।)

কমান্ড **একটা একটা করে** দাও। `&&` বা `printf` দিয়ে কয়েকটা পড়ার কমান্ড জোড়া
দিলে পুরোটা approval কার্ড হয়ে যায়, অথচ আলাদা করে দিলে প্রতিটাই সঙ্গে সঙ্গে
চলত — একই তথ্য, শূন্য ট্যাপ।

## এই skill-এর নিজের নিষেধ

- **force push নয়, history বদল নয়, `git reset --hard` নয়** — একটাও করবে না;
  দরকার হলে থামো আর Boss-কে বলো।
- **conflict নিজে resolve করবে না** — কোন ফাইলে, সেটা দেখিয়ে থামো।
- **main-এ সরাসরি commit নয়**, branch delete নয়।
- **`.env` বা কী-ফাইল commit-এ ঢুকছে দেখলে থামো** — সেটা ঠিক করা আগে।
- **CI সবুজ না হওয়া পর্যন্ত "হয়ে গেছে" নয়।** push করা আর পাশ করা এক জিনিস নয়।

## Boss-কে কী বলবে

শেষে চার লাইন: **কোন branch · PR-এর লিংক · CI-এর অবস্থা · bot কী বলেছে ও তুমি কী
করেছ**। merge হয়ে থাকলে সেটাও এক লাইনে, আর Mac হালনাগাদ কিনা।
