// Card service: per-member HMAC tokens (plan id + handle → the server knows WHO tapped), card rows in SQLite,
// app() cards with a layout, edit() in place. Cards only ever go to card-capable (phone) members.
import { createHmac, timingSafeEqual } from "crypto";
import type { AppLayout } from "spectrum-ts";
import { config, mask, memberByHandle, members } from "../config";
import { db, newId, nowIso } from "../db";
import { log } from "../events";
import type { Transport, CardRef } from "../transport";

export type CardKind = "offer" | "plan";
type CardRow = { id: string; plan_id: string; handle: string; message_id: string | null; token: string; kind: CardKind; session: string | null; version: number };

const refs = new Map<string, CardRef>();
let transport: Transport | null = null;
export function setCardTransport(t: Transport) { transport = t; }
export function getTransport(): Transport | null { return transport; }

export function planToken(planId: string, handle: string): string {
  return createHmac("sha256", config.cardSecret).update(`plan:${planId}:${handle}`).digest("base64url").slice(0, 22);
}
/** Which member does this token belong to? null = invalid. */
export function handleForToken(planId: string, t: string | null | undefined): string | null {
  if (!t) return null;
  for (const m of members()) {
    const want = Buffer.from(planToken(planId, m.handle));
    const got = Buffer.from(t);
    if (want.length === got.length && timingSafeEqual(want, got)) return m.handle;
  }
  return null;
}
export function planUrl(planId: string, handle: string, version: number): string {
  return `${config.publicBaseUrl}/plan/${planId}?t=${planToken(planId, handle)}&v=${version}`;
}

export function cardsOf(planId: string, kinds?: CardKind[]): CardRow[] {
  const rows = db.query("SELECT * FROM card WHERE plan_id = ? ORDER BY created_at").all(planId) as CardRow[];
  return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
}

export async function sendCard(planId: string, handle: string, kind: CardKind, layout: AppLayout): Promise<boolean> {
  const m = memberByHandle(handle);
  // Pro lines can only reach phone numbers; the email member votes by typing in the group.
  if (!m || !m.cardCapable) { log.warn(`card refused: ${mask(handle)} can't receive cards`); return false; }
  if (cardsOf(planId, [kind]).some((c) => c.handle === m.handle)) { log.warn(`card refused: ${m.name} already has a ${kind} card`); return false; }
  const id = newId("c");
  db.query("INSERT INTO card (id, plan_id, handle, token, kind, version, created_at) VALUES (?,?,?,?,?,1,?)").run(id, planId, m.handle, planToken(planId, m.handle), kind, nowIso());
  if (!transport) return false;
  const ref = await transport.sendCard(m.handle, planUrl(planId, m.handle, 1), layout);
  if (!ref) { log.warn(`${kind} card to ${m.name} not sent`); return false; }
  refs.set(id, ref);
  db.query("UPDATE card SET message_id = ?, session = ? WHERE id = ?").run(ref.id, safeJson(ref.session), id);
  log.info(`${kind} card → ${m.name} (${ref.id})`);
  return true;
}

/** edit() every card of these kinds for the plan, in place. */
export async function editCards(planId: string, kinds: CardKind[], layout: AppLayout): Promise<number> {
  let n = 0;
  for (const c of cardsOf(planId, kinds)) {
    const version = c.version + 1;
    db.query("UPDATE card SET version = ? WHERE id = ?").run(version, c.id);
    if (!transport) continue;
    let ref = refs.get(c.id);
    if (!ref && c.message_id) ref = { id: c.message_id, session: c.session ? JSON.parse(c.session) : undefined };
    if (!ref) continue;
    const ok = await transport.editCard(c.handle, ref, planUrl(planId, c.handle, version), layout);
    if (ok) { n++; db.query("UPDATE card SET session = ? WHERE id = ?").run(safeJson(ref.session), c.id); }
  }
  return n;
}

function safeJson(v: unknown): string | null {
  if (v === undefined) return null;
  try { return JSON.stringify(v); } catch { return null; }
}
