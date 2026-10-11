// Session B tests: places filters/scoring + memory verification. No network (fake fetch), own DB.
//   ~/.bun/bin/bun tests/places_memory.ts          (LIVE=1 adds one real Places search)
import { rmSync } from "fs";

const DB = "data/pm_test.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.TM_DB = DB;
process.env.KIN_DB = DB; // until db.ts switches to TM_DB

const { db } = await import("../src/db");
const mem = await import("../src/memory");
const places = await import("../src/places");
import type { Fact, NewFact, Person, PlanQuery } from "../src/contracts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const fixtureText = await Bun.file("tests/fixtures/places_franklin.json").text();
const fixture = () => JSON.parse(fixtureText) as { places: places.RawPlace[] };
let calls = 0;
function serve(data: { places: places.RawPlace[] } | "error") {
  db.exec("DELETE FROM places_cache");
  places.setPlacesFetch(async () => {
    calls++;
    if (data === "error") throw new Error("timeout");
    return new Response(JSON.stringify(data), { status: 200 });
  });
}
const byName = (d: { places: places.RawPlace[] }, n: string) => d.places.find((p) => p.displayName?.text === n)!;

// ---------- memory ----------
mem.initMemory();
places.initPlaces();
const CHAT = "chat-test";
const members: Person[] = [
  { handle: "+19195550101", name: "Nicole", cardCapable: true },
  { handle: "+19195550102", name: "Raj", cardCapable: true },
  { handle: "+19195550103", name: "Saksham", cardCapable: true },
];
const [nicole, raj, saksham] = members;
const nf = (p: Partial<NewFact> & Pick<NewFact, "handle" | "kind" | "value" | "quote" | "msgId">): NewFact =>
  ({ chatId: CHAT, name: "", saidAt: "2026-10-08T18:00:00Z", source: "chat", ...p });

const nicoleMsgs = { m1: "I'm veggie btw, and honestly I hate sushi" };
let saved = mem.saveFacts(CHAT, [
  nf({ handle: nicole.handle, kind: "diet", value: "Veggie", quote: "i'm VEGGIE", msgId: "m1" }),
  nf({ handle: nicole.handle, kind: "dislike", value: "sushi", quote: "I hate sushi", msgId: "m1" }),
], nicoleMsgs, members);
check("memory: real quotes saved", saved.length === 2, JSON.stringify(saved));
check("memory: synonym veggie → vegetarian", saved[0]?.value === "vegetarian" && saved[0]?.name === "Nicole");

saved = mem.saveFacts(CHAT, [nf({ handle: nicole.handle, kind: "diet", value: "vegan", quote: "I'm vegan", msgId: "m1" })], nicoleMsgs, members);
check("memory: fake quote rejected", saved.length === 0);
saved = mem.saveFacts(CHAT, [nf({ handle: "+19195559999", kind: "diet", value: "vegan", quote: "veggie", msgId: "m1" })], nicoleMsgs, members);
check("memory: non-member rejected", saved.length === 0);
saved = mem.saveFacts(CHAT, [nf({ handle: nicole.handle, kind: "diet", value: "vegan", quote: "veggie", msgId: "m9" })], nicoleMsgs, members);
check("memory: msgId not in that member's messages rejected", saved.length === 0);
saved = mem.saveFacts(CHAT, [nf({ handle: nicole.handle, kind: "diet", value: "vegetarian", quote: "veggie", msgId: "m1" })], nicoleMsgs, members);
check("memory: dedupe", saved.length === 0 && mem.factsFor(CHAT).filter((f) => f.kind === "diet").length === 1);

const sakMsgs = { s1: "I'm kinda broke this week, cheap please", s2: "ok I got paid, anything works" };
mem.saveFacts(CHAT, [nf({ handle: saksham.handle, kind: "budget", value: "cheap", quote: "cheap please", msgId: "s1", saidAt: "2026-10-09T15:00:00Z" })], sakMsgs, members);
mem.saveFacts(CHAT, [nf({ handle: saksham.handle, kind: "budget", value: "any", quote: "anything works", msgId: "s2", saidAt: "2026-10-10T15:00:00Z" })], sakMsgs, members);
const budgets = mem.factsFor(CHAT).filter((f) => f.kind === "budget");
check("memory: budget replaced by newer", budgets.length === 1 && budgets[0].value === "any", JSON.stringify(budgets));
mem.saveFacts(CHAT, [nf({ handle: saksham.handle, kind: "budget", value: "cheap", quote: "cheap please", msgId: "s1", saidAt: "2026-10-09T15:00:00Z" })], sakMsgs, members);
check("memory: older budget doesn't replace newer", mem.factsFor(CHAT).filter((f) => f.kind === "budget")[0]?.value === "any");

mem.saveFacts(CHAT, [nf({ handle: raj.handle, kind: "allergy", value: "Peanuts", quote: "allergic to peanuts", msgId: "r1" })], { r1: "I'm allergic to peanuts!" }, members);
check("memory: allergiesFor", JSON.stringify(mem.allergiesFor(CHAT, [raj.handle, nicole.handle])) === '["peanuts (Raj)"]');
check("memory: facts don't cross groups", mem.factsFor("other-chat").length === 0);

const veg = mem.factsFor(CHAT).find((f) => f.kind === "diet")!; // said Thu Oct 8
const sushi = mem.factsFor(CHAT).find((f) => f.kind === "dislike")!;
check("factLabel weekday", mem.factLabel(veg) === "Nicole's vegetarian (Thu)", mem.factLabel(veg));
check("factLabel today", mem.factLabel({ ...veg, saidAt: new Date().toISOString() }) === "Nicole's vegetarian (today)");
const tmp = mem.saveFacts(CHAT, [nf({ handle: raj.handle, kind: "like", value: "thai", quote: "thai", msgId: "r2" })], { r2: "thai again?" }, members)[0];
mem.forgetFact(tmp.id);
check("memory: forgetFact", !mem.factsFor(CHAT).some((f) => f.id === tmp.id));

// ---------- places ----------
const q: PlanQuery = { chatId: CHAT, meal: "dinner", day: "2026-10-11", chosenTime: "19:30", windowStart: "19:00", windowEnd: "20:00", partySize: 4 };
const cheap: Fact = { ...veg, id: 9001, handle: saksham.handle, name: "Saksham", kind: "budget", value: "cheap", quote: "cheap please" }; // stand-in row id

serve(fixture());
let r = await places.searchPlaces(q, []);
check("fixture loads", r.considered === 20, `considered=${r.considered}`);
check("≤ 3 options", r.options.length > 0 && r.options.length <= 3, `${r.options.length}`);
check("distinct types", new Set(r.options.map((o) => o.primaryType)).size === r.options.length, r.options.map((o) => o.primaryType).join(","));
check("no fact → no skipped", r.skipped === null);
check("reservable=false dropped", !r.options.some((o) => o.reservable === false) && r.filteredOut.some((f) => f.reason === "doesn't take reservations"));
check("Lantern (closed Sundays) removed", r.filteredOut.some((f) => f.name === "Lantern" && f.reason === "closed at 19:30"));
check("phone E.164", r.options.every((o) => /^\+1\d{10}$/.test(o.phone)), r.options.map((o) => o.phone).join(","));
check("photo null + emoji", r.options.every((o) => o.photo === null && o.emoji.length > 0));

// crafted: a place closing at 19:00 every day
const d1 = fixture();
byName(d1, "411 West Italian Cafe").regularOpeningHours = { periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 11, minute: 0 }, close: { day, hour: 19, minute: 0 } })) };
serve(d1);
r = await places.searchPlaces(q, []);
check("closed at 19:30 removed", r.filteredOut.some((f) => f.name === "411 West Italian Cafe" && f.reason === "closed at 19:30") && !r.options.some((o) => o.name === "411 West Italian Cafe"));
check("open-hours: overnight period", places.isOpenAt({ periods: [{ open: { day: 6, hour: 18, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } }] }, "2026-10-11", "01:00"));
check("open-hours: 24h", places.isOpenAt({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }, "2026-10-14", "03:00"));

serve(fixture());
r = await places.searchPlaces(q, [veg]);
const vegIds = new Set(fixture().places.filter((p) => p.servesVegetarianFood === true).map((p) => p.id));
check("vegetarian: only servesVegetarianFood places", r.options.every((o) => vegIds.has(o.placeId)));
check("vegetarian: skipped cites fact", r.skipped?.factId === veg.id && r.skipped?.reason === "Nicole's vegetarian (Thu)", JSON.stringify(r.skipped));
check("vegetarian: skipped place really lacks veg", !!r.skipped && !vegIds.has(r.skipped.placeId));
check("vegetarian: why cites Nicole", r.options.every((o) => o.why.startsWith("Veggie menu · Nicole's vegetarian")), r.options.map((o) => o.why).join(" | "));
r = await places.searchPlaces(q, [{ ...veg, value: "vegan" }]);
check("vegan: not confirmed wording", r.options.every((o) => o.why.includes("vegan not confirmed")));

r = await places.searchPlaces(q, [sushi]);
check("hates sushi: Japanese/sushi removed", !r.options.some((o) => /japanese|sushi/.test(o.primaryType)) &&
  r.filteredOut.some((f) => f.name === "Hibachi & Company" && f.reason === "Nicole dislikes sushi (Thu)"));

const d2 = fixture();
byName(d2, "Talullas").priceLevel = "PRICE_LEVEL_EXPENSIVE";
serve(d2);
let sentBody: any = null;
places.setPlacesFetch(async (_u, init) => { sentBody = JSON.parse(String(init?.body)); return new Response(JSON.stringify(d2)); });
r = await places.searchPlaces(q, [cheap]);
check("budget: request has priceLevels", JSON.stringify(sentBody?.priceLevels) === '["PRICE_LEVEL_INEXPENSIVE","PRICE_LEVEL_MODERATE"]');
check("budget: priceLevel > MODERATE removed", r.options.every((o) => o.priceLevel == null || o.priceLevel <= 2) &&
  r.filteredOut.some((f) => f.name === "Talullas" && f.reason.startsWith("Saksham's budget")));
check("budget: why cites budget", r.options.some((o) => o.why.includes("fits Saksham's budget")), r.options.map((o) => o.why).join(" | "));

const allergy = mem.factsFor(CHAT).find((f) => f.kind === "allergy")!;
serve(fixture());
const rNo = await places.searchPlaces(q, []);
const rAl = await places.searchPlaces(q, [allergy]);
check("allergy never filters", JSON.stringify(rNo.options.map((o) => o.placeId)) === JSON.stringify(rAl.options.map((o) => o.placeId)));

const allWhys: string[] = [];
for (const fs of [[], [veg], [veg, sushi, cheap], [{ ...veg, value: "vegan" }, allergy, cheap]]) {
  allWhys.push(...(await places.searchPlaces(q, fs)).options.map((o) => o.why));
}
check("every why ≤ 48 chars, no 'safe'", allWhys.every((w) => w.length <= 48 && !/safe/i.test(w)), allWhys.filter((w) => w.length > 48 || /safe/i.test(w)).join(" | "));

// cache + errors
serve(fixture());
calls = 0;
await places.searchPlaces(q, []);
await places.searchPlaces(q, []);
check("cache: second search served from cache", calls === 1, `calls=${calls}`);
db.exec("UPDATE places_cache SET at = '2026-01-01T00:00:00Z'");
places.setPlacesFetch(async () => new Response("nope", { status: 500 }));
r = await places.searchPlaces(q, []);
check("HTTP error → stale cache used", r.considered === 20);
serve("error");
let threw = "";
try { await places.searchPlaces(q, []); } catch (e: any) { threw = e.message; }
check("no cache + error → clear throw", /Places search failed/.test(threw), threw);

console.log("sample options:", (await (serve(fixture()), places.searchPlaces(q, [veg, cheap]))).options.map((o) => `${o.emoji} ${o.name} — ${o.why}`));

// ---------- live smoke (one real search) ----------
if (process.env.LIVE === "1") {
  places.setPlacesFetch(null);
  db.exec("DELETE FROM places_cache");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const lr = await places.searchPlaces({ ...q, day: today }, [veg]);
  console.log(`LIVE ${today} 19:30 dinner, fact=${mem.factLabel(veg)}: considered ${lr.considered}, removed ${lr.filteredOut.length}`);
  for (const o of lr.options) console.log(`  ${o.emoji} ${o.name} (${o.cuisineLabel}, ${o.walkMin} min, ${o.phone}) — ${o.why}`);
  console.log(`  skipped: ${lr.skipped ? `${lr.skipped.name}: ${lr.skipped.reason}` : "none"}`);
  check("LIVE: got options", lr.options.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
