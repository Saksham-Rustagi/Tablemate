// Event bus for the "Kin's thinking" dashboard (SSE) and the console log.
export type GraphNode = { id: string; label: string; kind: "asha" | "person" | "pet" | "place" | "event" | "thing"; photo?: string | null; relation?: string | null; memories?: number };
export type GraphLink = { source: string; target: string; rel: string };
export type DashEvent =
  | { kind: "log"; at: string; level: "info" | "warn" | "error"; text: string }
  | { kind: "decision"; at: string; from: string; preview: string; rules: string[]; action: "card" | "protect" | "quiet" | "hold" | "reply" | "memory" | "reminder" | "alert"; memoryId?: string | null; cardId?: string | null; ms?: number; highlight?: string[] }
  | { kind: "graph"; op: "add_node"; node: GraphNode }
  | { kind: "graph"; op: "add_link"; link: GraphLink }
  | { kind: "graph"; op: "highlight"; ids: string[] }
  | { kind: "health"; local: boolean; cloud: boolean; tunnel: boolean; gemini: { used: number; limit: number } };

type Listener = (e: DashEvent) => void;
const listeners = new Set<Listener>();
const recent: DashEvent[] = [];

export function emit(e: DashEvent) {
  recent.push(e);
  if (recent.length > 80) recent.shift();
  for (const l of listeners) {
    try { l(e); } catch { /* ignore */ }
  }
}
export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function recentEvents(): DashEvent[] {
  return recent.filter((e) => e.kind === "decision" || e.kind === "log").slice(-40);
}

const now = () => new Date().toISOString();
const stamp = () => new Date().toLocaleTimeString("en-US", { timeZone: process.env.TZ || "America/New_York", hour12: false });

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
