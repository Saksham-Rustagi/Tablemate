// Event bus for the "Tablemate's thinking" dashboard (polled via /dash/events) and the console log.
import type { Fact } from "./contracts";

export type DashEvent =
  | { kind: "log"; at: string; level: "info" | "warn" | "error"; text: string }
  | { kind: "decision"; at: string; from: string; preview: string; rules: string[]; action: string; ms?: number }
  | { kind: "fact"; fact: Fact; forgotten?: boolean }
  | { kind: "filter"; planId: string; name: string; reason: string }
  | { kind: "call"; planId: string; attempt: number; phase: "dialing" | "started" | "ended" | "result"; detail: string }
  | { kind: "transcript"; planId: string; attempt: number; role: "agent" | "restaurant"; text: string }
  | { kind: "plan"; planId: string; from: string; to: string; why: string }
  | { kind: "vote"; planId: string; handle: string; name: string; optionIdx: number; via: "card" | "text" }
  | { kind: "rsvp"; planId: string; handle: string; name: string; status: "in" | "out"; timePref: string | null; via: "card" | "text" }
  | { kind: "message"; chatId: string; name: string; text: string }
  | { kind: "health"; local: boolean; cloud: boolean; tunnel: boolean; gemini: { used: number; limit: number } };

export type Stamped = DashEvent & { seq: number; ts: string };

type Listener = (e: Stamped) => void;
const listeners = new Set<Listener>();
const recent: Stamped[] = [];
let seq = 0;

export function emit(e: DashEvent) {
  const s = { ...e, seq: ++seq, ts: new Date().toISOString() } as Stamped;
  recent.push(s);
  if (recent.length > 400) recent.shift();
  for (const l of listeners) {
    try { l(s); } catch { /* ignore */ }
  }
}
export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function eventsSince(since: number): Stamped[] {
  return recent.filter((e) => e.seq > since && e.kind !== "health");
}
export function lastSeq(): number {
  return seq;
}
export function clearEvents() {
  recent.length = 0;
}

const now = () => new Date().toISOString();
const stamp = () => new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

export const log = {
  info(text: string) { console.log(`[${stamp()}] ${text}`); emit({ kind: "log", at: now(), level: "info", text }); },
  warn(text: string) { console.warn(`[${stamp()}] WARN ${text}`); emit({ kind: "log", at: now(), level: "warn", text }); },
  error(text: string, err?: unknown) {
    const msg = err ? `${text}: ${(err as any)?.message ?? err}` : text;
    console.error(`[${stamp()}] ERROR ${msg}`);
    emit({ kind: "log", at: now(), level: "error", text: msg });
  },
};

export function decision(d: Omit<Extract<DashEvent, { kind: "decision" }>, "kind" | "at">) {
  console.log(`[${stamp()}] DECISION ${d.action.toUpperCase()} ${d.from}: "${d.preview.slice(0, 60)}" [${d.rules.join(", ")}]${d.ms ? ` ${d.ms}ms` : ""}`);
  emit({ kind: "decision", at: now(), ...d });
}
