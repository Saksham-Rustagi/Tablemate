// Kin: one Bun process. Local provider (Asha's Mac) + cloud provider (Kin's line) + card server + dashboard.
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { config } from "./config";
import { db, kvGet, kvSet } from "./db";
import { log } from "./events";
import { seed } from "./seed";
import { createSpectrumTransport, createFakeTransport, type Transport } from "./transport";
import { setCardTransport } from "./cards/service";
import { setTransport } from "./kin";
import { setReminderTransport, startReminderLoop } from "./reminders";
import { startTodayLoop } from "./today";
import { setVoiceTransport } from "./voice";
import { startServer, startHealthTicker } from "./server";
import { runRouter } from "./router";
import { ensureAgentSynced } from "./agent";

if (!(db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number }).n) { seed(); log.info("seeded demo family"); }

// Resume the local watcher from the last chat.db ROWID we saw, so messages that arrived while Kin was down aren't lost.
let chat: Database | null = null;
try { chat = new Database(`${homedir()}/Library/Messages/chat.db`, { readonly: true }); } catch (e) { log.warn("chat.db not readable (Full Disk Access?)"); }
const maxRow = () => (chat ? ((chat.query("SELECT MAX(ROWID) AS n FROM message").get() as { n: number }).n ?? 0) : 0);
const saved = Number(kvGet("local_rowid") || 0);
if (config.resumeLocal && saved && chat && maxRow() - saved < 200) {
  process.env.IMK_START_ROWID = String(saved);
  log.info(`local watcher resumes after ROWID ${saved} (${maxRow() - saved} newer rows)`);
}

const fake = process.argv.includes("--fake");
const T: Transport = fake ? createFakeTransport() : await createSpectrumTransport();
setCardTransport(T); setTransport(T); setReminderTransport(T); setVoiceTransport(T);

startServer({ health: () => T.health(), onReset: () => { seed(); log.info("demo reset: re-seeded family"); } });
ensureAgentSynced().catch((e) => log.error("agent sync failed", e));
// Quick tunnels get a new address on restart: card links signed with the old base no longer open.
try {
  const prevBase = kvGet("cards_base");
  if (config.publicBase && prevBase !== config.publicBase) {
    if (prevBase) log.warn("Tunnel address changed — cards sent before now won't open; send fresh cards.");
    kvSet("cards_base", config.publicBase);
  }
} catch (e) { log.error("cards_base check", e); }
startReminderLoop();
startTodayLoop();
startHealthTicker(() => T.health());
setInterval(() => { const n = maxRow(); if (n) kvSet("local_rowid", String(n)); }, 5000);

log.info(`Kin is running${fake ? " (FAKE transport)" : ""} · card base ${config.publicBase ? config.publicBase.slice(0, 20) + "…" : "(none)"} · dashboard on http://localhost:${config.port}/dash · fast clock ${config.fastClock ? "ON" : "off"}`);

const shutdown = async () => { log.info("stopping"); const n = maxRow(); if (n) kvSet("local_rowid", String(n)); await T.stop().catch(() => {}); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

if (!fake) void runRouter(T);
