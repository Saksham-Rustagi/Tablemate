// Card service: rows in SQLite, signed URLs, send app() cards with layout, edit() in place, render for GET /card/:id.
import { createHmac } from "crypto";
import type { AppLayout } from "spectrum-ts";
import { config } from "../config";
import { db, newId, nowIso, type CardRow } from "../db";
import { log } from "../events";
import type { Transport, CardRef } from "../transport";
import { renderCard, type CardButton, type CardType, type CardView } from "./render";

export type CardData = Omit<CardView, "id" | "type" | "state" | "version" | "token"> & {
  layout: AppLayout;
  to: string; // handle the card was sent to
  meta: Record<string, any>;
};

const refs = new Map<string, CardRef>();
let transport: Transport | null = null;
export function setCardTransport(t: Transport) { transport = t; }

export function cardToken(id: string): string {
  return createHmac("sha256", config.signingSecret).update(`card:${id}`).digest("base64url").slice(0, 22);
}
export function checkToken(id: string, t: string | null | undefined): boolean {
  return !!t && t === cardToken(id);
}
export function cardUrl(id: string, version: number): string {
  return `${config.publicBase}/card/${id}?t=${cardToken(id)}&v=${version}`;
}

export function getCard(id: string): { row: CardRow; data: CardData } | null {
  const row = db.query("SELECT * FROM card WHERE id = ?").get(id) as CardRow | null;
  if (!row) return null;
  return { row, data: JSON.parse(row.data) as CardData };
}

export function viewOf(row: CardRow, data: CardData): CardView {
  const { layout: _l, to: _t, meta: _m, ...v } = data;
  return { ...v, id: row.id, type: row.type as CardType, state: row.state, version: row.version, token: cardToken(row.id) };
}

export function renderCardHtml(id: string): string | null {
  const c = getCard(id);
  if (!c) return null;
  return renderCard(viewOf(c.row, c.data));
}

export async function createCard(type: CardType, state: string, data: CardData): Promise<{ id: string; sent: boolean }> {
  const id = newId("c");
  db.query("INSERT INTO card (id, type, state, data, version, created_at, updated_at) VALUES (?,?,?,?,1,?,?)")
    .run(id, type, state, JSON.stringify(data), nowIso(), nowIso());
  if (!transport) return { id, sent: false };
  // Cards are only ever for Asha (never to family or an unknown sender).
  if (data.to !== config.ashaHandle) { log.error(`card ${id} refused: recipient is not Asha`); return { id, sent: false }; }
  const ref = await transport.sendCard(data.to, cardUrl(id, 1), data.layout);
  if (!ref) { log.warn(`card ${id} not sent`); return { id, sent: false }; }
  refs.set(id, ref);
  db.query("UPDATE card SET spectrum_id = ?, session = ? WHERE id = ?").run(ref.id, safeJson(ref.session), id);
  log.info(`card ${id} (${type}/${state}) sent → ${ref.id}`);
  return { id, sent: true };
}

/** Change a card's state/data and edit() the same bubble in place. */
export async function updateCard(id: string, state: string, patch: Partial<CardData>): Promise<boolean> {
  const c = getCard(id);
  if (!c) return false;
  const data: CardData = { ...c.data, ...patch, meta: { ...c.data.meta, ...(patch.meta ?? {}) } };
  const version = c.row.version + 1;
  db.query("UPDATE card SET state = ?, data = ?, version = ?, updated_at = ? WHERE id = ?").run(state, JSON.stringify(data), version, nowIso(), id);
  if (!transport) return true;
  let ref = refs.get(id);
  if (!ref && c.row.spectrum_id) ref = { id: c.row.spectrum_id, session: c.row.session ? JSON.parse(c.row.session) : undefined };
  if (!ref) return false;
  const ok = await transport.editCard(data.to, ref, cardUrl(id, version), data.layout);
  if (ok) db.query("UPDATE card SET session = ? WHERE id = ?").run(safeJson(ref.session), id);
  log.info(`card ${id} → ${state} (v${version}) ${ok ? "edited in place" : "EDIT FAILED"}`);
  return ok;
}

export function cardBySpectrumId(spectrumId: string): { row: CardRow; data: CardData } | null {
  const row = db.query("SELECT * FROM card WHERE spectrum_id = ?").get(spectrumId) as CardRow | null;
  return row ? { row, data: JSON.parse(row.data) } : null;
}

export function latestCard(type: CardType, toHandle?: string): { row: CardRow; data: CardData } | null {
  const rows = db.query("SELECT * FROM card WHERE type = ? ORDER BY created_at DESC LIMIT 10").all(type) as CardRow[];
  for (const row of rows) {
    const data = JSON.parse(row.data) as CardData;
    if (!toHandle || data.to === toHandle) return { row, data };
  }
  return null;
}

export function btn(label: string, action: string, payload?: Record<string, unknown>, style: CardButton["style"] = "blue"): CardButton {
  return { id: `${action}_${Math.random().toString(36).slice(2, 7)}`, label, action, payload, style };
}

function safeJson(v: unknown): string | null {
  if (v === undefined) return null;
  try { return JSON.stringify(v); } catch { return null; }
}
