// SQLite (bun:sqlite): people, plans, options, votes, RSVPs, cards, plan events, kv, message log (dedupe + history).
// B creates `fact` and `places_cache`; C creates `call`.
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "./config";

mkdirSync(`${config.dataDir}/media`, { recursive: true });
mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS person (handle TEXT PRIMARY KEY, name TEXT, is_card_capable INT);
CREATE TABLE IF NOT EXISTS plan (id TEXT PRIMARY KEY, chat_id TEXT, organizer TEXT, state TEXT, meal TEXT, day TEXT,
  window_start TEXT, window_end TEXT, chosen_time TEXT, default_time TEXT, area TEXT, created_at TEXT, deadline_at TEXT,
  voting_closed INT DEFAULT 0, booked_place_id TEXT, booked_time TEXT, booked_party INT, booking_name TEXT,
  attempt INT DEFAULT 0, tried TEXT DEFAULT '[]', call_idx INT, ask_time TEXT, ask_votes TEXT DEFAULT '{}',
  status_line TEXT, filtered TEXT DEFAULT '[]', rev INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS option (plan_id TEXT, idx INT, place_id TEXT, name TEXT, address TEXT, phone TEXT, photo TEXT,
  price_level INT, rating REAL, walk_min INT, why TEXT, json TEXT, PRIMARY KEY(plan_id, idx));
CREATE TABLE IF NOT EXISTS skipped (plan_id TEXT, place_id TEXT, name TEXT, reason TEXT, fact_id INT);
CREATE TABLE IF NOT EXISTS vote (plan_id TEXT, handle TEXT, option_idx INT, via TEXT CHECK(via IN('card','text')), at TEXT, PRIMARY KEY(plan_id, handle));
CREATE TABLE IF NOT EXISTS rsvp (plan_id TEXT, handle TEXT, status TEXT CHECK(status IN('in','out')), time_pref TEXT, at TEXT, PRIMARY KEY(plan_id, handle));
CREATE TABLE IF NOT EXISTS card (id TEXT PRIMARY KEY, plan_id TEXT, handle TEXT, message_id TEXT, token TEXT, kind TEXT, session TEXT, version INT DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS plan_event (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, at TEXT, from_state TEXT, to_state TEXT, why TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS msg (id TEXT PRIMARY KEY, chat_id TEXT, handle TEXT, name TEXT, text TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS msg_chat ON msg(chat_id, at);
`);

export const nowIso = () => new Date().toISOString();
export const newId = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// ---------- messages (dedupe + context for Gemini) ----------
export type MsgRow = { id: string; chat_id: string; handle: string; name: string; text: string; at: string };
export function seenMessage(id: string): boolean {
  return !!db.query("SELECT 1 FROM msg WHERE id = ?").get(id);
}
export function saveMessage(m: MsgRow) {
  db.query("INSERT OR IGNORE INTO msg (id, chat_id, handle, name, text, at) VALUES (?,?,?,?,?,?)").run(m.id, m.chat_id, m.handle, m.name, m.text, m.at);
}
export function recentMessages(chatId: string, limit = 20, excludeIds: string[] = []): MsgRow[] {
  const rows = db.query("SELECT * FROM msg WHERE chat_id = ? ORDER BY at DESC LIMIT ?").all(chatId, limit + excludeIds.length) as MsgRow[];
  return rows.filter((r) => !excludeIds.includes(r.id)).slice(0, limit).reverse();
}

// ---------- kv ----------
export function kvGet(key: string): string | null {
  return ((db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null)?.value) ?? null;
}
export function kvSet(key: string, value: string) {
  db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
}
