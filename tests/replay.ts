// Replay test: the whole group → offer → vote → book → call loop on the fake transport.
// Places and calls are faked through plan.setDeps (no network); Gemini is real unless GEMINI_OFF=1.
//   ~/.bun/bin/bun tests/replay.ts            (Gemini path)
//   GEMINI_OFF=1 ~/.bun/bin/bun tests/replay.ts (regex path; or pass --gemini-off)
import { rmSync } from "fs";

if (process.argv.includes("--gemini-off")) process.env.GEMINI_OFF = "1";
process.env.TM_DB = "data/replay.db";
process.env.TM_DEBOUNCE_MS = "0";
process.env.TM_GROUP_CHAT_IDS = "chat-replay";
process.env.TM_PEOPLE = "Saksham:+15550000001,Nicole:+15550000002,Maya:maya@example.com";
process.env.TM_LINE_HANDLES = "+15550009999";
process.env.PUBLIC_BASE_URL = "https://replay.example";
process.env.CARD_HMAC_SECRET = "replay-secret";
process.env.DEMO_FAST = "1";
process.env.TM_DEMO_SEED = "0";
for (const f of ["data/replay.db", "data/replay.db-wal", "data/replay.db-shm"]) rmSync(f, { force: true });

const { db } = await import("../src/db");
const memory = await import("../src/memory");
const calls = await import("../src/calls");
const { resetDemo } = await import("../src/seed");
const { createFakeTransport } = await import("../src/transport");
const { setCardTransport, planToken } = await import("../src/cards/service");
const plan = await import("../src/plan");
const { handle } = await import("../src/server");
const { route, fakeLocalMessage, drain } = await import("../src/router");
import type { CallRequest, PlaceOption, PlanQuery, SearchResult } from "../src/contracts";

const SAKSHAM = "+15550000001", NICOLE = "+15550000002", MAYA = "maya@example.com";
const CHAT = "chat-replay";
const PHONES = new Set([SAKSHAM, NICOLE]);
const mode = process.env.GEMINI_OFF === "1" ? "regex" : "gemini";

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = "") {
  if (ok) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------- fakes ----------
const opt = (i: number, name: string, primaryType: string, emoji: string): PlaceOption => ({
  placeId: `place_${i}`, name, address: `${100 + i} E Franklin St, Chapel Hill, NC`, phone: `+1919555010${i}`, mapsUri: `https://maps.example/${i}`,
  lat: 35.91, lng: -79.05, priceLevel: 2, rating: 4.5, ratingCount: 300, walkMin: 5 + i, primaryType, cuisineLabel: primaryType, emoji, photo: null, reservable: true,
  why: i === 0 ? "Veggie menu · Nicole's vegetarian" : "Takes reservations · 6 min walk",
});
const OPTIONS = [opt(0, "Sitar India Palace", "indian_restaurant", "🍛"), opt(1, "Mediterranean Deli", "mediterranean_restaurant", "🥙"), opt(2, "Lantern", "asian_restaurant", "🍜")];
const searches: PlanQuery[] = [];
const placed: CallRequest[] = [];
plan.setDeps({
  async searchPlaces(q): Promise<SearchResult> {
    searches.push(q);
    return { options: OPTIONS, skipped: { placeId: "place_x", name: "Sushi Nara", reason: "Nicole's vegetarian (today)", factId: 1 }, considered: 20, filteredOut: [{ name: "Sushi Nara", reason: "Nicole's vegetarian" }, { name: "Late Night Grill", reason: "closed at 7:30 PM" }] };
  },
  async placeCall(req) { placed.push(req); return { ok: true, callId: `call_${req.planId}_${req.attempt}`, dialed: "demo" }; },
});

// ---------- boot ----------
memory.initMemory();
calls.initCalls();
resetDemo();
const T = createFakeTransport();
setCardTransport(T);
plan.initPlans();

async function say(h: string, text: string, chatId = CHAT) {
  await route(...fakeLocalMessage(chatId, h, text));
  await drain();
}
async function tap(planId: string, h: string, action: string, extra: Record<string, unknown> = {}) {
  const res = await handle(new Request(`http://localhost:3001/plan/${planId}/act?t=${planToken(planId, h)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) }));
  return { status: res.status, body: (await res.json()) as any };
}
const cards = () => T.sent.filter((s) => s.kind === "card");
const sentTo = (h: string) => T.sent.filter((s) => s.to === h);

console.log(`replay (${mode})`);

// ---------- privacy filters ----------
await say(NICOLE, "dinner tonight? (in a different chat)", "chat-not-enrolled");
check("message from a non-enrolled chat is dropped before storage", !(db.query("SELECT COUNT(*) AS n FROM msg").get() as any).n && !cards().length);
await say("+15550009999", "echo from our own line");
check("echo from Tablemate's own line is dropped", !(db.query("SELECT COUNT(*) AS n FROM msg").get() as any).n);

// ---------- intent bar + facts ----------
await say(SAKSHAM, "I'm hungry lol");
check("\"I'm hungry lol\" → no offer", cards().length === 0 && !plan.latestPlan(CHAT));

await say(NICOLE, "I'm vegetarian btw");
const facts = memory.factsFor(CHAT);
if (mode === "gemini") {
  const veg = facts.find((f) => f.handle === NICOLE && f.kind === "diet" && f.value.includes("vegetarian"));
  check("\"I'm vegetarian btw\" → fact saved with the quote", !!veg && "I'm vegetarian btw".toLowerCase().includes(veg.quote.toLowerCase()) && veg.quote.length > 3, JSON.stringify(facts));
} else {
  check("regex path invents no facts", facts.length === 0, JSON.stringify(facts));
}
check("no offer after the vegetarian message", cards().length === 0);

await say(NICOLE, "dinner tonight?");
const p0 = plan.latestPlan(CHAT);
check("\"dinner tonight?\" → exactly one offer card", cards().length === 1, JSON.stringify(cards().map((c) => c.to)));
check("offer goes to Nicole only", cards()[0]?.to === NICOLE);
check("plan is offered with Nicole as organizer", p0?.state === "offered" && p0.organizer === NICOLE, JSON.stringify(p0));
const id = p0!.id;

await say(SAKSHAM, "dinner tonight? I'm starving");
check("no second offer while a plan is active", cards().length === 1);

// ---------- card page renders ----------
const page = await handle(new Request(`http://localhost:3001/plan/${id}?t=${planToken(id, NICOLE)}`));
const pageHtml = await page.text();
check("offer card page renders with 👍 Find spots", page.status === 200 && pageHtml.includes("Find spots"));
check("bad token → 403", (await handle(new Request(`http://localhost:3001/plan/${id}?t=nope`))).status === 403);

// ---------- offer_yes → plan cards ----------
const nonOrgYes = await tap(id, SAKSHAM, "offer_yes");
check("non-organizer can't accept the offer", nonOrgYes.status === 403);
const yes = await tap(id, NICOLE, "offer_yes");
check("offer_yes ok", yes.status === 200 && yes.body.ok, JSON.stringify(yes));
const planCards = cards().slice(1);
check("one plan card per phone member", planCards.length === 2 && new Set(planCards.map((c) => c.to)).size === 2 && planCards.every((c) => PHONES.has(c.to)), JSON.stringify(planCards.map((c) => c.to)));
check("the email member never gets a card", sentTo(MAYA).length === 0);
check("search ran with the default window", searches.length === 1 && /^\d\d:\d\d$/.test(searches[0].chosenTime));
check("plan is voting with 3 options", plan.getPlan(id)?.state === "voting" && plan.optionsOf(id).length === 3);
const vpage = await (await handle(new Request(`http://localhost:3001/plan/${id}?t=${planToken(id, SAKSHAM)}`))).text();
check("vote screen shows options + skipping line, no Book button for non-organizer", vpage.includes("Mediterranean Deli") && vpage.includes("Skipping Sushi Nara") && !vpage.includes("✅ Book"));

// ---------- votes + RSVPs ----------
check("Saksham votes 2 by tap", (await tap(id, SAKSHAM, "vote", { idx: 1 })).body.ok);
check("Nicole votes 1 by tap", (await tap(id, NICOLE, "vote", { idx: 0 })).body.ok);
check("Saksham taps I'm in", (await tap(id, SAKSHAM, "rsvp", { status: "in" })).body.ok);
await say(MAYA, "2");
const mayaVote = plan.votesOf(id).find((v) => v.handle === MAYA);
check("typed \"2\" from Maya counts as a text vote", mayaVote?.option_idx === 1 && mayaVote.via === "text", JSON.stringify(plan.votesOf(id)));
await say(MAYA, "count me in");
check("Maya's typed RSVP counts", plan.rsvpsOf(id).some((r) => r.handle === MAYA && r.status === "in"), JSON.stringify(plan.rsvpsOf(id)));
const chips = plan.chips(plan.getPlan(id)!);
if (chips.includes("19:30")) check("organizer picks the 7:30 chip", (await tap(id, NICOLE, "time", { time: "19:30" })).body.ok);
const chosen = plan.getPlan(id)!.chosen_time;
const within = chosen === "19:30" ? "19:45" : plan.fromMin(plan.toMin(chosen) + 15);
const outside = plan.fromMin(plan.toMin(chosen) + 105);
check("vote taps edit every member's card", T.sent.filter((s) => s.kind === "edit").length >= 2);

// ---------- book ----------
const nb = await tap(id, SAKSHAM, "book");
check("non-organizer book → 403", nb.status === 403);
check("…and places no call", placed.length === 0);
check("plan still voting after the rejected book", plan.getPlan(id)?.state === "voting");
const b = await tap(id, NICOLE, "book");
check("organizer book ok", b.status === 200 && b.body.ok, JSON.stringify(b));
check("attempt 1 → top-voted option (Mediterranean Deli)", placed.length === 1 && placed[0].attempt === 1 && placed[0].option.placeId === "place_1", JSON.stringify(placed.map((p) => p.option.name)));
check("party size = organizer + RSVPs in (3)", placed[0]?.partySize === 3, String(placed[0]?.partySize));
check("window is chosen ±30", placed[0]?.windowStart === plan.fromMin(plan.toMin(chosen) - 30) && placed[0]?.windowEnd === plan.fromMin(plan.toMin(chosen) + 30));
check("booking name is the organizer", placed[0]?.bookingName === "Nicole");
check("double book tap does nothing", (await tap(id, NICOLE, "book")).status === 409 && placed.length === 1);
check("plan is calling", plan.getPlan(id)?.state === "calling");

// ---------- call results ----------
const res = (attempt: number, status: any, time: string | null = null) => plan.onCallResult({ planId: id, attempt, status, time, partySize: null, name: null, note: null, retellCallId: `r${attempt}` });
await res(1, "full");
check("full → attempt 2 to the next option in vote order (Sitar)", placed.length === 2 && placed[1].attempt === 2 && placed[1].option.placeId === "place_0", JSON.stringify(placed.map((p) => p.option.name)));
await res(1, "booked", within);
check("stale result for attempt 1 is ignored", plan.getPlan(id)?.state === "calling" && plan.getPlan(id)?.attempt === 2);
await res(2, "offered_other_time", outside);
const pa = plan.getPlan(id)!;
check(`offered_other_time ${outside} (chosen ${chosen}) → asking_group`, pa.state === "asking_group" && pa.ask_time === outside, pa.state);
check("no auto-accept and no new call", placed.length === 2 && !pa.booked_time);
const askPage = await (await handle(new Request(`http://localhost:3001/plan/${id}?t=${planToken(id, NICOLE)}`))).text();
check("ask-group card shows Take / Try next", askPage.includes("Take ") && askPage.includes("Try next place"));
const sTry = await tap(id, SAKSHAM, "try_next");
check("non-organizer try_next only counts as a vote", sTry.body.ok && placed.length === 2 && plan.getPlan(id)?.state === "asking_group");
await tap(id, NICOLE, "try_next");
check("try_next → attempt 3 to the last option (Lantern)", placed.length === 3 && placed[2].attempt === 3 && placed[2].option.placeId === "place_2");
check("never the same place twice", new Set(placed.map((p) => p.option.placeId)).size === placed.length);
const editsBefore = T.sent.filter((s) => s.kind === "edit").length;
await res(3, "booked", within);
const pb = plan.getPlan(id)!;
check(`booked ${within} → state booked`, pb.state === "booked" && pb.booked_time === within && pb.booked_place_id === "place_2", JSON.stringify({ s: pb.state, t: pb.booked_time }));
const bookedEdits = T.sent.slice().filter((s) => s.kind === "edit");
const lastEditTo = (h: string) => bookedEdits.filter((s) => s.to === h && s.url?.includes(`t=${planToken(id, h)}`)).pop();
check("every card edited to booked", T.sent.filter((s) => s.kind === "edit").length >= editsBefore + 2 && [SAKSHAM, NICOLE].every((h) => lastEditTo(h)?.layout?.caption?.startsWith("✅")), JSON.stringify([SAKSHAM, NICOLE].map((h) => lastEditTo(h)?.layout)));
check("booked effect + .ics sent to phone members only", T.sent.filter((s) => s.kind === "effect").length === 2 && T.sent.filter((s) => s.kind === "attachment").every((s) => PHONES.has(s.to)));
const ics = await handle(new Request(`http://localhost:3001/plan/${id}/invite.ics?t=${planToken(id, SAKSHAM)}`));
check("invite.ics served", ics.status === 200 && (await ics.text()).includes("BEGIN:VEVENT"));
const bpage = await (await handle(new Request(`http://localhost:3001/plan/${id}?t=${planToken(id, SAKSHAM)}`))).text();
check("booked card has Maps + calendar + confetti", bpage.includes("Add to calendar") && bpage.includes("maps.example") && bpage.includes("confetti"));

// ---------- a 4th call is impossible ----------
await res(3, "full");
check("late result after booked is ignored", plan.getPlan(id)?.state === "booked" && placed.length === 3);
check("book after booked → rejected", (await tap(id, NICOLE, "book")).status === 409 && placed.length === 3);
check("try_next after booked → rejected", (await tap(id, NICOLE, "try_next")).status === 409 && placed.length === 3);

// second plan: three failures → handed back, never a 4th call
db.exec("DELETE FROM kv WHERE key LIKE 'offer_at:%'");
const p2 = (await plan.createOffer(CHAT, NICOLE, { meal: "dinner", day: null, start: null, end: null, area: null }))!;
await tap(p2.id, NICOLE, "offer_yes");
await tap(p2.id, SAKSHAM, "vote", { idx: 2 });
await tap(p2.id, NICOLE, "book");
const res2 = (attempt: number, status: any) => plan.onCallResult({ planId: p2.id, attempt, status, time: null, partySize: null, name: null, note: null, retellCallId: `q${attempt}` });
await res2(1, "full"); await res2(2, "no_answer"); await res2(3, "voicemail");
const p2calls = placed.filter((r) => r.planId === p2.id);
check("3 failures → handed_back with exactly 3 calls", plan.getPlan(p2.id)?.state === "handed_back" && p2calls.length === 3, `${plan.getPlan(p2.id)?.state} ${p2calls.length}`);
check("handed-back card lists tap-to-call numbers", (await (await handle(new Request(`http://localhost:3001/plan/${p2.id}?t=${planToken(p2.id, NICOLE)}`))).text()).includes("tel:+1919555010"));
check("every transition is a plan_event row", plan.planEvents(id).length >= 8 && plan.planEvents(id).some((e) => e.to_state === "asking_group"));

// ---------- transport safety ----------
check("nothing is ever sent via the local provider", T.sent.every((s) => s.provider === "cloud") && !("sendAsAsha" in T) && !Object.keys(T).some((k) => /local/i.test(k)));
check("every send goes to a phone member", T.sent.every((s) => PHONES.has(s.to)), JSON.stringify(T.sent.filter((s) => !PHONES.has(s.to))));
check("the email member never gets anything", sentTo(MAYA).length === 0);

// ---------- dashboard ----------
const ds = await handle(new Request("http://localhost:3001/dash/state"));
const dj: any = await ds.json();
check("/dash/state works", ds.status === 200 && dj.plan && Array.isArray(dj.states));
check("/dash from the tunnel → 404", (await handle(new Request("http://localhost:3001/dash", { headers: { "cf-connecting-ip": "1.2.3.4" } }))).status === 404);
const sim = await handle(new Request("http://localhost:3001/dash/simulate", { method: "POST", body: JSON.stringify({ handle: SAKSHAM, text: "simulated hello", wait: true }) }));
check("/dash/simulate routes a message", sim.status === 200 && !!db.query("SELECT 1 FROM msg WHERE text = 'simulated hello'").get());

console.log(`\n${fail ? "FAIL" : "PASS"} replay (${mode}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
