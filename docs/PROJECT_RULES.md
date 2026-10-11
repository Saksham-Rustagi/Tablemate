# Tablemate — project rules for coding sessions

Tablemate turns "let's get dinner" in a real iMessage **group chat** into a **booked table** (HackNC 2026, Photon AI Agent track).
- **Reading the group:** the Mac reads the enrolled group through Photon Spectrum's **local** provider (`@spectrum-ts/imessage-local`), read-only.
- **The card:** Tablemate's own Photon **cloud** line DMs every member **one shared live mini-app card** (`app()` + `edit()`). Members vote with a tap, or by typing "2" in the group.
- **Booking:** the organizer taps ✅ Book, and **Retell AI** phones the restaurant.
- **AI vs code:** Gemini (`gemini-3.5-flash-lite`) extracts facts and intent as JSON; **plain code decides every action**.
- **Restaurants:** Google Places API (New).

**Reference files**
- **Full spec:** `docs/Tablemate_Tech_Spec.md` (read §3 limits, §5 rules, §7–§13).
- **Module contracts:** `src/contracts.ts`. Don't change signatures without updating every implementer.
- **Kin:** this repo was scaffolded from the sibling project `~/kin` (same author, same stack). `kin_ref/` is a read-only copy of Kin's source for reference and is excluded from tsc. Never edit `~/kin`.

## Run / test (macOS only; Bun is NOT on PATH)
- **Type-check:** `node_modules/.bin/tsc -p tsconfig.json` must exit 0 for the files you own.
- **Tests:** `~/.bun/bin/bun tests/<name>.ts`. Each test uses its own DB file (`TM_DB=data/<name>.db`) and the fake transport. Never run two Gemini-calling tests at the same time, because they share one free-tier key.
- **Processes:** don't start, stop or kill `src/main.ts`, `cloudflared`, `scripts/run.sh` or any other process.
- **No real calls or messages:** never place real phone calls or send real iMessages. Retell and Places HTTP calls in tests must be mocked unless the task says otherwise.
- **Git:** don't `git commit` or `git push`; the orchestrator reviews and commits.

## Hard rules (Tablemate's never list — enforce and test in code)
1. **Never books without the organizer's ✅ tap**, meaning the `book` card action from the organizer's token. No text, AI output or timer can start a call.
2. **At most 3 calls per plan.** Never the same place twice per plan, and only during the place's opening hours.
3. **Every call opens by saying it's an AI assistant booking for <name>.** It never gives payment details. "Card required" → hand back to the group.
4. **Never accepts a time outside the window** (chosen time ±30 min) without the group's tap.
5. **Allergies are told to the restaurant.** Tablemate never says a place is safe for an allergy.
6. **Learns only from enrolled group chats** (`TM_GROUP_CHAT_IDS`).
   - Each fact carries who said it, the exact quote and the time.
   - Facts never cross groups.
   - Never invent a fact: the quote must be a substring of a real message.
7. **Speaks rarely:** one offer (organizer only), one plan card per member (edited in place), one booked message.
   - **It never posts in the group and never sends as anyone.** The local provider is read-only.
8. **Demo safety:** every call is redirected to `DEMO_RESTAURANT_PHONE` unless `REAL_CALLS=1` **and** the place is in `REAL_CALL_ALLOWLIST`.

**Secrets and privacy**
- Never read or print `.env`; use `process.env`.
- The Gemini key is free tier, so use made-up demo data only.
- The Mac's Messages account is Saksham's real Apple ID. The local stream must drop everything outside `TM_GROUP_CHAT_IDS` before logging it.

## Platform facts (verified on devices with Kin)
- **Photon Pro limits:**
  - Cloud lines can't join groups.
  - They can only message **phone numbers** that are registered as project users and have texted the line first.
  - Email handles (the iPad) can't receive cards, so they vote by typing in the group.
- **Card webview:**
  - Size: 280×300 when opened, 149×58 in the bubble.
  - Taps are NOT Spectrum events; the card page POSTs `/plan/:id/act?t=…`.
  - `edit()` updates the same bubble.
  - Quick tunnels don't support SSE, so open pages poll `/plan/:id/state` every 2 s.
- **Card page code:** plain inline ES5-style JS, no build step. Style it with Kin's glossy Frutiger Aero CSS (see `kin_ref/cards/render.ts`).
- **Retell blocks localhost:** tool and webhook URLs use `PUBLIC_BASE_URL`, a Cloudflare quick tunnel to :3001.
