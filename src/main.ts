// Tablemate: one Bun process. Local provider (reads the enrolled group, read-only) + cloud provider (Tablemate's line)
// + card server + dashboard on :3001.
import { config } from "./config";
import { db, kvGet, kvSet } from "./db";
import { log } from "./events";
import * as memory from "./memory";
import * as calls from "./calls";
import { resetDemo } from "./seed";
import { createSpectrumTransport, createFakeTransport, type Transport } from "./transport";
import { setCardTransport } from "./cards/service";
import { initPlans } from "./plan";
import { startServer, startHealthTicker } from "./server";
import { runRouter } from "./router";

memory.initMemory();
calls.initCalls();
if (!(db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number }).n) { resetDemo(); log.info("seeded people from TM_PEOPLE"); }

const fake = process.argv.includes("--fake");
const T: Transport = fake ? createFakeTransport() : await createSpectrumTransport();
setCardTransport(T);
initPlans();

startServer({ health: () => T.health() });
startHealthTicker(() => T.health());
void calls.ensureRetellSynced(config.publicBaseUrl).catch((e) => log.error("retell sync failed", e));
// Quick tunnels get a new address on restart: card links signed with the old base no longer open.
const prevBase = kvGet("cards_base");
if (config.publicBaseUrl && prevBase !== config.publicBaseUrl) {
  if (prevBase) log.warn("Tunnel address changed — cards sent before now won't open; send fresh cards.");
  kvSet("cards_base", config.publicBaseUrl);
}

log.info(`Tablemate is running${fake ? " (FAKE transport)" : ""} · base ${config.publicBaseUrl ? config.publicBaseUrl.slice(0, 28) + "…" : "(none)"} · ${config.groupChatIds.length} enrolled chat(s) · ${config.people.length} people · dashboard on http://localhost:${config.port}/dash · deadline ${config.demoFast ? "2 min (DEMO_FAST)" : "45 min"}`);

const shutdown = async () => { log.info("stopping"); await T.stop().catch(() => {}); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

if (!fake) void runRouter(T);
