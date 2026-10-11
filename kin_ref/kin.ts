// Kin's brain: what happens for each kind of inbound message, and for each card tap.
import { config, fmtTime, isAsha, mask, normalizeHandle } from "./config";
import { db, caregiver, handlesOf, people, personByHandle, personById, personByName, saveMessage, touchContact, newId, nowIso, type Person } from "./db";
import { decision, emit, log, type GraphNode } from "./events";
import { gen, assessSchema, familySchema, threadSchema, type AssessCompose, type FamilyUnderstanding, type ThreadFacts } from "./ai/gemini";
import { decideFamily, decideUnknown, defang, looksTrivial } from "./decide";
import { candidatesFor, explainEntity, unplacedMentions, regexMentions, verifyMemoryLine, knownNamesForPrompt, saveMemory, addEdge, memoriesBy, forgetLast, photoFor, resolveNode } from "./memory";
import { isImage, saveImage, toWav, understandPhoto, understandVoice, inlineImage, type InPhoto } from "./photos";
import { createCard, updateCard, getCard, btn, latestCard, cardBySpectrumId, type CardData } from "./cards/service";
import type { Transport } from "./transport";
import { createReminder, markReminderDone, snoozeReminder, reminderByCard } from "./reminders";
import { readAloud, prefetchAudio } from "./voice";

let T: Transport;
export function setTransport(t: Transport) { T = t; }

export type Turn = { from: string; chatId: string | null; isGroup: boolean; texts: string[]; ids: string[]; at: Date; attachments: { name: string; mimeType: string; read?: () => Promise<Buffer> }[] };

const call = () => config.ashaCalledBy; // "Nani"
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
const CANNED = ["❤️ Thank you!", "Sounds good", "Call me soon"];
/** Never send money, codes or personal info as her (hard rule 3), whatever the tap payload says. */
const SENSITIVE = /\$|money|gift ?card|password|\bcode\b|bank|social security|card number|\d{4,}/i;

// =====================================================================================
// Family → Asha (local, her real thread): RECOGNIZE
// =====================================================================================
export async function onFamilyToAsha(person: Person, turn: Turn) {
  const t0 = Date.now();
  const text = turn.texts.join("\n").trim() || (turn.attachments.length ? `[sent ${turn.attachments.length} photo(s)]` : "");
  const preview = text.slice(0, 120);
  const regexNames = regexMentions(text);
  const cands0 = candidatesFor(person, regexNames);

  // A photo in her thread: convert it and let the same Gemini call caption it (still one call). Skip if not downloaded.
  let photo: { file: string; jpeg: Buffer } | null = null;
  const img = turn.attachments.find((a) => a.read && isImage(a.mimeType, a.name));
  if (img) {
    try { photo = await saveImage({ bytes: await img.read!(), mimeType: img.mimeType, name: img.name }); }
    catch (e) { log.warn(`photo from ${person.name} not readable yet (${(e as any)?.message ?? e})`); }
  }

  const prompt = `Today is ${today()}.
Sender: ${person.name}, ${config.ashaName}'s ${person.relation} (pronoun: ${person.pronoun}).
Message to ${config.ashaName} (from their own 1:1 thread):
"""${text}"""
Known people and things in the family memory: ${knownNamesForPrompt()}.
Candidate memories (choose at most ONE that relates to THIS message or this sender; id: text [date]):
${cands0.map((m) => `- ${m.id}: ${m.text}${m.happened_on ? ` [${m.happened_on}]` : ""}`).join("\n") || "- (none)"}
Fill the schema:
- memory_id/memory_line: ONE short statement (max 12 words) about ${person.name} built ONLY from the chosen memory, e.g. "${person.pronoun === "he" ? "He" : "She"} visited two weeks ago with mangoes". If the memory has a date, say when relative to today ("two weeks ago", "last October"), never just a weekday. null if nothing fits.
- replies: up to 3 replies ${config.ashaName} could send back, first person, max 5 words each, warm and adult (an emoji is fine). No money, no promises of dates/times. Empty array if nothing to reply to.
- summary: max 18 words, only if the message is long or confusing; else null.
- calm_note: only if the tone is stressful: restate calmly with the facts unchanged; else null.
- mentions: names of people, pets, places or events that appear in the message (exact words).
- isTrivial: true only for "ok", "thanks", emoji-only and similar.
- questionForAsha: true if it asks ${config.ashaName} something.
- scam.score: 0-100 risk that this is a scam.${photo ? `
- photo_caption: the attached photo was sent with this message. Max 12 words, plain, what is visible. Never identify people from faces; only use names written in the message.` : ""}`;
  const assess = await gen<AssessCompose>("assess_compose", photo ? [{ text: prompt }, inlineImage(photo.jpeg)] : prompt, assessSchema, photo ? { timeoutMs: 15_000 } : {});
  const photoLine = photo ? `${person.name} sent a photo${assess?.photo_caption ? `: ${assess.photo_caption.split(/\s+/).slice(0, 12).join(" ")}` : ""}` : null;
  // Only names that literally appear in the message as whole words (Gemini sometimes echoes known names from the prompt).
  const word = (n: string) => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu").test(text);
  const mentionNames = [...new Set([...(assess?.mentions.map((m) => m.name) ?? []).filter((n) => n && word(n)), ...regexNames])];
  const unplaced = unplacedMentions(mentionNames, person);
  const words = text.split(/\s+/).filter(Boolean).length;
  const d = decideFamily({ person, text, assess, unplaced: unplaced.map((u) => u.name), wordCount: words });
  if (photo && d.action === "quiet") { d.action = "card"; d.rules.push("R8 photo"); }

  // Memory line: verify Gemini's pick in code; never invent.
  const cands = candidatesFor(person, mentionNames);
  const verified = assess ? verifyMemoryLine(assess.memory_id, assess.memory_line, cands, person) : null;
  const explains = unplaced.map((u) => explainEntity(u.name)).filter(Boolean) as { id: string; text: string; ids: string[] }[];
  const highlight = [person.id, ...explains.flatMap((e) => e.ids), ...(verified ? [] : [])];

  for (const id of turn.ids) saveMessage({ id, via: "local", direction: "in", chat: turn.chatId ?? undefined, from: turn.from, text, decision: d });
  touchContact(person.id);

  if (d.action !== "card") {
    decision({ from: person.name, preview, rules: d.rules, action: d.action, ms: Date.now() - t0, highlight });
    void learnFromThread(person, text, turn.ids[0]);
    return;
  }

  let replies = (assess?.replies ?? []).map((r) => r.trim()).filter((r) => r && r.length <= 32 && !/\$|money|gift|code|password/i.test(r)).slice(0, 3);
  if (!assess) replies = CANNED;
  const summary = photoLine || assess?.calm_note || (explains.length ? explains[0].text : null) || (assess?.needsSummary || words > 40 ? assess?.summary ?? null : null);
  const line = verified?.line ?? null;
  const handle = normalizeHandle(turn.from);
  const data: CardData = {
    title: person.name,
    subtitle: `your ${person.relation}`,
    photoUrl: photo ? `/media/${photo.file}` : photoFor(person),
    emoji: person.emoji,
    line,
    quoteFrom: `${person.name} wrote:`,
    quote: turn.texts.join("\n").trim() || (photo ? null : text),
    summary,
    status: null,
    buttons: [...replies.map((r) => btn(r, "reply", { text: r }, "green")), ...(person.known_by_asha ? [] : [btn(`👍 I know ${person.name.split(" ")[0]}`, "know", { personId: person.id }, "plain")])],
    readAloud: true,
    talk: true,
    to: config.ashaHandle,
    layout: { caption: `${person.name} · your ${person.relation}`, subcaption: line ?? summary ?? `${person.name} wrote to you`, summary: `Kin: ${person.name} wrote to you` },
    meta: { personId: person.id, replyTo: handle, chatId: turn.chatId, memoryId: verified?.id ?? null, rules: d.rules },
  };
  const card = await createCard("context", "sent", data);
  prefetchAudio(card.id); // pre-make the Listen audio so it plays instantly
  decision({ from: person.name, preview, rules: [...d.rules, ...(verified ? [`M ${verified.id}`] : [])], action: "card", memoryId: verified?.id ?? null, cardId: card.id, ms: Date.now() - t0, highlight });
  void learnFromThread(person, text, turn.ids[0]);
}

/** Durable facts about the sender from Asha's thread with ENROLLED family only (never anyone else's thread). */
async function learnFromThread(person: Person, text: string, msgId?: string) {
  if (!person.enrolled || looksTrivial(text) || text.split(/\s+/).length < 5) return;
  const r = await gen<ThreadFacts>("thread_facts", `Today is ${today()}. ${person.name} (${config.ashaName}'s ${person.relation}) wrote to ${config.ashaName}:
"""${text}"""
Extract ONLY durable, new facts about ${person.name} worth remembering for months (a new job, a move, a new pet, a trip, a baby, a graduation). Not plans for this week, not feelings, not greetings. Each memory: one short sentence in third person starting with "${person.name}". happened_on as YYYY-MM-DD if a date is clear, else null. Return empty arrays if none.`, threadSchema);
  if (!r?.memories?.length) return;
  for (const m of r.memories.slice(0, 2)) {
    const mem = saveMemory(person.name, m.text, m.happened_on, person.id, "family_thread", msgId ?? null);
    for (const e of r.entities.slice(0, 3)) if (m.text.toLowerCase().includes(e.name.toLowerCase())) addEdge(person.name, "related_to", e.name, "", person.id, "person", e.kind);
    decision({ from: person.name, preview: m.text, rules: ["M learned from her thread with enrolled family"], action: "memory", memoryId: mem.id, highlight: [person.id] });
  }
}

// =====================================================================================
// Unknown → Asha (local): PROTECT
// =====================================================================================
export async function onUnknownToAsha(turn: Turn) {
  const t0 = Date.now();
  const text = turn.texts.join("\n").trim();
  const from = normalizeHandle(turn.from);
  for (const id of turn.ids) saveMessage({ id, via: "local", direction: "in", chat: turn.chatId ?? undefined, from, text });
  const blocked = db.query("SELECT 1 FROM blocked WHERE address = ?").get(from);
  const famNames = people().map((p) => p.name);
  const assess = await gen<AssessCompose>("assess_unknown", `An UNKNOWN sender (not in the family memory) texted ${config.ashaName}, 78, living with memory loss:
"""${text}"""
Family names: ${famNames.join(", ")}. Score scam risk 0-100 for an older person; list signals; claimsToBe = the family name or role they claim to be (e.g. "Priya", "grandson"), else null. Leave replies empty and memory fields null.`, assessSchema);
  const isShortCode = /^\+?\d{3,6}$/.test(from);
  const d = decideUnknown({ text, assess, familyNames: famNames, isShortCode });
  if (blocked) d.rules.unshift("blocked by Priya");

  if (d.action === "quiet") { decision({ from: mask(from), preview: text, rules: d.rules, action: "quiet", ms: Date.now() - t0 }); return; }
  const cg = caregiver();
  const cgName = cg?.name ?? "your family";
  const claimedPerson = d.claimed ? personByName(d.claimed) : null;

  if (d.action === "protect") {
    const line = blocked ? `${cgName} said this number is a scam. You don't need to reply.`
      : claimedPerson ? `This says it's ${claimedPerson.name}, but it's not ${claimedPerson.name}'s number. I'm checking with ${cgName}.`
      : `Please don't send money or codes. I've let ${cgName} know.`;
    const data: CardData = {
      title: "Someone I don't know", subtitle: claimedPerson ? `says it's ${claimedPerson.name}` : "a new number", photoUrl: null, emoji: "🛡️",
      line, quoteFrom: "They wrote:", quote: defang(text), summary: null, status: null,
      buttons: cg ? [btn(`📞 Ask ${cg.name} to call me`, "callme", { personId: cg.id }, "blue")] : [], readAloud: true, talk: false,
      to: config.ashaHandle,
      layout: { caption: "🛡️ Someone I don't know", subcaption: "Please don't send money or codes", summary: "Kin: a message to be careful with" },
      meta: { sender: from, claimed: claimedPerson?.id ?? null },
    };
    const card = await createCard("protect", "blocked", data);
    prefetchAudio(card.id);
    if (!blocked && cg) {
      const alertId = newId("a");
      const who = claimedPerson && claimedPerson.id === cg.id ? "Someone claiming to be YOU" : claimedPerson ? `Someone claiming to be ${claimedPerson.name}` : "Someone I don't know";
      const msg = `🛡️ ${who} texted ${call()} from ${mask(from)}:\n“${defang(text).slice(0, 220)}”\n\nI showed her a calm warning and told her not to reply or send anything. I never reply to them.\nReply SAFE if you know them, or SCAM to block them.`;
      db.query("INSERT INTO alert (id, kind, sender, card_id, message, status, created_at) VALUES (?,?,?,?,?,?,?)").run(alertId, "protect", from, card.id, text, "open", nowIso());
      for (const h of handlesOf(cg.id)) await T.sendText(h, msg);
      if (claimedPerson && claimedPerson.id !== cg.id) for (const h of handlesOf(claimedPerson.id)) await T.sendText(h, `🛡️ Someone claiming to be you texted ${call()} from ${mask(from)}. Was it you? Reply SAFE if it was, SCAM if not.`);
      await updateCard(card.id, "family_notified", { status: { text: `${cgName} knows ✓`, tone: "info" } });
    }
    decision({ from: mask(from), preview: text, rules: d.rules, action: "protect", cardId: card.id, ms: Date.now() - t0 });
    return;
  }

  // P2: unknown, no risk signals — gentle card, ask the caregiver; never reply to the sender.
  const data: CardData = {
    title: "Someone new", subtitle: "a number I don't know yet", photoUrl: null, emoji: "👋",
    line: `I don't know this number yet. I can ask ${cgName}.`, quoteFrom: "They wrote:", quote: defang(text), summary: null, status: null,
    buttons: cg ? [btn(`Ask ${cg.name}`, "ask_caregiver", { sender: from }, "blue")] : [], readAloud: true, talk: false,
    to: config.ashaHandle, layout: { caption: "👋 Someone new", subcaption: "A number I don't know yet" }, meta: { sender: from },
  };
  const card = await createCard("info", "sent", data);
  decision({ from: mask(from), preview: text, rules: d.rules, action: "card", cardId: card.id, ms: Date.now() - t0 });
}

// =====================================================================================
// Card taps (HTTP POST from the card page)
// =====================================================================================
export async function onCardAction(cardId: string, action: string, payload: any): Promise<{ ok: boolean; toast?: string }> {
  const c = getCard(cardId);
  if (!c) return { ok: false };
  const { row, data } = c;
  log.info(`tap: card ${cardId} (${row.type}/${row.state}) action=${action}`);

  if (action === "reply" && row.type === "context") {
    if (row.state === "replied") return { ok: true, toast: "Already sent ✓" }; // idempotent
    const textOut = String(payload?.text ?? "").slice(0, 120);
    const person = personById(data.meta.personId);
    if (!textOut || !person) return { ok: false };
    if (SENSITIVE.test(textOut)) { log.warn(`tap: blocked a reply with money/code words on card ${cardId}`); return { ok: false }; }
    const ok = await T.sendAsAsha(data.meta.replyTo, data.meta.chatId ?? null, textOut);
    if (!ok) return { ok: false };
    saveMessage({ id: newId("out"), via: "local", direction: "out_as_asha", to: data.meta.replyTo, text: textOut, card_id: cardId });
    await updateCard(cardId, "replied", {
      status: { text: `Sent to ${person.name} ✓ “${textOut}”`, tone: "ok" }, buttons: [],
      layout: { ...data.layout, subcaption: `You replied ✓ “${textOut}”` },
    });
    decision({ from: config.ashaName, preview: `→ ${person.name}: ${textOut}`, rules: ["her tap"], action: "reply", cardId, highlight: [person.id] });
    return { ok: true, toast: `Sent to ${person.name} ✓` };
  }

  // Q1: "I know Priya" — only suppresses R1 (long gap); mentions, long messages, questions and stress still make cards.
  if (action === "know" && row.type === "context") {
    const person = personById(data.meta.personId);
    if (!person) return { ok: false };
    const toast = `Okay. I'll only step in for ${person.name} when it helps.`;
    if (person.known_by_asha) return { ok: true, toast }; // idempotent
    db.query("UPDATE person SET known_by_asha = 1 WHERE id = ?").run(person.id);
    await updateCard(cardId, row.state, { buttons: data.buttons.filter((b) => b.action !== "know") });
    decision({ from: config.ashaName, preview: `I know ${person.name}`, rules: ["Q1 she knows them", "her tap"], action: "quiet", cardId, highlight: [person.id] });
    return { ok: true, toast };
  }

  if (action === "readaloud") {
    void readAloud(cardId);
    return { ok: true, toast: "I'm sending you a voice message 🔊" };
  }

  if (action === "callme") {
    const p = personById(payload?.personId) ?? caregiver();
    if (!p) return { ok: false };
    if (data.meta.calledAt) return { ok: true, toast: `I asked ${p.name} to call you ✓` };
    for (const h of handlesOf(p.id)) await T.sendText(h, `${call()} would like you to call her 💛`);
    await updateCard(cardId, row.state, { status: { text: `I asked ${p.name} to call you ✓`, tone: "ok" }, buttons: [], meta: { calledAt: nowIso() } });
    decision({ from: config.ashaName, preview: `asked ${p.name} to call`, rules: ["her tap"], action: "alert", cardId });
    return { ok: true, toast: `I asked ${p.name} to call you ✓` };
  }

  if (action === "ask_caregiver") {
    const cg = caregiver();
    if (!cg || data.meta.askedAt) return { ok: true, toast: "Asked ✓" };
    for (const h of handlesOf(cg.id)) await T.sendText(h, `👋 Someone new texted ${call()} from ${mask(data.meta.sender)}: “${(data.quote ?? "").slice(0, 200)}”. Do you know them? Reply SAFE or SCAM.`);
    db.query("INSERT INTO alert (id, kind, sender, card_id, message, status, created_at) VALUES (?,?,?,?,?,?,?)").run(newId("a"), "unknown", data.meta.sender, cardId, data.quote ?? "", "open", nowIso());
    await updateCard(cardId, "asked", { status: { text: `I asked ${cg.name} ✓`, tone: "info" }, buttons: [], meta: { askedAt: nowIso() } });
    return { ok: true, toast: `I asked ${cg.name} ✓` };
  }

  // Her voice note → "Send to Priya?" card. Text and recipient come from the stored card (not the tap payload).
  if (action === "send_voice_reply" && row.type === "info" && data.meta.voiceReply) {
    if (row.state === "replied") return { ok: true, toast: "Already sent ✓" };
    if (row.state === "cancelled") return { ok: true, toast: "Okay, I didn't send it." };
    if (sending.has(cardId)) return { ok: true, toast: "Sending…" };
    const person = personById(data.meta.personId);
    const textOut = String(data.meta.text ?? "").slice(0, 120);
    const handle = person ? handlesOf(person.id)[0] : undefined;
    if (!person || !textOut || !handle) return { ok: false };
    sending.add(cardId);
    try {
      const ok = await T.sendAsAsha(handle, null, textOut);
      if (!ok) return { ok: false };
      saveMessage({ id: newId("out"), via: "local", direction: "out_as_asha", to: handle, text: textOut, card_id: cardId });
      await updateCard(cardId, "replied", {
        status: { text: `Sent to ${person.name} ✓ “${textOut}”`, tone: "ok" }, buttons: [],
        layout: { ...data.layout, subcaption: `Sent to ${person.name} ✓ “${textOut}”` },
      });
    } finally { sending.delete(cardId); }
    decision({ from: config.ashaName, preview: `🎙️ → ${person.name}: ${textOut}`, rules: ["her voice note", "her tap"], action: "reply", cardId, highlight: [person.id] });
    return { ok: true, toast: `Sent to ${person.name} ✓` };
  }

  if (action === "cancel") {
    if (row.state === "replied") return { ok: true, toast: "Already sent ✓" };
    await updateCard(cardId, "cancelled", { status: { text: "Okay, I didn't send it.", tone: "info" }, buttons: [], layout: { ...data.layout, subcaption: "Not sent" } });
    return { ok: true, toast: "Okay, I didn't send it." };
  }

  if (action === "done" || action === "snooze") {
    const r = reminderByCard(cardId);
    if (!r) return { ok: false };
    if (action === "done") await markReminderDone(r.id, "card tap");
    else await snoozeReminder(r.id);
    return { ok: true, toast: action === "done" ? "Done ✅" : "Okay, I'll remind you again ⏰" };
  }
  return { ok: false };
}

// =====================================================================================
// Asha → Kin (cloud): tapbacks, "who is…", "tell Priya to call me"
// =====================================================================================
export async function onAshaToKin(c: { type: string; text?: string; emoji?: string; targetId?: string }) {
  if (c.type === "reaction" && c.targetId) {
    const card = cardBySpectrumId(c.targetId);
    if (card?.row.type === "reminder" && /👍|❤️|‼️|like|love/.test(c.emoji ?? "")) {
      const r = reminderByCard(card.row.id);
      if (r) await markReminderDone(r.id, `tapback ${c.emoji}`);
    }
    return;
  }
  if (c.type !== "text" || !c.text) return;
  const text = c.text.trim();
  const who = text.match(/^who(?:'s| is| was)\s+([A-Za-z][\w' -]{1,30}?)\??$/i);
  if (who) return whoIs(who[1].trim());
  const callMe = text.match(/(?:tell|ask)\s+([A-Za-z]+)\s+to\s+call\s+me/i);
  if (callMe || /^call me\b/i.test(text)) return askToCall(callMe?.[1] ?? null, text);
  if (/^(done|yes|i did|took it|taken)\b/i.test(text)) {
    const open = db.query("SELECT * FROM reminder WHERE status IN ('due','nudged','escalated') ORDER BY due_at DESC LIMIT 1").get() as any;
    if (open) return void markReminderDone(open.id, "she texted done");
  }
  const digit = text.match(/^[123]$/);
  if (digit) {
    const last = latestCard("context");
    const b = last?.data.buttons.filter((x) => x.action === "reply")[Number(digit[0]) - 1];
    if (last && b) return void onCardAction(last.row.id, b.action, b.payload);
  }
  await outOfScope();
}

/** "Tell Priya to call me" (typed or spoken): ask that person (default: the caregiver) to call her. */
async function askToCall(name: string | null, preview: string) {
  const p = (name && personByName(name)) || caregiver();
  if (!p) return;
  for (const h of handlesOf(p.id)) await T.sendText(h, `${call()} would like you to call her 💛`);
  await T.sendText(config.ashaHandle, `I asked ${p.name} to call you 💛`);
  decision({ from: config.ashaName, preview, rules: ["her request"], action: "alert" });
}

const outOfScope = () => T.sendText(config.ashaHandle, `I can help with your family and messages. For other things, ${caregiver()?.name ?? "your family"} can help 💙`);
const sending = new Set<string>();

// =====================================================================================
// Asha's voice notes → Kin (cloud): Gemini listens; nothing is sent as her without her tap.
// =====================================================================================
export async function onAshaVoiceToKin(bytes: Buffer, mimeType: string, msgId: string) {
  const t0 = Date.now();
  const sorry = () => T.sendText(config.ashaHandle, "Sorry, I couldn't hear that one. You can try again, or type it to me 💙");
  const wav = await toWav(bytes, mimeType);
  if (!wav) { await sorry(); return; }
  const fam = people().map((p) => p.name);
  const v = await understandVoice(wav, fam, config.ashaName);
  saveMessage({ id: msgId, via: "cloud", direction: "in", from: config.ashaHandle, text: v?.transcript ? `🎙️ ${v.transcript}` : "🎙️ (voice)" });
  if (!v) { await sorry(); return; }
  const transcript = (v.transcript ?? "").trim();
  const p = v.to_person ? personByName(v.to_person) : null;

  if (v.intent === "reply") {
    const textOut = (v.text ?? "").trim().replace(/^["“]|["”]$/g, "").slice(0, 120);
    if (!p || !textOut) { await T.sendText(config.ashaHandle, `I heard: “${transcript.slice(0, 100)}”. Who should I send it to? Say their name in your message.`); return; }
    if (/\$|money|gift ?card|password|\bcode\b|bank|social security|card number/i.test(textOut)) { await outOfScope(); return; }
    const data: CardData = {
      title: `Send to ${p.name}?`, subtitle: "your voice message", photoUrl: photoFor(p), emoji: "🎙️",
      line: `“${textOut}”`, quoteFrom: null, quote: null, summary: null, status: null,
      buttons: [btn("✅ Send", "send_voice_reply", { personId: p.id, text: textOut }, "green"), btn("✖ Don't send", "cancel", {}, "plain")],
      readAloud: false, talk: false, to: config.ashaHandle,
      layout: { caption: `🎙️ Send to ${p.name}?`, subcaption: `“${textOut}”`, summary: `Kin: send this to ${p.name}?` },
      meta: { voiceReply: true, personId: p.id, text: textOut, voiceMsg: msgId },
    };
    const card = await createCard("info", "sent", data);
    decision({ from: config.ashaName, preview: `🎙️ ${transcript}`, rules: ["her voice note", "waits for her tap"], action: "card", cardId: card.id, ms: Date.now() - t0, highlight: [p.id] });
    return;
  }
  if (v.intent === "call_me") return askToCall(p?.name ?? null, `🎙️ ${transcript}`);
  if (v.intent === "question") {
    const who = transcript.match(/who(?:'s| is| was)\s+([A-Za-z][\w' -]{1,30}?)[?.!]*$/i)?.[1] ?? v.to_person ?? (v.text || null);
    if (who) return whoIs(who.trim());
  }
  await outOfScope();
}

// =====================================================================================
// Family → Kin photos (cloud): one Gemini call → a photo memory on the map.
// =====================================================================================
export async function onFamilyPhotoToKin(person: Person, from: string, photos: InPhoto[], caption: string, msgId: string) {
  const t0 = Date.now();
  const reply = (s: string) => T.sendText(from, s);
  caption = caption.trim();
  saveMessage({ id: msgId, via: "cloud", direction: "in", from, text: `📸 ${caption}`.trim() });
  const saved: { file: string; jpeg: Buffer }[] = [];
  for (const ph of photos.slice(0, 4)) { const s = await saveImage(ph); if (s) saved.push(s); }
  if (!saved.length) { await reply("Sorry, I couldn't open that photo. Could you send it again?"); return; }
  const main = saved[0];

  const g = await understandPhoto(main.jpeg, caption, person, knownNamesForPrompt(), today(), config.ashaName, call());
  // Code verifies names: only names written in the caption (or the sender) may be used. Never from faces.
  const inCaption = (n: string) => !!n && new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu").test(caption);
  const selfRef = (n: string) => /^(i|me|myself)$/i.test(n.trim()) || n.trim().toLowerCase() === person.name.toLowerCase();
  let about = g?.about?.trim() || person.name;
  if (selfRef(about) || !inCaption(about)) about = person.name;
  const who = [...new Set((g?.who_in_photo ?? []).map((n) => n.trim()).filter((n) => inCaption(n) && !selfRef(n) && n.toLowerCase() !== about.toLowerCase()))].slice(0, 4);
  const memText = g?.memory_text?.trim() || (caption ? `${person.name} shared a photo: ${caption}` : `${person.name} shared a photo`);
  const aboutKind = personByName(about) ? "person" : g?.about_kind ?? "thing";

  const mem = saveMemory(about, memText, g?.happened_on ?? null, person.id, "family_to_kin", msgId, aboutKind, main.file);
  for (const s of saved.slice(1)) saveMemory(about, memText, g?.happened_on ?? null, person.id, "family_to_kin", msgId, aboutKind, s.file);
  for (const n of who) addEdge(n, "pictured_with", about, "in a photo", person.id, "person", aboutKind);
  const aboutId = mem.about;

  // Profile photo: if they say "this is me / use as my picture", or the photo is about a person who has none yet.
  const target = personByName(about) ?? (g?.use_as_profile ? person : null);
  let profile = false;
  if (target && (g?.use_as_profile || !target.photo)) {
    db.query("UPDATE person SET photo = ? WHERE id = ?").run(main.file, target.id);
    profile = true;
  }
  // Re-announce the node with its photo so the dashboard map shows it.
  const ap = personById(aboutId);
  const ent = db.query("SELECT name, kind FROM entity WHERE id = ?").get(aboutId) as { name: string; kind: GraphNode["kind"] } | null;
  const count = (db.query("SELECT COUNT(*) AS n FROM memory WHERE deleted = 0 AND about = ?").get(aboutId) as { n: number }).n;
  const node: GraphNode = aboutId === "asha" ? { id: "asha", label: config.ashaName, kind: "asha", memories: count }
    : ap ? { id: ap.id, label: ap.name, kind: "person", relation: ap.relation, photo: photoFor(ap), memories: count }
    : { id: aboutId, label: ent?.name ?? about, kind: ent?.kind ?? "thing", photo: `/media/${main.file}`, memories: count };
  emit({ kind: "graph", op: "add_node", node });
  emit({ kind: "graph", op: "highlight", ids: [aboutId, ...who.map((n) => resolveNode(n, "person", person.id)[0])] });

  await reply(g?.confirmation?.trim() || `Got it 📸 I saved this photo${caption ? ` (“${caption.slice(0, 60)}”)` : ""}. I'll show it to ${call()} when it helps.`);
  decision({ from: person.name, preview: `📸 ${caption || g?.description || "photo"}`, rules: ["M photo memory", ...(who.length ? [`names from caption: ${who.join(", ")}`] : []), ...(profile ? ["profile photo"] : []), ...(g ? [] : ["fallback: no AI"])], action: "memory", memoryId: mem.id, ms: Date.now() - t0, highlight: [aboutId] });
}

async function whoIs(name: string) {
  const p = personByName(name);
  const e = p ? null : explainEntity(name);
  if (!p && !e) { await T.sendText(config.ashaHandle, `I don't know ${name} yet. I'll ask ${caregiver()?.name ?? "the family"}.`); return; }
  if (p) {
    const mems = memoriesBy(p.id).filter((m) => m.about === p.id).slice(0, 2);
    const data: CardData = {
      title: p.name, subtitle: `your ${p.relation}`, photoUrl: photoFor(p), emoji: p.emoji,
      line: mems[0]?.text ?? null, quoteFrom: null, quote: null, summary: mems[1]?.text ?? null, status: null,
      buttons: [btn(`📞 Ask ${p.name} to call me`, "callme", { personId: p.id }, "blue")], readAloud: true, talk: true,
      to: config.ashaHandle, layout: { caption: `${p.name} · your ${p.relation}`, subcaption: mems[0]?.text ?? "" }, meta: { personId: p.id },
    };
    await createCard("whois", "sent", data);
    decision({ from: config.ashaName, preview: `who is ${name}?`, rules: ["her question"], action: "card", highlight: [p.id] });
  } else if (e) {
    const data: CardData = {
      title: name, subtitle: null, photoUrl: null, emoji: "✨", line: e.text, quoteFrom: null, quote: null, summary: null, status: null,
      buttons: [], readAloud: true, talk: false, to: config.ashaHandle, layout: { caption: name, subcaption: e.text }, meta: {},
    };
    await createCard("whois", "sent", data);
    decision({ from: config.ashaName, preview: `who is ${name}?`, rules: ["her question"], action: "card", highlight: e.ids });
  }
}

// =====================================================================================
// Family → Kin (cloud): memories, reminders, alert answers
// =====================================================================================
export async function onFamilyToKin(person: Person, from: string, text: string, msgId: string) {
  const t0 = Date.now();
  saveMessage({ id: msgId, via: "cloud", direction: "in", from, text });
  const reply = (s: string) => T.sendText(from, s);

  const ans = text.trim().match(/^(safe|scam|it'?s fine|it'?s ok(ay)?|it'?s a scam|not me|it was me|that was me)\b/i);
  if (ans) {
    const safe = /safe|fine|ok|it was me|that was me/i.test(ans[1]);
    const a = db.query("SELECT * FROM alert WHERE status = 'open' ORDER BY created_at DESC LIMIT 1").get() as any;
    if (!a) { await reply("There's nothing waiting for an answer right now 💙"); return; }
    db.query("UPDATE alert SET status = ? WHERE id = ?").run(safe ? "safe" : "scam", a.id);
    if (safe) {
      const c = getCard(a.card_id);
      if (c?.data.meta.claimed) { db.query("INSERT OR REPLACE INTO handle (address, person_id, confirmed) VALUES (?,?,1)").run(a.sender, c.data.meta.claimed); }
      await updateCard(a.card_id, "confirmed_safe", { line: `${person.name} says this is okay.`, status: { text: `${person.name} says this is okay 💙`, tone: "ok" }, buttons: [] });
      await reply(`Thanks. I let ${call()} know it's okay.`);
    } else {
      db.query("INSERT OR REPLACE INTO blocked (address, at) VALUES (?,?)").run(a.sender, nowIso());
      await updateCard(a.card_id, "confirmed_scam", { line: `${person.name} checked this message for you.`, status: { text: `You don't need to do anything 💙`, tone: "ok" }, buttons: [] });
      await reply(`Blocked. If they text ${call()} again, I'll show her a quiet warning and won't bother you.`);
    }
    decision({ from: person.name, preview: text, rules: [safe ? "caregiver: safe" : "caregiver: scam"], action: "alert", cardId: a.card_id });
    return;
  }

  const nowLocal = new Date().toLocaleString("en-US", { timeZone: config.tz, dateStyle: "full", timeStyle: "short" });
  const u = await gen<FamilyUnderstanding>("family_to_kin", `Now: ${nowLocal} (America/New_York).
${person.name} (${config.ashaName}'s ${person.relation}, the person texting Kin) wrote to Kin:
"""${text}"""
"${call()}", "Mom", "Grandma" and "her" mean ${config.ashaName}. Known people and things: ${knownNamesForPrompt()}.
Classify the intent:
- memory: a fact to remember about the family ("Remember: Raj's dog is Biscuit", "I started a new job at Duke").
- reminder: asks Kin to remind ${config.ashaName} of something. Fill reminder.text in the family's words addressed to her (e.g. "take your 2pm pill 💊"), due_local "HH:MM" 24h if a clock time is given, in_minutes if relative ("in 5 minutes"), daily if every day.
- urgent: asks Kin to make sure she sees a message. about_me: asks what Kin knows about them. forget: "forget that"/"undo". other: anything else.
For memory: entities (new names only), edges (src/dst are names; rel like owns, lives_in, works_at, studies_at, married_to, parent_of; label is a short human label like "dog", "works at"), memories (about = the name the fact is about; text = one third-person sentence; happened_on YYYY-MM-DD resolved against Now, or null). If the sender says "I", the name is ${person.name}.
confirmation: a short warm reply to ${person.name} confirming what Kin will do, in Kin's voice ("Got it: Biscuit is Raj's dog 🐶"). Never claim to have done anything not listed.`, familySchema);

  if (!u) { await reply("Sorry, I couldn't understand that just now. Try “Remember: …” or “Remind Nani to …”."); return; }
  switch (u.intent) {
    case "memory": {
      const kinds = new Map(u.entities.map((e) => [e.name.toLowerCase(), e.kind]));
      for (const e of u.entities) if (!personByName(e.name)) { /* created lazily by edges/memories */ }
      for (const ed of u.edges.slice(0, 4)) addEdge(ed.src, ed.rel, ed.dst, ed.label, person.id, kinds.get(ed.src.toLowerCase()) ?? "person", kinds.get(ed.dst.toLowerCase()) ?? "thing");
      const ids: string[] = [];
      for (const m of u.memories.slice(0, 3)) ids.push(saveMemory(m.about, m.text, m.happened_on, person.id, "family_to_kin", msgId, kinds.get(m.about.toLowerCase()) ?? "thing").id);
      await reply(u.confirmation);
      decision({ from: person.name, preview: text, rules: [`M saved ${ids.length} memor${ids.length === 1 ? "y" : "ies"}`], action: "memory", memoryId: ids[0] ?? null, ms: Date.now() - t0 });
      return;
    }
    case "reminder": {
      if (!u.reminder) { await reply("When should I remind her?"); return; }
      const r = await createReminder(person, u.reminder);
      await reply(r.confirmation);
      decision({ from: person.name, preview: text, rules: [`T reminder at ${fmtTime(r.dueAt)}${u.reminder.daily ? " daily" : ""}`], action: "reminder", ms: Date.now() - t0 });
      return;
    }
    case "about_me": {
      const mems = memoriesBy(person.id);
      await reply(mems.length ? `Here's what I know about you:\n${mems.map((m) => `• ${m.text}`).join("\n")}\n\nSay “forget that” to remove the newest one.` : "I don't have any memories about you yet.");
      return;
    }
    case "forget": {
      const m = forgetLast(person.id);
      await reply(m ? `Forgotten: “${m.text}”` : "There's nothing to forget.");
      return;
    }
    default:
      await reply(u.confirmation || `I can remember things about the family and send ${call()} reminders from you. Try “Remember: …” or “Remind ${call()} to …”.`);
  }
}

export function isFamilyHandle(h: string): Person | null {
  if (isAsha(h)) return null;
  return personByHandle(h);
}
export { emit };
