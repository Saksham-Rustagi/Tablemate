// ☀️ Morning "Today" card (Product Spec §11): built from code only (reminders + upcoming family events), sent once a day at 8:00.
import { config, fmtTime } from "./config";
import { db, kvGet, kvSet, personById, type Memory, type Reminder } from "./db";
import { decision, log } from "./events";
import { createCard, type CardData } from "./cards/service";
import { prefetchAudio } from "./voice";

const localDate = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: config.tz }); // YYYY-MM-DD
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "2:00 PM · Take your 2pm pill 💊 (from Priya)" for each reminder due today (local time). */
function todayReminders(): string[] {
  const today = localDate();
  const rows = db.query("SELECT * FROM reminder ORDER BY due_at").all() as Reminder[];
  return rows.filter((r) => localDate(Date.parse(r.due_at)) === today).map((r) => {
    const p = personById(r.created_by);
    return `${fmtTime(r.due_at)} · ${cap(r.text)}${p ? ` (from ${p.name})` : ""}${r.status === "done" ? " ✅" : ""}`;
  });
}

/** Visits/events from the memory graph dated today or in the next 7 days: "Tomorrow · Priya is visiting with mangoes". */
function upcoming(): string[] {
  const days = Array.from({ length: 8 }, (_, i) => localDate(Date.now() + i * 86400_000));
  const qs = days.map(() => "?").join(",");
  const rows = db.query(`SELECT * FROM memory WHERE deleted = 0 AND happened_on IN (${qs}) ORDER BY happened_on, created_at`).all(...days) as Memory[];
  return rows.map((m) => {
    const i = days.indexOf(m.happened_on!);
    const when = i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(`${m.happened_on}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    return `${when} · ${m.text}`;
  });
}

export async function sendTodayCard(): Promise<{ id: string; sent: boolean }> {
  const items = [...todayReminders(), ...upcoming()];
  const date = new Date().toLocaleDateString("en-US", { timeZone: config.tz, weekday: "long", month: "long", day: "numeric" });
  const line = items[0] ?? "No reminders today. Your family is a text away 💙";
  const data: CardData = {
    title: `Good morning, ${config.ashaName}`, subtitle: date, photoUrl: null, emoji: "☀️",
    line, quoteFrom: null, quote: null, summary: items[1] ?? null, status: null,
    buttons: [], readAloud: true, talk: true, to: config.ashaHandle,
    layout: { caption: `☀️ Good morning, ${config.ashaName}`, subcaption: line, summary: "Kin: your day today" },
    meta: { today: localDate(), items },
  };
  const card = await createCard("info", "sent", data);
  prefetchAudio(card.id);
  decision({ from: "Kin", preview: `☀️ Today: ${line}`, rules: [`morning card (${items.length} item${items.length === 1 ? "" : "s"})`], action: "card", cardId: card.id });
  return card;
}

/** Checks every 30 s; sends once per local day during the 8 o'clock hour (kv "today_sent_<date>"). */
export function startTodayLoop() {
  setInterval(() => {
    const hour = Number(new Date().toLocaleString("en-US", { timeZone: config.tz, hour: "numeric", hourCycle: "h23" }));
    const key = `today_sent_${localDate()}`;
    if (hour !== 8 || kvGet(key)) return;
    kvSet(key, new Date().toISOString());
    sendTodayCard().catch((e) => log.error("today card", e));
  }, 30_000);
}
