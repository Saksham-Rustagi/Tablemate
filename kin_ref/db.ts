// SQLite (bun:sqlite) — the memory graph, messages, cards, reminders, alerts.
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { config, normalizeHandle } from "./config";

mkdirSync(`${config.dataDir}/media`, { recursive: true });
export const db = new Database(process.env.KIN_DB || `${config.dataDir}/kin.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS person (id TEXT PRIMARY KEY, name TEXT, relation TEXT, photo TEXT, emoji TEXT,
  is_caregiver INT DEFAULT 0, enrolled INT DEFAULT 1, confirmed INT DEFAULT 1, known_by_asha INT DEFAULT 0, always_help INT DEFAULT 0,
  pronoun TEXT DEFAULT 'they', last_contact_at TEXT);
CREATE TABLE IF NOT EXISTS handle (address TEXT PRIMARY KEY, person_id TEXT, confirmed INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS entity (id TEXT PRIMARY KEY, kind TEXT, name TEXT, aliases TEXT DEFAULT '[]', person_id TEXT, emoji TEXT, known_by_asha INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS edge (src TEXT, rel TEXT, dst TEXT, label TEXT, source_msg TEXT, added_by TEXT, at TEXT, PRIMARY KEY(src, rel, dst));
CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, about TEXT, text TEXT, happened_on TEXT, photo TEXT, added_by TEXT,
  source TEXT, source_msg TEXT, created_at TEXT, deleted INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, via TEXT, direction TEXT, chat TEXT, from_addr TEXT, to_addr TEXT,
  text TEXT, ts TEXT, decision TEXT, card_id TEXT);
CREATE TABLE IF NOT EXISTS card (id TEXT PRIMARY KEY, type TEXT, state TEXT, data TEXT, spectrum_id TEXT, session TEXT,
  version INT DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS reminder (id TEXT PRIMARY KEY, created_by TEXT, text TEXT, rrule TEXT, due_at TEXT, status TEXT,
  card_id TEXT, step INT DEFAULT 0, notify_creator INT DEFAULT 1, created_at TEXT, done_at TEXT);
CREATE TABLE IF NOT EXISTS alert (id TEXT PRIMARY KEY, kind TEXT, sender TEXT, card_id TEXT, message TEXT, status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS blocked (address TEXT PRIMARY KEY, at TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);

export type Person = { id: string; name: string; relation: string; photo: string | null; emoji: string | null; is_caregiver: number;
  enrolled: number; confirmed: number; known_by_asha: number; always_help: number; pronoun: string; last_contact_at: string | null };
export type Entity = { id: string; kind: string; name: string; aliases: string; person_id: string | null; emoji: string | null; known_by_asha: number };
export type Memory = { id: string; about: string; text: string; happened_on: string | null; photo: string | null; added_by: string;
  source: string; source_msg: string | null; created_at: string; deleted: number };
export type CardRow = { id: string; type: string; state: string; data: string; spectrum_id: string | null; session: string | null; version: number; created_at: string; updated_at: string };
export type Reminder = { id: string; created_by: string; text: string; rrule: string | null; due_at: string; status: string; card_id: string | null;
  step: number; notify_creator: number; created_at: string; done_at: string | null };

export const nowIso = () => new Date().toISOString();
export const newId = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// ---------- people ----------
export function personByHandle(h: string): Person | null {
  const row = db.query("SELECT p.* FROM handle h JOIN person p ON p.id = h.person_id WHERE h.address = ? AND h.confirmed = 1").get(normalizeHandle(h)) as Person | null;
  return row ?? null;
}
export function personById(id: string): Person | null {
  return (db.query("SELECT * FROM person WHERE id = ?").get(id) as Person | null) ?? null;
}
export function people(): Person[] {
  return db.query("SELECT * FROM person").all() as Person[];
}
export function handlesOf(personId: string): string[] {
  return (db.query("SELECT address FROM handle WHERE person_id = ? AND confirmed = 1").all(personId) as { address: string }[]).map((r) => r.address);
}
export function caregiver(): Person | null {
  return (db.query("SELECT * FROM person WHERE is_caregiver = 1 LIMIT 1").get() as Person | null) ?? null;
}
export function touchContact(personId: string, at = nowIso()) {
  db.query("UPDATE person SET last_contact_at = ? WHERE id = ?").run(at, personId);
}
export function personByName(name: string): Person | null {
  const n = name.trim().toLowerCase();
  return people().find((p) => p.name.toLowerCase() === n || p.id === n) ?? null;
}

// ---------- entities / edges / memories ----------
export function entities(): Entity[] {
  return db.query("SELECT * FROM entity").all() as Entity[];
}
export function entityByName(name: string): Entity | null {
  const n = name.trim().toLowerCase();
  for (const e of entities()) {
    if (e.name.toLowerCase() === n) return e;
    try { if ((JSON.parse(e.aliases) as string[]).some((a) => a.toLowerCase() === n)) return e; } catch { /* */ }
  }
  return null;
}
export function edgesOf(id: string): { src: string; rel: string; dst: string; label: string | null }[] {
  return db.query("SELECT src, rel, dst, label FROM edge WHERE src = ? OR dst = ?").all(id, id) as any;
}
export function memoriesAbout(ids: string[], limit = 12): Memory[] {
  if (!ids.length) return [];
  const qs = ids.map(() => "?").join(",");
  return db.query(`SELECT * FROM memory WHERE deleted = 0 AND about IN (${qs}) ORDER BY COALESCE(happened_on, created_at) DESC LIMIT ${limit}`).all(...ids) as Memory[];
}
export function memoryById(id: string): Memory | null {
  return (db.query("SELECT * FROM memory WHERE id = ? AND deleted = 0").get(id) as Memory | null) ?? null;
}
export function addMemory(m: Omit<Memory, "id" | "created_at" | "deleted"> & { id?: string }): Memory {
  const row: Memory = { id: m.id ?? newId("m"), created_at: nowIso(), deleted: 0, ...m } as Memory;
  db.query("INSERT OR REPLACE INTO memory (id, about, text, happened_on, photo, added_by, source, source_msg, created_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(row.id, row.about, row.text, row.happened_on, row.photo, row.added_by, row.source, row.source_msg, row.created_at);
  return row;
}

// ---------- messages ----------
export function seenMessage(id: string): boolean {
  return !!db.query("SELECT 1 FROM message WHERE id = ?").get(id);
}
export function saveMessage(m: { id: string; via: string; direction: string; chat?: string; from?: string; to?: string; text?: string; decision?: unknown; card_id?: string | null }) {
  db.query("INSERT OR IGNORE INTO message (id, via, direction, chat, from_addr, to_addr, text, ts, decision, card_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(m.id, m.via, m.direction, m.chat ?? null, m.from ?? null, m.to ?? null, m.text ?? null, nowIso(), m.decision ? JSON.stringify(m.decision) : null, m.card_id ?? null);
}

// ---------- kv ----------
export function kvGet(key: string): string | null {
  return ((db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null)?.value) ?? null;
}
export function kvSet(key: string, value: string) {
  db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
}

// ---------- graph for the dashboard ----------
export function graph() {
  const nodes: any[] = [{ id: "asha", label: config.ashaName, kind: "asha", memories: 0 }];
  const count = (id: string) => (db.query("SELECT COUNT(*) AS n FROM memory WHERE deleted = 0 AND about = ?").get(id) as { n: number }).n;
  const memPhoto = (id: string) => (db.query("SELECT photo FROM memory WHERE deleted = 0 AND about = ? AND photo IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(id) as { photo: string } | null)?.photo ?? null;
  const media = (f: string | null) => (f ? `/media/${f}` : null);
  for (const p of people()) nodes.push({ id: p.id, label: p.name, kind: "person", photo: media(p.photo ?? memPhoto(p.id)), relation: p.relation, memories: count(p.id) });
  for (const e of entities()) if (!e.person_id) nodes.push({ id: e.id, label: e.name, kind: e.kind, photo: media(memPhoto(e.id)), memories: count(e.id) });
  const ids = new Set(nodes.map((n) => n.id));
  const links: any[] = [];
  for (const p of people()) links.push({ source: "asha", target: p.id, rel: p.relation.replace(/^her /, "") });
  for (const e of db.query("SELECT src, rel, dst, label FROM edge").all() as any[]) {
    if (ids.has(e.src) && ids.has(e.dst)) links.push({ source: e.src, target: e.dst, rel: e.label || e.rel });
  }
  return { nodes, links };
}
