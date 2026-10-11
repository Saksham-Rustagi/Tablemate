import { quoteIn, cleanQuote } from "./quote";
// Brain: ONE Gemini call per debounced group burst → intent + facts + text votes + RSVPs. Code verifies every item and
// decides every action. Regex fallback (spec §10) when Gemini is off or fails: no facts are extracted then.
import type { NewFact } from "./contracts";
import { config, memberByHandle, members } from "./config";
import { kvGet, kvSet, recentMessages, type MsgRow } from "./db";
import { decision, log } from "./events";
import { gen, geminiDisabled, groupTurnSchema, type GroupTurn } from "./ai/gemini";
import * as memory from "./memory";
import { activePlan, createOffer, editAll, optionsOf, recordRsvp, recordVote, todayNY } from "./plan";

const OFFER_GAP_MS = 6 * 3600_000;
/** An eating-together signal must be in the words themselves; "I'm hungry lol" is not one (rule 9). */
const MEAL_SIGNAL = /\b(dinner|lunch|breakfast|brunch|supper|drinks|eat|eating|food|grab|restaurant|reservation|table for)\b/i;
const FALLBACK_INTENT = /\b(dinner|lunch|eat|food)\b.*\?|let'?s (get|grab)/i;
const FALLBACK_VOTE = /^\s*([1-3])\s*$/;
const FALLBACK_IN = /\b(i'?m in|count me in|i'?m down)\b/i;

function nowNY(): string {
  return new Date().toLocaleString("en-US", { timeZone: config.tz, weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function planSummary(chatId: string): string {
  const p = activePlan(chatId);
  if (!p) return "No active plan.";
  const opts = optionsOf(p.id);
  return `Active plan: state ${p.state}, ${p.meal} on ${p.day}, organizer ${p.organizer}.` +
    (opts.length ? ` Options: ${opts.map((o, i) => `${i + 1}. ${o.name}`).join("; ")}.` : " No options yet.");
}

function prompt(chatId: string, burst: MsgRow[]): string {
  const hist = recentMessages(chatId, 20, burst.map((m) => m.id));
  return [
    `Now: ${nowNY()} (America/New_York). Today is ${todayNY()}.`,
    `Group members: ${members().map((m) => `${m.name} (${m.handle})`).join(", ")}.`,
    planSummary(chatId),
    "",
    "Earlier messages (context only, do not extract facts from these):",
    ...(hist.length ? hist.map((m) => `- ${m.name} (${m.handle}): ${m.text}`) : ["(none)"]),
    "",
    "NEW messages (msg_index: speaker: text):",
    ...burst.map((m, i) => `[${i}] ${m.name} (${m.handle}): ${m.text}`),
    "",
    "Extract:",
    "- intent: is someone proposing that the group eat/drink together (is_plan, confidence 0-1, meal, day YYYY-MM-DD, time_window HH:MM 24h, area_hint, organizer_handle = who proposed it). Just being hungry is NOT a plan.",
    "- facts: lasting food facts a member states about THEMSELVES in a NEW message (diet, allergy, dislike, like, budget, availability). quote = exact words copied from that message.",
    "- text_votes: a member picking an active plan option by number or name in a NEW message (option_number 1-3).",
    "- rsvps: a member saying they're in or out for the active plan, with a time preference if given.",
  ].join("\n");
}

function regexTurn(burst: MsgRow[]): GroupTurn {
  const hit = burst.filter((m) => FALLBACK_INTENT.test(m.text)).pop();
  const meal = hit ? ((hit.text.match(/\b(dinner|lunch|breakfast|drinks)\b/i)?.[1]?.toLowerCase() as GroupTurn["intent"]["meal"]) ?? "food") : null;
  return {
    intent: { is_plan: !!hit, confidence: hit ? 0.85 : 0, meal, day: null, time_window: null, area_hint: null, organizer_handle: hit?.handle ?? null },
    facts: [],
    text_votes: [],
    rsvps: burst.filter((m) => FALLBACK_IN.test(m.text)).map((m) => ({ handle: m.handle, status: "in" as const, time_pref: null })),
  };
}

export async function onGroupTurn(chatId: string, burst: MsgRow[]): Promise<void> {
  if (!burst.length) return;
  const t0 = Date.now();
  const preview = burst.map((m) => `${m.name}: ${m.text}`).join(" / ");
  let out: GroupTurn | null = null;
  let via = "gemini";
  if (!geminiDisabled()) out = await gen<GroupTurn>("groupTurn", prompt(chatId, burst), groupTurnSchema);
  if (!out) { out = regexTurn(burst); via = "regex"; }
  const rules: string[] = [via];
  const senders = new Set(burst.map((m) => m.handle));
  let changed = false;

  // ---- facts: member + quote must be a substring of THAT member's message in this burst (no invented facts) ----
  const facts = Array.isArray(out.facts) ? out.facts : [];
  const byHandle = new Map<string, NewFact[]>();
  for (const f of facts) {
    let m = burst[f.msg_index];
    // Tolerate an off-by-one index: fall back to this member's message in the burst that really contains the quote.
    if (!m || !quoteIn(f.quote ?? "", m.text, memberByHandle(m!.handle)?.name)) {
      const alt = burst.find((x) => x.handle === f.handle && quoteIn(f.quote ?? "", x.text, memberByHandle(x.handle)?.name));
      if (alt) m = alt;
    }
    const who = memberByHandle(f.handle);
    if (!m || !who || m.handle !== who.handle || !f.quote?.trim() || !quoteIn(f.quote, m.text, who.name)) {
      rules.push(`fact dropped (unverified quote)`);
      continue;
    }
    const nf: NewFact = { chatId, handle: who.handle, name: who.name, kind: f.kind, value: String(f.value ?? "").trim().toLowerCase(), quote: cleanQuote(f.quote, who.name), msgId: m.id, saidAt: m.at, source: "chat" };
    byHandle.set(who.handle, [...(byHandle.get(who.handle) ?? []), nf]);
  }
  for (const [h, fs] of byHandle) {
    const texts: Record<string, string> = {};
    for (const m of burst) if (m.handle === h) texts[m.id] = m.text;
    const saved = memory.saveFacts(chatId, fs, texts, members());
    for (const f of saved) rules.push(`fact: ${f.name} ${f.kind}=${f.value}`);
  }

  // ---- votes + RSVPs on the active plan ----
  const plan = activePlan(chatId);
  if (plan && plan.state === "voting") {
    const opts = optionsOf(plan.id);
    const votes = new Map<string, number>();
    for (const v of Array.isArray(out.text_votes) ? out.text_votes : []) {
      const who = memberByHandle(v.handle);
      const n = Number(v.option_number);
      if (!who || !senders.has(who.handle) || !Number.isInteger(n) || n < 1 || n > opts.length) { rules.push("vote dropped (unverified)"); continue; }
      // The member's own words must name the option (its number or its name).
      const said = burst.filter((m) => m.handle === who.handle).some((m) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(m.text) || m.text.toLowerCase().includes(opts[n - 1].name.toLowerCase().split(/\s+/)[0]));
      if (!said) { rules.push("vote dropped (not in their words)"); continue; }
      votes.set(who.handle, n - 1);
    }
    // A bare "2" is unambiguous: code counts it even if the model missed it.
    for (const m of burst) { const x = m.text.match(FALLBACK_VOTE); if (x && Number(x[1]) <= opts.length) votes.set(m.handle, Number(x[1]) - 1); }
    for (const [h, idx] of votes) if (recordVote(plan.id, h, idx, "text")) { rules.push(`text vote: ${memberByHandle(h)?.name} → ${idx + 1}`); changed = true; }
    for (const r of Array.isArray(out.rsvps) ? out.rsvps : []) {
      const who = memberByHandle(r.handle);
      if (!who || !senders.has(who.handle) || (r.status !== "in" && r.status !== "out")) continue;
      if (recordRsvp(plan.id, who.handle, r.status, r.time_pref ?? null, "text")) { rules.push(`rsvp: ${who.name} ${r.status}`); changed = true; }
    }
    if (changed) await editAll(plan.id);
  }

  // ---- intent → offer (rule 9) ----
  const it = out.intent;
  let action = changed ? "update" : "quiet";
  if (it?.is_plan) {
    const signal = burst.some((m) => MEAL_SIGNAL.test(m.text));
    const last = Number(kvGet(`offer_at:${chatId}`) || 0);
    const orgHandle = memberByHandle(it.organizer_handle)?.handle;
    const organizer = orgHandle && senders.has(orgHandle) ? orgHandle : [...burst].reverse().find((m) => MEAL_SIGNAL.test(m.text))?.handle ?? burst[burst.length - 1].handle;
    const org = memberByHandle(organizer);
    if ((it.confidence ?? 0) < 0.8) rules.push(`no offer: confidence ${it.confidence}`);
    else if (!signal || !it.meal) rules.push("no offer: no meal signal");
    else if (plan) rules.push("no offer: a plan is active");
    else if (Date.now() - last < OFFER_GAP_MS) rules.push("no offer: one per 6 h");
    else if (!org?.cardCapable) rules.push(`no offer: ${org?.name ?? "organizer"} can't receive cards`);
    else {
      kvSet(`offer_at:${chatId}`, String(Date.now()));
      const tw = it.time_window ?? { start: null, end: null };
      await createOffer(chatId, org.handle, { meal: it.meal, day: it.day, start: tw.start, end: tw.end, area: it.area_hint });
      rules.push(`offer → ${org.name} (${Math.round((it.confidence ?? 0) * 100)}%)`);
      action = "offer";
    }
  }
  decision({ from: burst.map((m) => m.name).filter((v, i, a) => a.indexOf(v) === i).join(", "), preview, rules, action, ms: Date.now() - t0 });
  if (via === "regex" && !process.env.GEMINI_OFF) log.info("group turn handled by the regex fallback");
}
