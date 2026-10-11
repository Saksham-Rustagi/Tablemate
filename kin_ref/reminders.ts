// Reminders from family, delivered as cards in the family member's name, with gentle escalation.
import { config, fmtTime, minutes } from "./config";
import { db, handlesOf, newId, nowIso, personById, type Person, type Reminder } from "./db";
import { decision, log } from "./events";
import { createCard, updateCard, btn, type CardData } from "./cards/service";
import type { Transport } from "./transport";
import { prefetchAudio } from "./voice";

let T: Transport;
export function setReminderTransport(t: Transport) { T = t; }

const call = () => config.ashaCalledBy;

/** Turn "HH:MM" (America/New_York) into the next occurrence as a Date. */
function nextLocal(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const localNow = new Date(now.toLocaleString("en-US", { timeZone: config.tz }));
  const offset = now.getTime() - localNow.getTime();
  const target = new Date(localNow);
  target.setHours(h, m || 0, 0, 0);
  if (target.getTime() <= localNow.getTime() - 60_000) target.setDate(target.getDate() + 1);
  return new Date(target.getTime() + offset);
}

export async function createReminder(person: Person, r: { text: string; due_local: string | null; daily: boolean; in_minutes: number | null }) {
  let due: Date;
  const demoSec = Number(process.env.DEMO_REMINDER_SEC || 0);
  if (demoSec > 0) due = new Date(Date.now() + demoSec * 1000);
  else if (r.in_minutes != null) due = new Date(Date.now() + r.in_minutes * 60_000);
  else if (r.due_local && /^\d{1,2}:\d{2}/.test(r.due_local)) due = nextLocal(r.due_local.slice(0, 5));
  else due = new Date(Date.now() + 60_000);
  const id = newId("r");
  db.query("INSERT INTO reminder (id, created_by, text, rrule, due_at, status, step, notify_creator, created_at) VALUES (?,?,?,?,?,?,0,1,?)")
    .run(id, person.id, r.text.slice(0, 80), r.daily ? "DAILY" : null, due.toISOString(), "scheduled", nowIso());
  // In demo mode the card arrives after DEMO_REMINDER_SEC, but we confirm the time the family asked for.
  const shown = demoSec > 0 && r.due_local && /^\d{1,2}:\d{2}/.test(r.due_local) ? nextLocal(r.due_local.slice(0, 5)) : due;
  const when = r.daily ? `daily at ${fmtTime(shown)}` : (r.in_minutes ?? 99) < 60 && demoSec === 0 ? `at ${fmtTime(shown)}` : `${shown.toDateString() === new Date().toDateString() ? "today" : "tomorrow"} at ${fmtTime(shown)}`;
  log.info(`reminder ${id} due ${fmtTime(due)}${demoSec ? " (demo clock)" : ""} (“${r.text}”)`);
  const quoted = /[\p{Extended_Pictographic}.!?]\s*$/u.test(r.text) ? r.text : r.text + ".";
  return { id, dueAt: due, confirmation: `Got it: ${when}, “${quoted}” I'll let you know when she's done it.` };
}

export function reminderByCard(cardId: string): Reminder | null {
  return (db.query("SELECT * FROM reminder WHERE card_id = ? ORDER BY created_at DESC LIMIT 1").get(cardId) as Reminder | null) ?? null;
}

function cardData(r: Reminder, p: Person | null): CardData {
  const name = p?.name ?? "Your family";
  return {
    title: name, subtitle: "asked me to remind you", photoUrl: p?.photo ? `/media/${p.photo}` : null, emoji: "💊",
    line: r.text.charAt(0).toUpperCase() + r.text.slice(1), quoteFrom: null, quote: null, summary: null, status: null,
    buttons: [btn("✅ Done", "done", {}, "green"), btn("⏰ In 10 minutes", "snooze", {}, "blue")], readAloud: true, talk: true,
    to: config.ashaHandle,
    layout: { caption: `${name} asked me to remind you`, subcaption: r.text, summary: `Kin: reminder from ${name}` },
    meta: { reminderId: r.id, personId: p?.id ?? null },
  };
}

async function deliver(r: Reminder) {
  const p = personById(r.created_by);
  if (r.card_id) {
    // snoozed reminder coming back: same card, back to due
    await updateCard(r.card_id, "due", { ...cardData(r, p), status: null });
  } else {
    const card = await createCard("reminder", "due", cardData(r, p));
    db.query("UPDATE reminder SET card_id = ? WHERE id = ?").run(card.id, r.id);
    prefetchAudio(card.id);
  }
  db.query("UPDATE reminder SET status = 'due', step = 1 WHERE id = ?").run(r.id);
  decision({ from: p?.name ?? "family", preview: r.text, rules: ["T+0 reminder due"], action: "reminder", highlight: p ? [p.id] : [] });
}

export async function markReminderDone(id: string, how: string) {
  const r = db.query("SELECT * FROM reminder WHERE id = ?").get(id) as Reminder | null;
  if (!r || r.status === "done") return;
  const at = new Date();
  db.query("UPDATE reminder SET status = 'done', done_at = ? WHERE id = ?").run(at.toISOString(), id);
  const p = personById(r.created_by);
  if (r.card_id) await updateCard(r.card_id, "done", {
    status: { text: `Done at ${fmtTime(at)} ✅ ${p ? `${p.name} knows.` : ""}`, tone: "ok" }, buttons: [],
    layout: { caption: `✅ Done at ${fmtTime(at)}`, subcaption: r.text },
  });
  if (r.notify_creator && p) for (const h of handlesOf(p.id)) await T.sendText(h, `${call()} did it: “${r.text}” ✅ at ${fmtTime(at)}`);
  decision({ from: config.ashaName, preview: `done: ${r.text}`, rules: [`T done (${how})`], action: "reminder", highlight: p ? [p.id] : [] });
  if (r.rrule === "DAILY") {
    const next = new Date(Date.parse(r.due_at) + 86400_000);
    db.query("INSERT INTO reminder (id, created_by, text, rrule, due_at, status, step, notify_creator, created_at) VALUES (?,?,?,?,?,?,0,?,?)")
      .run(newId("r"), r.created_by, r.text, "DAILY", next.toISOString(), "scheduled", r.notify_creator, nowIso());
  }
}

export async function snoozeReminder(id: string) {
  const r = db.query("SELECT * FROM reminder WHERE id = ?").get(id) as Reminder | null;
  if (!r || r.status === "done") return;
  const due = new Date(Date.now() + minutes(10));
  db.query("UPDATE reminder SET status = 'scheduled', step = 0, due_at = ? WHERE id = ?").run(due.toISOString(), id);
  if (r.card_id) await updateCard(r.card_id, "snoozed", { status: { text: `Okay. I'll remind you again at ${fmtTime(due)} ⏰`, tone: "info" }, buttons: [] });
  decision({ from: config.ashaName, preview: `snoozed: ${r.text}`, rules: ["T snooze 10 min"], action: "reminder" });
}

/** Escalation ladder (Product Spec §6.3): T+0 card · T+30 nudge in the same card · T+60 tell the family member. Calls: skipped. */
async function tick() {
  const now = Date.now();
  const rows = db.query("SELECT * FROM reminder WHERE status IN ('scheduled','due','nudged')").all() as Reminder[];
  for (const r of rows) {
    const due = Date.parse(r.due_at);
    try {
      if (r.status === "scheduled" && now >= due) await deliver(r);
      else if (r.status === "due" && now >= due + minutes(30)) {
        db.query("UPDATE reminder SET status = 'nudged', step = 2 WHERE id = ?").run(r.id);
        if (r.card_id) await updateCard(r.card_id, "nudged", { status: { text: `Just checking: did you ${r.text.replace(/^(please |remember to |don't forget to )/i, "")}?`, tone: "warn" } });
        decision({ from: "Kin", preview: r.text, rules: ["T+30 gentle nudge"], action: "reminder" });
      } else if (r.status === "nudged" && now >= due + minutes(60)) {
        db.query("UPDATE reminder SET status = 'escalated', step = 3 WHERE id = ?").run(r.id);
        const p = personById(r.created_by);
        if (p) for (const h of handlesOf(p.id)) await T.sendText(h, `${call()} hasn't confirmed “${r.text}” yet (due ${fmtTime(due)}). Maybe give her a call? 💛`);
        decision({ from: "Kin", preview: r.text, rules: ["T+60 told the family"], action: "alert" });
      }
    } catch (e) { log.error(`reminder ${r.id} tick`, e); }
  }
}

export function startReminderLoop() {
  setInterval(() => void tick(), 2000);
}
