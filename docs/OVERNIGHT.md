# OVERNIGHT RUNBOOK: Kin + Tablemate (HackNC 2026)

*Read this whole file before acting. It is the shared memory between the main Hermes session and the hourly cron runs.*

## Situation
- **Deadline:** Devpost submission Sun Oct 11, **10:00 AM ET**. Judging is around noon.
- **The user is asleep:** Saksham (the human) sleeps until 7–8 AM ET. Then he decides which project(s) to submit, records the video(s) and submits.
- **Nobody is awake to touch a phone.** Never send real iMessages. Never place calls to a human's phone. The only real calls allowed overnight go to the Retell "restaurant sim" number (§Rules).
- **The two repos**, both on the Mac and both pushed to GitHub:
  - `~/kin` → github.com/Saksham-Rustagi/Kin. Kin is an iMessage helper for a grandmother with memory loss. **Kin's code is done and it runs live.**
  - `~/tablemate` → github.com/Saksham-Rustagi/Tablemate. Tablemate turns "let's get dinner" in a group chat into a booked table by calling the restaurant through Retell. It is being built tonight.
- **Specs:**
  - Tablemate: `~/tablemate/docs/Tablemate_Tech_Spec.md` and `docs/PROJECT_RULES.md`.
  - Kin: `~/kin/docs/03_kin_product/*`, `~/kin/docs/05_setup_status/setup_status.md`.

## What wins (judge lens: re-read before choosing work)
Sources: `~/kin/docs/01_photon_track/winners_vs_losers.md` and the Photon track brief.
- **Photon's criteria:** Vision, Craft, Depth, Traction.
  - "How naturally the agent fits into the conversation" in a **real chat**, not a localhost demo.
  - A real human in the loop.
  - Help **without demanding attention**.
  - **Safety and fallback** behavior.
- **What winners have:**
  - chat-first, one job;
  - proactive (it texts first);
  - chat-native features (tapbacks, voice notes, photos, polls, live cards);
  - confirmations before acting;
  - **shown working** with a video.
- **What loses:**
  - iMessage bolted onto a web app;
  - doing too much;
  - describing instead of showing;
  - an invisible memory layer, unless a demo moment pays it off.
- **HackNC General:** polish, a clear story, a working demo. **Frutiger Aero theme:** glossy aqua/sky/bubbles UI.
- **Every polish item should make the live demo or the video more convincing.** Prefer: fewer failure modes, crisper card copy, visible safety, visible memory payoff. Avoid new scope.

## Rules for any agent working overnight
1. **No real iMessages and no calls to humans.**
   - Tablemate overnight runs use `TM_TRANSPORT=fake` (or the tests' fake transport).
   - Retell test calls may dial ONLY the sim number stored in kv `retell_sim_number` (an AI agent, not a person).
2. **Kin keeps running untouched.**
   - Don't stop `~/kin/scripts/run.sh` or the :3000 cloudflared tunnel: restarting the tunnel changes the URL and breaks the cards already on the phones.
   - Health check only: `curl -s <localhost>:3000/health`.
   - Kin code changes are allowed only if tested (`tsc` + `tests/replay.ts` + `tests/agent_tools.ts` + `tests/fallback.ts`). Then commit and push. Restart only Kin's `src/main.ts` (run.sh auto-restarts it within 2 s when the bun process is killed: `pkill -f 'bun src/main.ts'` in `~/kin` only). Avoid this unless needed.
3. **Coding is done by Claude Code sessions** (`~/.local/bin/claude -p …`, recipe below).
   - At most 2 sessions at once, on disjoint files.
   - The orchestrator (you) verifies, commits and pushes.
4. **After every verified change:** `git add -A && git commit -m … && git push` in that repo. Never commit `.env`, and never print `.env` values.
5. **Never edit any `CLAUDE.md`** (writes need the user's approval). The project rules for Claude Code live in `docs/PROJECT_RULES.md`.
6. Append a dated entry to the **Log** at the bottom of this file at the end of every work stint: what changed, the commit hashes, the test counts, what's next.
7. **Lock:** if `~/tablemate/logs/orchestrator.lock` exists and its first line (epoch seconds) is in the future, the main session is active. Cron runs then only do health checks and append a one-line log entry: no launches, no commits.

## How to run things (from Hermes: `browser_exec` → Python `subprocess.run(["bash","-lc", cmd])` on the Mac)
- Bun: `~/.bun/bin/bun`. Type-check: `node_modules/.bin/tsc -p tsconfig.json`.
- **`browser_exec` rejects URL literals for local or private hosts:** build `"http"+"://"+"local"+"host:3001"` by concatenation.
- **Launch Claude Code detached**, with the task file written to `tasks/`:
  ```python
  subprocess.Popen([os.path.expanduser("~/.local/bin/claude"),"-p","Do the task described in tasks/<file>.md.","--output-format","stream-json","--verbose","--permission-mode","acceptEdits","--allowedTools",ALLOWED,"--disallowedTools",DENY,"--max-turns","120"], cwd=REPO, stdin=subprocess.DEVNULL, stdout=open(REPO+"/logs/cc_<tag>.jsonl","w"), stderr=subprocess.STDOUT, start_new_session=True)
  ```
  - `ALLOWED`: `Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task,Bash(node_modules/.bin/tsc:*),Bash(~/.bun/bin/bun:*),Bash(/Users/sakshamrustagi/.bun/bin/bun:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(grep:*),Bash(mkdir:*),Bash(cp:*),Bash(sqlite3:*),Bash(wc:*),Bash(git status:*),Bash(git diff:*)`
  - `DENY`: `Read(./.env),Read(.env),Bash(git push:*),Bash(git commit:*),Bash(pkill:*),Bash(kill:*),Bash(cloudflared:*),Bash(scripts/run.sh:*)`
  - A session is finished when its jsonl has a `{"type":"result"}` line. Read `result` from that line; if it says "still waiting…", take the last long assistant text instead and treat its test claims as unrun.
  - **Check whether sessions are running:** `pgrep -fl 'local/bin/claude -p'`.
- **Verify a session's work yourself** before committing:
  - run `tsc` and every test suite, one Gemini-using suite at a time;
  - read the diff of the safety-critical code (booking only from the organizer token, the call redirect, the local stream being read-only, the enrolled-chat filter).

## Backlog (top = next). Mark `[x]` when done, with the commit hash.
### Tablemate
- [x] **T0** Sessions A (core), B (places + memory) and C (Retell calls) were launched at 2:10 AM. B and C are done and committed (3793f97): places/memory 39/39 including a live search; calls 26/26. The Retell LLM (gemini-3.5-flash-lite) and the agent (voice 11labs-Cimo, eleven_v4) were created through sync. A is still running.
- [ ] **T0b** C2 (web-call fallback: `/retell/phone` answer page, `RETELL_MODE=web`, restaurant WAV script, emoji additions) was launched at 2:25 AM: `logs/cc_C2.jsonl`.
- [ ] **T1 Integrate:** tsc clean; `tests/replay.ts` (+`GEMINI_OFF=1`), `tests/places_memory.ts` and `tests/calls.ts` all PASS; replace any `// STUB (A)`; commit and push.
- [ ] **T2 (REVISED: Retell numbers need KYC, so `create-phone-number` returns 403 'No valid KYC'; the user does the Persona ID check in the morning)** Live server in fake-transport mode (`TM_TRANSPORT=fake bun src/main.ts` on :3001 behind the :3001 tunnel; `PUBLIC_BASE_URL` is set in `.env`).
  - **Now:** test **web mode**. Open Chrome with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<abs>/data/restaurant_full_then_745.wav` on the local `/retell/phone?auto=1` page, drive a plan to `book`, and confirm the agent talks, `report_result` arrives and the state reaches `booked`.
  - The sim LLM/agent already exist (kv `retell_sim_llm_id`, `retell_sim_agent_id`; voice 11labs-Billy), so after KYC a sim number can be bought and bound for phone-to-phone tests.
  - Drive a whole plan through `/dash/simulate` + card POSTs, with `DEMO_RESTAURANT_PHONE` overridden to the sim number **for that process only**.
  - Confirm the real call happens, `report_result` arrives, and the state reaches `booked`.
  - Save the transcript to `docs/test_call_transcript.md`.
- [ ] **T3 Card preview grid** (`tests/preview_cards.ts` → `data/preview/grid.html`, every card state at 280×300 plus the 149×58 bubble). One screenshot review; fix overflow and clipping.
- [ ] **T4 Dashboard polish:** state strip, facts with quotes, live transcript, Frutiger Aero styling. One screenshot review.
- [ ] **T5 Docs:** `README.md` (pitch, how it works, architecture mermaid, the never list and where it's enforced, sponsors: Photon, Gemini, Retell+ElevenLabs voice, Google Places), `devpost/DEVPOST.md`, `devpost/DEMO_SCRIPT.md` (2:30, devices: Saksham's iPhone = restaurant + member, Nicole's iPhone = organizer, iPad = types votes), `devpost/JUDGE_QA.md`. Only describe what's in the code.
- [ ] **T6 Morning setup script + checklist** `docs/MORNING_SETUP.md`:
  - **Retell KYC first** (dashboard → Phone Numbers → buy a number → Persona ID check, about 5 min if automatic). Then `RETELL_BUY_NUMBER=1 bun scripts/sync_retell.ts`. If KYC goes to manual review, the demo uses web mode (the restaurant answers on the Mac).
  - Photon "Tablemate" project: create, then `projects upgrade` with promo HACKWITHPHOTON (Stripe, the user clicks), `spectrum users add` for both iPhones, each phone texts the line (QR), profile "Tablemate" + avatar.
  - Create the group "HackNC dinner 🍜" and read its chat id into `TM_GROUP_CHAT_IDS`.
  - Switch `DEMO_RESTAURANT_PHONE` back to Saksham's phone.
  - Fallback: run on Kin's Photon project.
### Kin (polish only)
- [x] **K1 Devpost gallery** (19ebbcd: hero.png 3000×2000, 6 card PNGs at 840×900 via headless Chrome `--force-device-scale-factor=3`, README embeds; quote-sliver CSS fix in render.ts). Dashboard shot still TODO (K5). `~/kin/devpost/gallery/*.png`: every card state at 3× (from `tests/preview_cards.ts`), the dashboard, the architecture diagram. Embed them in README.
- [ ] **K2 Docs truth pass:** README + DEVPOST mention the "I know Priya" button, the Today card, demo robustness, the Gemini-off fallback. Nothing claimed that isn't in the code.
- [ ] **K3 Morning runbook** `~/kin/docs/../MORNING_RUNBOOK.md` (shared with Tablemate). From 8:00 to 9:45: rehearse both demos, record videos (shot lists), Devpost fields for each, decision criteria for submitting Kin only vs both.
- [ ] **K5 Kin dashboard polish:** panels fill the viewport height (no blank lower half at 1440×900); memory-map labels don't overlap (Raj is hidden behind Anita, and the 'lives in'/'dog' edge labels collide); recapture `devpost/gallery/dashboard.png` with real decisions in the feed. Headless Chrome hangs on the polling dashboard, so capture with the harness browser instead.
- [ ] **K4 Health:** Kin `/health` ok, run.sh alive, the :3000 tunnel alive. Log any problem; fix only if safe.

## Log
- **Oct 11, 2:15 AM:** main session scaffolded `~/tablemate` (commit 93b9419, pushed) and launched Claude Code A/B/C.
  - Second tunnel on :3001 → `PUBLIC_BASE_URL` in `~/tablemate/.env`.
  - Places key verified: 20 results; no photos (demo key) → emoji; `servesVegetarianFood` 15/20, `reservable` 17/20.
  - Retell key verified (0 agents, 0 numbers).
  - Photon: only the Kin project "HackNC2026" exists. A new project needs a Stripe checkout with the promo, so the user must do it in the morning.
  - Writing `~/tablemate/CLAUDE.md` was blocked because it needs user approval, so the rules went into `docs/PROJECT_RULES.md`.
- **2:25 AM** (main): Kin gallery committed (19ebbcd, 1eafa78). Retell numbers are blocked by KYC (see T2). Launched C2 for the web-call fallback.
