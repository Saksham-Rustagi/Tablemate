// Memory layer: candidates → (Gemini pick) → code verification; entity explanations; ingest with graph events.
import { db, entities, entityByName, edgesOf, memoriesAbout, memoryById, addMemory, personById, personByName, people, newId, nowIso, type Memory, type Person, type Entity } from "./db";
import { emit } from "./events";

const BANNED = /\b(remember|recall|do you|did you|don't you|can you)\b|\?/i;

export function candidatesFor(person: Person, mentionNames: string[]): Memory[] {
  const ids = new Set<string>([person.id]);
  for (const n of mentionNames) {
    const e = entityByName(n);
    if (e) ids.add(e.id);
    const p = personByName(n);
    if (p) ids.add(p.id);
  }
  return memoriesAbout([...ids], 14);
}

/** Verify Gemini's pick: memory must exist and be a candidate; names in the line must be grounded; no memory-quizzing. */
export function verifyMemoryLine(memoryId: string | null, line: string | null, cands: Memory[], person: Person): { id: string; line: string } | null {
  if (!memoryId || !line) return null;
  const m = memoryById(memoryId);
  if (!m || !cands.some((c) => c.id === memoryId)) return null;
  if (BANNED.test(line)) return null;
  if (line.length > 90) return null;
  const grounded = (m.text + " " + person.name + " " + person.relation + " Asha Nani she he her his").toLowerCase();
  const names = line.match(/\b[A-Z][a-z]+\b/g) ?? [];
  const stop = new Set(["She", "He", "They", "Her", "His", "The", "A", "An", "On", "In", "At", "Last", "This", "That", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Sept", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "You", "Your", "With", "And"]);
  for (const n of names) if (!stop.has(n) && !grounded.includes(n.toLowerCase())) return null;
  return { id: m.id, line };
}

const KIND_EMOJI: Record<string, string> = { pet: "🐶", place: "📍", event: "🎉", thing: "✨", person: "🧑" };

/** R3 explanation, from the graph only (no AI): "Biscuit is Raj's dog 🐶". */
export function explainEntity(name: string): { id: string; text: string; ids: string[] } | null {
  const e = entityByName(name);
  if (!e) {
    const p = personByName(name);
    if (p) return { id: p.id, text: `${p.name} is your ${p.relation}`, ids: [p.id] };
    return null;
  }
  for (const ed of edgesOf(e.id)) {
    const other = ed.src === e.id ? ed.dst : ed.src;
    const op = personById(other);
    if (!op) continue;
    if (ed.rel === "owns") return { id: e.id, text: `${e.name} is ${op.name}'s ${ed.label || e.kind} ${e.emoji ?? KIND_EMOJI[e.kind] ?? ""}`.trim(), ids: [e.id, op.id] };
    if (ed.rel === "lives_in") return { id: e.id, text: `${op.name} lives in ${e.name} ${e.emoji ?? ""}`.trim(), ids: [e.id, op.id] };
    if (ed.rel === "works_at" || ed.rel === "studies_at") return { id: e.id, text: `${op.name} ${ed.label || ed.rel.replace("_", " ")} ${e.name} ${e.emoji ?? ""}`.trim(), ids: [e.id, op.id] };
  }
  const m = memoriesAbout([e.id], 1)[0];
  if (m) return { id: e.id, text: m.text, ids: [e.id] };
  return null;
}

/** Entities Asha may not place (R3): known entities, or people, mentioned and not marked known_by_asha. */
export function unplacedMentions(mentionNames: string[], sender: Person): { name: string; id: string }[] {
  const out: { name: string; id: string }[] = [];
  for (const n of mentionNames) {
    const e = entityByName(n);
    if (e && !e.known_by_asha) { out.push({ name: e.name, id: e.id }); continue; }
    const p = personByName(n);
    if (p && p.id !== sender.id && !p.known_by_asha) out.push({ name: p.name, id: p.id });
  }
  return out;
}

/** Regex mention finder (fallback when Gemini is down). */
export function regexMentions(text: string): string[] {
  const names: string[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (a: string) => new RegExp(`(^|[^\\p{L}])${esc(a)}([^\\p{L}]|$)`, "iu").test(text);
  for (const e of entities()) {
    const all = [e.name, ...(JSON.parse(e.aliases || "[]") as string[])];
    if (all.some(has)) names.push(e.name);
  }
  for (const p of people()) if (has(p.name)) names.push(p.name);
  return [...new Set(names)];
}

// ---------------- ingest ----------------
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || newId("e");

/** Resolve a name to a node id: person by name, entity by name/alias, else create the entity. Returns [id, created]. */
export function resolveNode(name: string, kind: string, addedBy: string): [string, boolean] {
  const p = personByName(name);
  if (p) return [p.id, false];
  if (/^(asha|nani|mom|grandma|grandmother|her|she)$/i.test(name.trim())) return ["asha", false];
  const e = entityByName(name);
  if (e) return [e.id, false];
  let id = slug(name);
  if (db.query("SELECT 1 FROM entity WHERE id = ?").get(id)) id = `${id}_${crypto.randomUUID().slice(0, 4)}`;
  const k = ["person", "pet", "place", "event", "thing"].includes(kind) ? kind : "thing";
  db.query("INSERT INTO entity (id, kind, name, aliases, emoji) VALUES (?,?,?,?,?)").run(id, k, name.trim(), "[]", KIND_EMOJI[k] ?? "✨");
  emit({ kind: "graph", op: "add_node", node: { id, label: name.trim(), kind: k as any, memories: 0 } });
  return [id, true];
}

export function addEdge(srcName: string, rel: string, dstName: string, label: string, addedBy: string, srcKind = "thing", dstKind = "thing") {
  const [src] = resolveNode(srcName, srcKind, addedBy);
  const [dst] = resolveNode(dstName, dstKind, addedBy);
  if (src === dst) return;
  const r = rel.toLowerCase().replace(/\s+/g, "_");
  const res = db.query("INSERT OR IGNORE INTO edge (src, rel, dst, label, added_by, at) VALUES (?,?,?,?,?,?)").run(src, r, dst, label, addedBy, nowIso());
  if (res.changes) emit({ kind: "graph", op: "add_link", link: { source: src, target: dst, rel: label || r } });
}

export function saveMemory(aboutName: string, text: string, happenedOn: string | null, addedBy: string, source: "family_to_kin" | "family_thread" | "asha", sourceMsg: string | null, kindHint = "thing", photo: string | null = null): Memory {
  const [about] = resolveNode(aboutName, kindHint, addedBy);
  const m = addMemory({ about, text: text.slice(0, 160), happened_on: validDate(happenedOn), photo, added_by: addedBy, source, source_msg: sourceMsg });
  emit({ kind: "graph", op: "highlight", ids: [about] });
  return m;
}

/** Card photo for a person: their profile photo, else the newest photo memory about them. "/media/<file>" or null. */
export function photoFor(p: Person): string | null {
  if (p.photo) return `/media/${p.photo}`;
  const m = db.query("SELECT photo FROM memory WHERE deleted = 0 AND about = ? AND photo IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(p.id) as { photo: string } | null;
  return m ? `/media/${m.photo}` : null;
}

function validDate(d: string | null): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t) || t > Date.now() + 366 * 86400_000) return null;
  return d;
}

export function memoriesBy(personId: string): Memory[] {
  return db.query("SELECT * FROM memory WHERE deleted = 0 AND (about = ? OR added_by = ?) ORDER BY created_at DESC LIMIT 8").all(personId, personId) as Memory[];
}

export function forgetLast(personId: string): Memory | null {
  const m = db.query("SELECT * FROM memory WHERE deleted = 0 AND added_by = ? ORDER BY created_at DESC LIMIT 1").get(personId) as Memory | null;
  if (m) db.query("UPDATE memory SET deleted = 1 WHERE id = ?").run(m.id);
  return m;
}

export function knownNamesForPrompt(): string {
  const ps = people().map((p) => `${p.name} (${p.relation})`);
  const es = entities().map((e) => `${e.name} (${e.kind})`);
  return [...ps, ...es].join(", ");
}
export type { Entity };
