import { quoteIn } from "./quote";
// Group memory: verified facts (who said it, exact quote, when). Implements MemoryModule from contracts.ts.
import { db } from "./db";
import { emit, log } from "./events";
import type { Fact, FactKind, NewFact, Person } from "./contracts";

const TZ = "America/New_York";
const KINDS: FactKind[] = ["diet", "allergy", "dislike", "like", "budget", "availability"];
const REPLACING: FactKind[] = ["budget", "availability"]; // a newer one of these replaces the older one
const SYNONYMS: Record<string, string> = {
  veggie: "vegetarian",
  "plant-based": "vegan",
  "plant based": "vegan",
  "gluten free": "gluten-free",
};

export function initMemory(): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS fact (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, handle TEXT, name TEXT,
  kind TEXT CHECK(kind IN ('diet','allergy','dislike','like','budget','availability')), value TEXT, quote TEXT, msg_id TEXT,
  said_at TEXT, source TEXT CHECK(source IN ('chat','demo_seed')), active INTEGER DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS fact_active_uniq ON fact(chat_id, handle, kind, value) WHERE active = 1;
`);
}

type FactRow = { id: number; chat_id: string; handle: string; name: string; kind: FactKind; value: string; quote: string;
  msg_id: string; said_at: string; source: "chat" | "demo_seed"; active: number };
const toFact = (r: FactRow): Fact => ({ id: r.id, chatId: r.chat_id, handle: r.handle, name: r.name, kind: r.kind, value: r.value,
  quote: r.quote, msgId: r.msg_id, saidAt: r.said_at, source: r.source });

export function normalizeValue(v: string): string {
  const s = v.trim().toLowerCase().replace(/\s+/g, " ");
  return SYNONYMS[s] ?? s;
}

/** Verifies (member + quote is a real substring of that member's message), normalises, dedupes, saves, emits. Returns saved facts. */
export function saveFacts(chatId: string, facts: NewFact[], messageTextById: Record<string, string>, members: Person[]): Fact[] {
  const saved: Fact[] = [];
  for (const f of facts) {
    const member = members.find((m) => m.handle === f.handle);
    if (!member) { log.warn(`fact dropped: ${f.handle} is not a member`); continue; }
    if (!KINDS.includes(f.kind)) { log.warn(`fact dropped: bad kind ${f.kind}`); continue; }
    if (!Object.prototype.hasOwnProperty.call(messageTextById, f.msgId)) { log.warn(`fact dropped: msg ${f.msgId} is not ${member.name}'s`); continue; }
    const quote = (f.quote ?? "").trim();
    if (!quote || !messageTextById[f.msgId] || !quoteIn(quote, messageTextById[f.msgId], member.name)) {
      log.warn(`fact dropped: quote not in ${member.name}'s message`);
      continue;
    }
    const value = normalizeValue(f.value ?? "");
    if (!value) continue;

    const same = db.query("SELECT 1 FROM fact WHERE chat_id = ? AND handle = ? AND kind = ? AND value = ? AND active = 1")
      .get(chatId, f.handle, f.kind, value);
    if (same) continue;
    if (REPLACING.includes(f.kind)) {
      const newer = db.query("SELECT 1 FROM fact WHERE chat_id = ? AND handle = ? AND kind = ? AND active = 1 AND said_at > ?")
        .get(chatId, f.handle, f.kind, f.saidAt);
      if (newer) continue;
      db.query("UPDATE fact SET active = 0 WHERE chat_id = ? AND handle = ? AND kind = ? AND active = 1").run(chatId, f.handle, f.kind);
    }
    const row = db.query(`INSERT INTO fact (chat_id, handle, name, kind, value, quote, msg_id, said_at, source, active)
      VALUES (?,?,?,?,?,?,?,?,?,1) RETURNING *`)
      .get(chatId, f.handle, member.name, f.kind, value, quote, f.msgId, f.saidAt, f.source ?? "chat") as FactRow;
    const fact = toFact(row);
    saved.push(fact);
    emit({ kind: "fact", fact } as any);
  }
  return saved;
}

export function factsFor(chatId: string): Fact[] {
  return (db.query("SELECT * FROM fact WHERE chat_id = ? AND active = 1 ORDER BY said_at, id").all(chatId) as FactRow[]).map(toFact);
}

export function forgetFact(id: number): void {
  const row = db.query("SELECT * FROM fact WHERE id = ? AND active = 1").get(id) as FactRow | null;
  if (!row) return;
  db.query("UPDATE fact SET active = 0 WHERE id = ?").run(id);
  emit({ kind: "fact_forgotten", factId: id, fact: toFact(row) } as any);
  log.info(`forgot fact #${id} (${row.name}: ${row.kind} ${row.value})`);
}

export function allergiesFor(chatId: string, handles: string[]): string[] {
  return factsFor(chatId).filter((f) => f.kind === "allergy" && handles.includes(f.handle)).map((f) => `${f.value} (${f.name})`);
}

const nyDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

/** "Nicole's vegetarian (Thu)"; "today" if said today (America/New_York). */
export function factLabel(f: Fact, now: Date = new Date()): string {
  const said = new Date(f.saidAt);
  const when = nyDate(said) === nyDate(now) ? "today" : said.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" });
  const first = f.name.split(" ")[0];
  const what = f.kind === "dislike" ? `${first} dislikes ${f.value}` : f.kind === "budget" ? `${first}'s budget` : `${first}'s ${f.value}`;
  return `${what} (${when})`;
}
