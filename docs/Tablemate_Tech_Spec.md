# Tablemate — Product + Tech Spec (HackNC 2026, built in parallel with Kin)

*Written Sun Oct 11, 12:20 AM ET. Decision point: **5:30 AM**, when we pick which project(s) to submit. Devpost is due 10:00 AM.*
Source tags: **[DEV]** verified on our devices with Kin · **[DOC]** vendor docs read tonight (URL in §12) · **[ASSUME]** not yet verified; there is a Step-0 check for it.

---

## 1. One job
**Turn "let's get dinner" in a group chat into a booked table.**

Without Tablemate, the chat argues about where to eat for 40 messages, nobody books, and the plan dies. With Tablemate, the group gets 3 places that fit everyone and votes with one tap. Tablemate then phones the restaurant and every phone shows "✅ Sitar · 7:45 · table for 3".

**How it differs from Concierge** (MHacks 2026 Photon winner, whose agent phoned businesses). Our research rejected a planner as "too close to Concierge" (`01_photon_track/winners_vs_losers.md` §6). The difference has to be the **group**:
- **Group memory from the chat:** "Skipping Sushi Nara: Nicole's vegetarian (she said so Thursday)."
- **One shared live card that everyone votes on.** Each tap updates every member's card.
- **The call happens only after the group has decided.** If the restaurant offers a time outside the window, it goes back to the group.

The pitch leads with the group, not the call.

## 2. Decisions (with Saksham, 12:15 AM)
| Topic | Decision |
|---|---|
| Kin vs Tablemate | Build Tablemate now; decide what to submit at **5:30 AM** |
| Group chat | **Synced cards.** The Mac reads the real group chat through Spectrum **local**, where Saksham is a member. Tablemate's own **cloud** line DMs each member the same live card. Tablemate never posts in the group. |
| Phone call | **Retell AI** (about $10 of free credits; a $2/mo number needs a card). Its LLM runs Gemini 3.5 Flash-Lite and its voice is ElevenLabs. |
| Restaurant data | **Google Places API (New)**; Saksham creates a key with billing |
| Devices | Saksham's iPhone + Nicole's iPhone + Nicole's iPad + the Mac (same as Kin). **Saksham's iPhone answers as the restaurant.** |
| Made by me (change if you disagree) | The booking is under the plan's organizer (whoever said "dinner?" and tapped 👍). Voting closes when the organizer taps ✅ Book, or at a demo deadline of 2 min (real: 45 min). Separate repo `~/tablemate` that copies Kin's modules. |

## 3. Hard platform limits that shape the design
1. **Photon Pro can't join group chats.** Only Business can **[DEV]**. That's why Tablemate reads the group locally and DMs the cards.
2. **Pro cloud lines can only message phone numbers** that are registered project users *and* have texted their line first **[DEV]**. So **only Saksham's and Nicole's iPhones receive cards.** The iPad (email handle) can't receive cards, so it **votes by typing** in the group ("2", "Sitar", "I'm in"). That counts as a feature: you can vote by tapping or by typing.
3. **The local provider sends as Saksham** and has no cards, edits or effects **[DEV]**. Tablemate never uses it to send. It only reads.
4. **Kin runs on the same Mac.** Kin's router already drops every group message (`router.ts:58`, "G1 group mode not enabled") **[DEV]**. The two processes read `chat.db` read-only and don't conflict. Tablemate reads **only** the group chat IDs in `TM_GROUP_CHAT_IDS`. Everything else, including Saksham's real texts, is ignored.
5. **Real phone calls:** the Twilio trial blocks ElevenLabs streams, and Photon SIP needs Business **[DOC]**. Hence Retell.
6. **Retell won't call localhost** for tools or webhooks **[DOC]**, so it uses a second Cloudflare quick tunnel to `:3001`. The hostname changes on every restart, so keep it running.

## 4. The loop (what the demo shows)
```
Group: Nicole: "dinner tonight? 🍜"   ← Mac reads it (local); Gemini: is_plan 0.93, tonight 6:30–8:30
  │  (one offer, organizer only)
  ▼
Nicole's DM from Tablemate: card "🍽️ Dinner tonight? Want me to find spots near campus?" [👍 Find spots] [Not now]
  │  👍
  ▼
Everyone's DM: ONE plan card (same plan, per-member token)
  ├─ 3 options: photo · name · $$ · ★4.6 · 6 min walk · "Vegetarian menu — Nicole's vegetarian"
  ├─ "Skipping Sushi Nara: Nicole's vegetarian"           ← memory, with who + when
  ├─ tap to vote · I'm in / can't · time chips 7:00 / 7:30 / 8:00
  └─ live tally "2 votes Sitar · 3 in · 7:30"  (edit() on every member's card, page polls state)
  │  organizer taps ✅ Book Sitar 7:30 for 3
  ▼
Retell outbound call → Saksham's iPhone (demo restaurant)  — dashboard shows live transcript
  "Hi, I'm an AI assistant calling to book a table for Nicole. Do you have a table for 3 at 7:30 tonight?"
  ├─ "We're full"           → report_result{full} → card: "Sitar is full · calling Mediterranean Deli…" → next option (vote order)
  ├─ "Only 9:15"            → outside window → card asks the group: [Take 9:15] [Try next place]
  └─ "7:45 works"           → within ±30 min → report_result{booked, 7:45}
  ▼
Every card flips: ✅ Mediterranean Deli · 7:45 · table for 3 · under Nicole · 📍 address · 📅 invite
+ celebration effect DM + .ics attachment
```

## 5. Rules (Tablemate's never list, enforced in code)
1. **Never books without the organizer's ✅.** No text or AI decision can start a call. Only the `book` card action from the organizer's token can.
2. **At most 3 calls per plan.** Never calls the same place twice in one plan. Only calls during the place's opening hours (from `regularOpeningHours`, America/New_York).
3. **Discloses that it's an AI in the first sentence of every call.** It gives only the booking name and the organizer's callback number. It never gives payment details. If a card is required, it says "I'll have them call you back", ends the call, and the case goes back to the group.
4. **Never accepts a time outside the window** (±30 min of the chosen time) without the group's tap.
5. **Allergies are hard facts, never "safe".** They're told to the restaurant on the call. Tablemate never claims a place is safe for an allergy. Diet filters use only Places' `servesVegetarianFood`.
6. **Learns only from the enrolled group.** Each fact stores who, quote, message id and time. Facts never cross between groups. A "forget" control is in the dashboard; a "Tablemate, forget my …" text is a stretch goal.
7. **Speaks rarely:** one offer, one plan card per person (edited in place), one booked message. It never posts in the group and never sends as anyone.
8. **Demo safety:** every call goes to `DEMO_RESTAURANT_PHONE` (Saksham) unless `REAL_CALLS=1` **and** the place is in `REAL_CALL_ALLOWLIST`. Logs and the dashboard show "📞 Demo call: Sitar → Saksham's phone".
9. **Intent bar:** offer only when Gemini confidence ≥ 0.8 **and** there's a meal or eating-together signal. At most one offer per chat per 6 h, and none while a plan is active. "I'm hungry lol" → no offer.

## 6. Architecture
```
iPhones/iPad ──(group iMessage)──► Mac Messages (Saksham's Apple ID) ─► chat.db
                                                        │ Spectrum LOCAL (read only, TM_GROUP_CHAT_IDS)
                                                        ▼
                                       Tablemate (Bun, ~/tablemate, :3001)
             ┌──────────────┬──────────────┬────────────┴────────┬────────────────┐
         Gemini 3.5 FL   Google Places   SQLite (plans,        Retell API      Dashboard /dash
         (1 call/burst)  (searchText,    facts, votes, calls)  (create call)   (state, memory,
                          photos, cache)                         ▲   │          live transcript)
                                                                 │   ▼
                         Spectrum CLOUD line "Tablemate" ──► app() cards + edit() to each member
                         card taps → https://<tunnel>/plan/:id/act ─┘   restaurant phone ◄── Retell (Gemini brain, ElevenLabs voice)
                                         Retell → /retell/tool/report_result, /retell/webhook (signed)
```
**Reused from `~/kin`** (copy, then trim): `transport.ts` (cloud + local + fake), `cards/service.ts` (HMAC tokens, `app()`/`edit()`, card rows), the Frutiger Aero CSS from `cards/render.ts`, `server.ts` skeleton, `ai/gemini.ts` (REST + responseSchema + budget + `GEMINI_OFF`), `db.ts` (bun:sqlite + kv), dashboard event bus, `scripts/run.sh`, `tests/replay.ts` harness.

**Separate from Kin:** port `3001`, its own quick tunnel, `~/tablemate/.env`, its own Photon project and line (contact "Tablemate" + avatar), and its own DB.

## 7. Modules
| File | Job |
|---|---|
| `src/main.ts` | boot: db, transport, server, tunnel base URL, `ensureRetellSynced()` |
| `src/transport.ts` | from Kin. Local stream filtered to `TM_GROUP_CHAT_IDS`; cloud `sendCard/editCard/sendText/sendEffect/sendAttachment` |
| `src/router.ts` | dedupe by msg id; **8 s debounce per chat**; drop anything outside the enrolled groups; route group turns → `onGroupTurn`; cloud DMs from members → `onMemberDm` (P2) |
| `src/ai/gemini.ts` | from Kin. Schemas below |
| `src/brain.ts` | `onGroupTurn`: one Gemini call → facts + intent + text votes/RSVPs. Code decides everything else |
| `src/memory.ts` | `fact` CRUD, dedupe (person, kind, value), `factsFor(chat)`, the "why it fits" and "skipping" lines (code templates that reference real facts only) |
| `src/places.ts` | `searchPlaces(plan, facts)` → Places Text Search → **code filter + score** → top 3 + 1 "skipping" example; photo download → `data/media/*.jpg`; SQLite cache (24 h) |
| `src/plan.ts` | state machine (§8), votes, RSVPs, deadline timer, `editAll(plan)` |
| `src/calls.ts` | Retell: create call, handle `report_result` tool + webhooks, advance to next option, idempotency per (plan, attempt) |
| `src/retell_sync.ts` | create or update the Retell LLM + agent + number binding; re-sync tool URLs when `PUBLIC_BASE_URL` changes (same pattern as Kin's `agent.ts`) |
| `src/cards/render.ts` | offer card, plan card (vote / headcount / book screens), calling, ask-group, booked, bubble (280×300 opened, 149×58 bubble **[DEV]**) |
| `src/server.ts` | `/plan/:id?t=`, `/plan/:id/state?t=` (polled every 2 s while open; quick tunnels don't do SSE **[DEV]**), `/plan/:id/act?t=`, `/plan/:id/invite.ics`, `/retell/tool/report_result`, `/retell/webhook`, `/media/*`, `/dash`, `/dash/*` (localhost only) |
| `src/dash/page.ts` | state machine strip (current state lit), memory facts with quotes, filter decisions, votes, **live call transcript** (Retell `transcript_updated`), Reset demo button |

## 8. Plan state machine
```
idle ─(is_plan, organizer)→ offered ─👍→ voting ─organizer ✅ (or deadline + organizer ✅)→ booking
offered ─"Not now"/30 min→ idle (no re-offer for 6 h)
booking → calling[i] ─booked (time within ±30 min)→ booked ✅
                     ├─full / no reservations / voicemail / no answer→ calling[i+1]  (max 3, vote order)
                     ├─offered time outside the window→ asking_group ─[Take it]→ calling[i] again to confirm, or record the hold if they said it's held
                     │                                     └─[Try next]→ calling[i+1]
                     └─card required / 3 failures→ handed_back ("I couldn't book. Here are the numbers.")
any ─organizer "Cancel plan"→ cancelled
```
- One active plan per chat. Every transition is a row in `plan_event` and a dashboard event.
- `editAll(plan)` edits every member's card (`caption`/`subcaption`). Open card pages poll `/state`.
- Restart-safe: on boot, any plan stuck in `calling` with no live call is moved to `handed_back`. A webhook may still arrive after that, and is handled idempotently.

## 9. Data (bun:sqlite, `data/tablemate.db`)
```
person(handle PK, name, is_card_capable INT)              -- from TM_PEOPLE in .env
fact(id, chat_id, handle, kind CHECK(kind IN('diet','allergy','dislike','like','budget','availability')),
     value, quote, msg_id, said_at, source CHECK(source IN('chat','demo_seed')), active INT)
plan(id, chat_id, organizer, state, meal, day, window_start, window_end, chosen_time, area,
     created_at, deadline_at, booked_place_id, booked_time, booked_party, booking_name)
option(plan_id, idx, place_id, name, address, phone, photo, price_level, rating, walk_min, why, PRIMARY KEY(plan_id, idx))
skipped(plan_id, place_id, name, reason, fact_id)
vote(plan_id, handle, option_idx, via CHECK(via IN('card','text')), at, PRIMARY KEY(plan_id, handle))
rsvp(plan_id, handle, status CHECK(status IN('in','out')), time_pref, at, PRIMARY KEY(plan_id, handle))
call(id, plan_id, attempt, place_id, retell_call_id UNIQUE, to_number, status, result_json, transcript, started_at, ended_at)
card(id, plan_id, handle, message_id, token, kind)
plan_event(id, plan_id, at, from_state, to_state, why)
places_cache(query_key PK, json, at)   kv(key PK, value)
```

## 10. Gemini (one call per debounced group burst; `gemini-3.5-flash-lite`, JSON schema)
**Input:** the burst's messages (speaker name + text), the last 20 messages for context, the active plan summary (state, option names numbered 1–3), and today's date and time in America/New_York.
**Output schema `groupTurn`:**
```json
{
  "intent": { "is_plan": bool, "confidence": 0-1, "meal": "breakfast|lunch|dinner|drinks|food|null",
              "day": "YYYY-MM-DD|null", "time_window": {"start":"HH:MM|null","end":"HH:MM|null"},
              "area_hint": "string|null", "organizer_handle": "string|null" },
  "facts": [ { "handle": "...", "kind": "diet|allergy|dislike|like|budget|availability",
               "value": "vegetarian", "quote": "exact words from the message", "msg_index": 0 } ],
  "text_votes": [ { "handle": "...", "option_number": 1-3 } ],
  "rsvps": [ { "handle": "...", "status": "in|out", "time_pref": "HH:MM|null" } ]
}
```
**Code verifies everything:**
- every `handle` is a group member;
- every `quote` is a substring of that member's message, otherwise the fact is dropped (no invented facts);
- `option_number` maps to an existing option.

Defaults: "tonight" with no time → window 18:30–20:30; chosen time defaults to the window start + 1 h, rounded to :00/:30.
**Fallback (`GEMINI_OFF` or error):** regex intent (`/\b(dinner|lunch|eat|food)\b.*\?|let'?s (get|grab)/i`), text votes `/^\s*[1-3]\s*$/`, RSVP `/\b(i'?m in|count me in|i'?m down)\b/i`. No facts are extracted (none invented).
**Budget:** ≤ 1 call per burst; ~15/min cap shared with nothing else (Kin uses its own key budget; check the free-tier RPM; both use the same key → `TM_GEMINI_API_KEY` may be a second key).

## 11. Places (Google Places API (New))
- **Search:** `POST https://places.googleapis.com/v1/places:searchText`. Headers: `X-Goog-Api-Key`, `X-Goog-FieldMask` (required; no spaces) **[DOC]**.
  Body: `{ "textQuery": "<cuisine or 'restaurant'> near Franklin Street Chapel Hill", "includedType": "restaurant", "locationBias": { "circle": { "center": { "latitude": 35.9121, "longitude": -79.0512 }, "radius": 1500 } }, "pageSize": 20 }`.
  Optional `priceLevels: ["PRICE_LEVEL_INEXPENSIVE","PRICE_LEVEL_MODERATE"]` when someone said they're broke **[DOC]**.
- **Field mask:** `places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours,places.nationalPhoneNumber,places.internationalPhoneNumber,places.photos,places.primaryType,places.primaryTypeDisplayName,places.reservable,places.servesVegetarianFood,places.servesDinner,places.googleMapsUri`.
  `reservable`/`servesVegetarianFood` put the request in a higher SKU. Check the free monthly cap in the Cloud console **[ASSUME]**. Cache by query for 24 h; tonight's demo needs maybe 20 calls.
- **Photo:** `GET https://places.googleapis.com/v1/{photos[0].name}/media?maxWidthPx=400&key=…` → save `data/media/<placeId>.jpg`.
- **Filter (code, in this order):**
  1. has an international phone number
  2. open at `chosen_time` per `regularOpeningHours`
  3. `servesDinner !== false` for dinner
  4. diet facts: vegetarian/vegan → `servesVegetarianFood === true` (vegan is shown as "vegetarian options; vegan not confirmed")
  5. dislikes → exclude matching `primaryType` (e.g. "hates sushi" → `sushi_restaurant`, `japanese_restaurant`) via a small code map
  6. budget → `priceLevel ≤ MODERATE`
  7. `reservable === false` → drop (unknown is allowed, ranked lower)
- **Score:** `rating × log10(userRatingCount+1) + (reservable ? 0.5 : 0) − walk_min/20`. Top 3 with distinct `primaryType` where possible. `walk_min` = haversine metres / 80.
- **"Skipping" line:** the highest-scored place removed by a fact filter → "Skipping Sushi Nara: Nicole's vegetarian (Thu)". Must cite a real `fact` row.
- **"Why it fits" line:** code template from the matching filters ("Vegetarian menu · Nicole's vegetarian", "$ · fits Raj's budget", "6 min walk"). No AI wording is needed.

## 12. Retell (the restaurant call)
- **Auth:** `Authorization: Bearer $RETELL_API_KEY`, base `https://api.retellai.com` **[DOC]**.
- **Sync (`retell_sync.ts`, idempotent; ids kept in kv):**
  1. `POST /create-retell-llm` (later `PATCH /update-retell-llm/{id}`) with:
     - `model` = Gemini 3.5 Flash-Lite (exact enum id **[ASSUME]**; it's listed on the pricing page);
     - `start_speaker: "user"`, because the restaurant answers first;
     - `general_prompt` (below) and `general_tools`:
       - `{ type: "custom", name: "report_result", url: "${PUBLIC_BASE_URL}/retell/tool/report_result", method: "POST", description, parameters }`;
       - an `end_call` tool.
     - `plan_id` and `attempt` are `const` params set from dynamic variables `{{plan_id}}`/`{{attempt}}`, so the LLM can't change them **[DOC: custom functions: "a property with a const value is applied directly"; dynamic variables work in const]**.
  2. `POST /create-agent` with `response_engine: { type: "retell-llm", llm_id }`, an ElevenLabs voice (`11labs-*`), `webhook_url: ${PUBLIC_BASE_URL}/retell/webhook`, and post-call analysis fields (`outcome`, `booked_time`, `party_size`) as a backup if the tool isn't called (field names **[ASSUME]**, check the agent schema).
  3. `POST /create-phone-number { area_code: 919, outbound_agents: [{ agent_id, weight: 1 }] }` ($2/mo) **[DOC]**.
- **Place a call:** `POST /v2/create-phone-call` **[DOC]** with:
  - `from_number`, `to_number` = `DEMO_RESTAURANT_PHONE` (see rule 8);
  - `idempotency_key` = `${plan_id}-${attempt}`;
  - `metadata: { plan_id, attempt }`;
  - `retell_llm_dynamic_variables` (all strings): `restaurant_name, party_size, time_12h, window_start, window_end, booking_name, callback_number, allergies, plan_id, attempt`.
- **Prompt essentials:**
  - Open with "Hi! I'm an AI assistant calling to book a table for {{booking_name}}."
  - Ask for a table for {{party_size}} at {{time_12h}} tonight.
  - Accept any time between {{window_start}} and {{window_end}}. For anything else, say you'll check with the group, call `report_result` with `offered_other_time`, and end politely.
  - Mention allergies ({{allergies}}) once it's booked. Never give payment details; if a card is required → `card_required`.
  - Call `report_result` exactly once before ending. Keep it short and friendly. If voicemail → `voicemail`, no message.
- **`report_result` params:** `{ status: "booked|full|offered_other_time|no_reservations|card_required|voicemail|other", time: "HH:MM|null", party_size: number|null, name: string|null, note: string|null }` + consts `plan_id`, `attempt`.
- **Security:**
  - The request body includes a `call` object with metadata and dynamic variables. Verify `X-Retell-Signature` with the SDK (`Retell.verify(rawBody, RETELL_API_KEY, signature)`) on the **raw** body **[DOC]**.
  - Reject anything where `call.metadata.plan_id` isn't the plan's current attempt.
- **Webhooks:** `call_started`, `call_ended`, `call_analyzed`, `transcript_updated` (live transcript → dashboard) **[DOC]**. 10 s timeout and up to 3 retries, so handlers must be idempotent and fast; do the work after responding.
  - On `call_ended` with no `report_result` → use `call_analyzed` fields; otherwise `other` → next option.
- **Code decides the outcome:**
  - `booked` with time within ±30 min of chosen → `booked`;
  - `booked` outside the window (shouldn't happen) → `asking_group`;
  - `full`/`no_reservations`/`voicemail`/`other`/no answer → next option;
  - `card_required` → `handed_back`.

## 13. Cards (app() + edit(); Kin's Frutiger Aero CSS; 280×300)
| Card | To | Content / buttons |
|---|---|---|
| Offer | organizer only | 🍽️ "Dinner tonight?" / "Want me to find spots near campus?" · **👍 Find spots** · Not now |
| Plan: vote screen | every card-capable member | 3 rows (photo 44 px, name, $$ · ★ · walk, why line) tappable to vote, with a ✓ on your vote and counts · one "Skipping …" line · **I'm in** / **Can't** · time chips. Organizer also sees **✅ Book <leader> <time> for <N>** (enabled once ≥ 1 vote) |
| Calling | all | 📞 "Calling Sitar…", then "Sitar is full — trying Mediterranean Deli" |
| Ask group | all | "Mediterranean Deli only has 9:15." · **Take 9:15** · **Try next place** (organizer's tap decides; others' taps show as votes) |
| Booked | all | ✅ name · time · "table for N · under Nicole" · address (Maps link) · **📅 Add to calendar** (`/invite.ics`) + in-card confetti |
| Handed back | all | "I couldn't get a table. Here are the numbers:" + 3 tap-to-call links |

**Bubble layout:** caption = place or plan title, subcaption = live tally ("3 in · Sitar leads").

**After booking:**
- one DM `effect("Booked! 🎉", imessage.effect.message.celebration)` (cloud only **[DOC: Photon ref §1/§4]**);
- the `.ics` sent as `attachment(buffer, { name: "dinner.ics", mimeType: "text/calendar" })`. Whether iOS offers "Add to Calendar" from a Messages `.ics` is **[ASSUME]**; the in-card link is the fallback.

## 14. Config (`~/tablemate/.env`; never print values)
`PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` (new Tablemate project) · `TM_GROUP_CHAT_IDS` · `TM_PEOPLE` (`Name:handle,…`; card-capable = phone numbers) · `GEMINI_API_KEY` · `GOOGLE_PLACES_API_KEY` · `RETELL_API_KEY` · `RETELL_FROM_NUMBER` (filled by sync) · `DEMO_RESTAURANT_PHONE` (Saksham) · `REAL_CALLS=0` · `REAL_CALL_ALLOWLIST=` · `PUBLIC_BASE_URL` (tunnel) · `CARD_HMAC_SECRET` · `DEMO_FAST=1` (2-min deadline) · `CAMPUS_LAT/LNG`.

## 15. Build plan (now → 5:30 AM)
**Step 0 — de-risk (12:30–1:15)**
| # | Check | PASS means |
|---|---|---|
| 0a | Saksham: Retell account + card, API key into `.env`; Google Cloud project + billing + Places API (New) key | keys set (checked without printing) |
| 0b | Photon: `photon projects create` "Tablemate" → apply the HACKWITHPHOTON Pro promo (`projects upgrade`/`billing`) → register both iPhones → each texts the line → profile "Tablemate" + avatar | a test card arrives on both iPhones. **Fallback:** reuse Kin's project and line and rename the profile while recording |
| 0c | **One real Retell call** to Saksham's phone through the tunnel; the `report_result` tool hits `/retell/tool/report_result` with a valid signature | the result is logged with plan_id. **Riskiest piece: do it first** |
| 0d | Places search near Franklin St returns phone, hours, `servesVegetarianFood`, `reservable` and a photo | ≥ 10 places with fields |
| 0e | Make the group "HackNC dinner 🍜" (Saksham + Nicole's iPhone + the iPad); the Mac sees it in `chat.db` with 3 handles; record the chat id | `TM_GROUP_CHAT_IDS` set. Watch for Nicole's phone and iPad merging into one Apple ID participant |

**Steps 1–4: three Claude Code sessions in parallel, on disjoint files (1:15–4:15)**
- **A: chat + cards:** copy Kin's modules, router (enrolled group only, debounce), `brain.ts` + Gemini schema, `plan.ts` state machine, all cards, `server.ts` routes, `editAll`, and a replay test with a fake transport.
- **B: Places + memory:** `places.ts` (search, filter, score, photos, cache), `memory.ts` (facts, verify quotes, "why"/"skipping" lines), and unit tests over a saved Places JSON fixture.
- **C: call:** `retell_sync.ts`, `calls.ts` (create, tool, webhooks, signature, next-option logic, idempotency), dashboard live transcript, and a test that fakes Retell tool and webhook posts.

**Step 5 — wire and run on devices (4:15–5:15).** Full loop once with GEMINI on and once with `GEMINI_OFF=1`. Rehearse "full → next place → booked".

**Step 6 — 5:30 AM decision.** Compare against Kin.
- **If Tablemate isn't booking end to end on the phones by then, submit Kin only.**
- If both are solid, ask #event-support whether 2 submissions are allowed; at most 4 prizes per team either way.

## 16. Demo (2:30)
| Time | What happens |
|---|---|
| 0:00 | A real group chat stalls on "where should we eat?" (seed real history tonight: Nicole "I'm vegetarian btw", Saksham "broke this week lol", iPad "can't do after 8:30") |
| 0:20 | Nicole: "dinner tonight?" → only Nicole gets the offer card → 👍 |
| 0:35 | Both iPhones show the plan card: 3 spots + "Skipping Sushi Nara: Nicole's vegetarian (Thu)". The dashboard shows the facts with quotes |
| 0:55 | Taps on the phones, plus "2" typed from the iPad in the group → the tally updates on both cards |
| 1:15 | Nicole taps ✅ Book → Saksham's iPhone rings → "We're full tonight" → the card flips to "trying Mediterranean Deli…" |
| 1:45 | Second call: "We can do 7:45" → every card ✅ + confetti + 📅 |
| 2:10 | Close on the never list: asks before booking, says it's an AI, never pays, allergies never "safe" |

The dashboard runs the live transcript side by side. A recorded backup of a good call is kept in case the room is noisy.

## 17. Prize fit (if submitted)
- **Photon:** lives off a real group chat; synced live cards + `edit()`; proactive single offer; confirmation before acting; effects; tap or type to vote.
- **Gemini:** one structured call extracts facts with verified quotes, intent and text votes. Gemini 3.5 Flash-Lite also runs the phone agent inside Retell.
- **ElevenLabs:** only the call voice, through Retell. That's a weaker claim than Kin's direct `eleven_v4` + in-card WebRTC agent, so keep ElevenLabs on Kin.
- **Frutiger Aero:** cards and dashboard.
- **General.**

## 18. Sources
- Retell: docs.retellai.com/api-references/create-phone-call · /api-references/create-retell-llm · /api-references/create-phone-number · /build/single-multi-prompt/custom-function · /build/dynamic-variables · /features/webhook-overview · retellai.com/pricing (all read Oct 11, 12:10 AM)
- Google: developers.google.com/maps/documentation/places/web-service/text-search
- Photon/Spectrum: `04_research/photon_spectrum/KIN_PHOTON_REFERENCE.md` (effects, attachments, polls; local can't edit/effect), `05_setup_status/setup_status.md` (Pro limits verified on devices)
- Original idea + safety rules: `03_kin_product/proposals_google_doc_export.md` → "Tab: Tablemate"
