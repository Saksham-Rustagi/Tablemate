# Morning list: finish + polish, about 60 min total

*Written Sun Oct 11, ~2:40 AM. Overnight work and the hourly cron are stopped. Devpost is due 10:00 AM.*

**Retell credits:** $0.26 of the $10 free used so far (2 test calls of 44 s each, about $0.13 per call, roughly $0.17/min). This plan uses **one** more call, plus the demo call(s).

| # | Task | Who | Min |
|---|---|---|---|
| 1 | **Photon:** point Tablemate at **Kin's Photon project and line**, since a second project isn't possible. Both bots would read the same cloud stream, so **run one at a time** (stop Kin while demoing Tablemate, then restart it). The contact will read "Kin Helper" during the Tablemate demo. Delete the unpaid, unused "Tablemate" Photon project I created. | me | 5 |
| 2 | **Group chat** "HackNC dinner 🍜": your iPhone + Nicole's iPhone + the iPad. Seed real history: Nicole "I'm vegetarian btw", iPad "can't do anything after 8:30". I read the chat id into `TM_GROUP_CHAT_IDS`. | you + Nicole, then me | 10 |
| 3 | **One live run on the phones:** Nicole "dinner tonight? 🍜" → offer card → 👍 → plan cards on both iPhones → votes (the iPad types "2") → Nicole taps ✅ Book → the restaurant page on the Mac rings → **you answer with the Mac mic as the host**: "full at 7:30… 7:45 works" → every card flips ✅. If you've bought the Retell number by then, it rings your phone instead. | you + Nicole + me | 10 |
| 4 | **Tablemate visuals:** preview every card state at 280×300 (offer, vote, calling, ask-group, booked, handed-back) plus the dashboard. Fix overflow. | me | 10 |
| 5 | **Correctness fix:** right now "Take 9:15" marks the plan booked without the restaurant confirming. Change it to hand back honestly: "They offered 9:15. Tap to call them" (a tap-to-call link). | me | 5 |
| 6 | **Kin dashboard:** panels fill the screen height, and the memory-map labels stop overlapping (Raj/Anita). Recapture `devpost/gallery/dashboard.png` after a demo run. | me | 5 |
| 7 | **Docs truth pass:** Kin's README/Devpost mention the "I know Priya" button and the Today card. Write Tablemate's README + Devpost draft from the code: sponsors are Photon, Gemini, Retell (ElevenLabs voice) and Google Places. Include the honest limits: one shared Photon line, and the Mac restaurant page as the fallback. | me | 5 |
| 8 | **Decide** Kin only vs both, then record. Kin's script is `~/kin/devpost/DEMO_SCRIPT.md`. | you | 10 |

**Already done tonight** (all pushed):
- Tablemate `ac8d3b5`:
  - router, Gemini brain, plan state machine, synced cards, dashboard;
  - Places with live search;
  - Retell agent (gemini-3.5-flash-lite, 11labs-Cimo voice) with the web-call fallback;
  - webhook key + IP allowlist;
  - tests: replay 60/60 (both paths), calls 49/49, places 38/38.
- Kin `1eafa78`: card quote fix and the Devpost gallery (hero + 6 card states).

**Known gaps:**
- In the automated headless-Chrome test, the agent didn't hear the recorded "restaurant" audio. A real mic on the Mac (task 3) is the real test.
- Your own messages in the group aren't seen, because the Mac is your Apple ID. Tap your card instead of typing.
