Read docs/PROJECT_RULES.md, `docs/Tablemate_Tech_Spec.md` §12 and `src/contracts.ts` first. You are **session C2**. You own `src/calls.ts`, `src/retell_sync.ts`, `src/cuisine.ts`, `scripts/*` (except run.sh), and `tests/calls.ts`. Session A is still editing everything else (server.ts, plan.ts, dash/*, cards/*): don't touch those files. `/retell/*` paths are already delegated by A's server to `calls.retellRoutes(req, url)`, so new pages and routes under `/retell/` are yours. Ignore tsc errors in A's files. Budget is about 75 min.

## Why
Retell refuses to sell phone numbers until the account passes KYC (`POST /create-phone-number` → 403 "No valid KYC, please visit the dashboard…"). KYC uses Persona with a government ID, which only the human can do in the morning, and it can go to manual review. **The demo must work without a phone number**: a **web call** (WebRTC) to the same Retell agent, with the "restaurant host" answering in a browser on the Mac. The same LLM, the same `report_result` tool and the same webhooks apply. When a number exists (kv `retell_from_number`), phone mode works exactly as now.

## Build
1. **Mode:** `RETELL_MODE` = `phone` | `web`. The default is `phone` if kv `retell_from_number` is set, otherwise `web`.
2. **Web mode `placeCall(req)`:**
   - Apply the same validations as today (max 3 attempts, no repeat place, demo redirect irrelevant).
   - Record a call row with `dialed="web"` and `status="ringing"`, plus everything needed to start the call later (agent id, dynamic vars, metadata).
   - Emit a `call` event, phase `dialing`, detail "Calling <restaurant> (demo line)…".
   - Return `{ ok: true, callId, dialed: "web" }`. **Do NOT create the Retell web call yet**: web-call access tokens expire quickly if nobody joins (check the docs for the exact window at docs.retellai.com/api-references/create-web-call).
3. **Routes (all localhost-only, so reject if `Host` isn't localhost / 127.0.0.1):**
   - `GET /retell/phone`: the "restaurant phone" page, Frutiger Aero style matching the dashboard. It shows "No calls" or "📞 Incoming call — Tablemate is calling <restaurant> for <name>, party of N at <time>", a big green **Answer**, then a live transcript and **Hang up**.
     - It polls `GET /retell/phone/pending` every 1 s.
     - `?auto=1` auto-answers the first ringing call (for automated tests).
     - It uses the Retell web SDK from a CDN as an ES module (e.g. `import { RetellWebClient } from "https://esm.sh/retell-client-js-sdk"`; verify the package name and API in its README/npm). It calls `startCall({ accessToken })` and shows `update` transcript events.
     - It posts diagnostics (getUserMedia ok, call_started, errors) to `POST /retell/phone/diag`, which logs them.
   - `GET /retell/phone/pending`: the newest ringing web call.
   - `POST /retell/phone/answer {callId}`:
     - `POST https://api.retellai.com/v2/create-web-call` with `{ agent_id, metadata: {plan_id, attempt}, retell_llm_dynamic_variables }`;
     - store the `retell_call_id`, set status `answered`, emit `call` started;
     - return `{ accessToken }`.
   - `POST /retell/phone/decline {callId}` → the result handler gets `no_answer` (exactly once).
   - **Unanswered:** if a ringing web call isn't answered within `TM_RING_TIMEOUT_MS` (default 90 s), deliver `no_answer` once.
4. Webhooks and the `report_result` tool already work by `retell_call_id`. Make sure web calls (call_type `web_call`) map correctly and the exactly-once guarantee still holds.
5. **`scripts/make_restaurant_wav.sh`:** builds `data/restaurant_full_then_745.wav` with macOS `say` (a male voice, e.g. `-v Daniel` or any installed voice; list them with `say -v ?`). Use `[[slnc N]]` silences so the agent has time to talk:
   - (2 s silence) "Hi, thanks for calling Momo's Master, this is Jamie."
   - (9 s) "Ah, we're fully booked at seven thirty, but I could do seven forty-five."
   - (9 s) "Perfect. What name should I put it under?"
   - (7 s) "Great, you're all set, table at seven forty-five. See you tonight!"
   - (8 s)
   
   Convert with `afconvert -f WAVE -d LEI16@48000`. Also print the total duration (`afinfo`). It's used with Chrome's `--use-file-for-fake-audio-capture`.
6. **`src/cuisine.ts` emoji additions:** turkish/mediterranean/middle_eastern/greek/lebanese 🥙; nepalese/himalayan/tibetan/"momo" in the name 🥟; korean 🍲; vietnamese/pho 🍜; ice_cream 🍦; sandwich/deli 🥪; breakfast/brunch 🥞; chicken/wings 🍗; bbq 🍖. Match on `primaryType`, then on `cuisineLabel`, then on keywords in the name.
7. **`tests/calls.ts`:** extend it, still with no network and mocked fetch:
   - web mode `placeCall` → ringing, with no Retell request yet;
   - `answer` → exactly one create-web-call request with the metadata and all dynamic vars as strings;
   - `decline` → `no_answer` once;
   - ring timeout → `no_answer` once;
   - non-localhost requests to `/retell/phone*` → 403;
   - the 3-attempt cap still holds in web mode.

Run `node_modules/.bin/tsc -p tsconfig.json` (your files clean) and `~/.bun/bin/bun tests/calls.ts` until all PASS. Run `bash scripts/make_restaurant_wav.sh` if your allowed tools permit it; otherwise say so. Final answer: files changed, test counts, the SDK package/import you used, and the web-call token expiry from the docs.
