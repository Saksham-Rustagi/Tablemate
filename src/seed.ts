// Seed / reset: clears plans, votes, cards, messages and facts, then adds people from TM_PEOPLE.
// TM_DEMO_SEED=1 also adds three demo facts (source "demo_seed", tagged on the dashboard).
// Run directly: ~/.bun/bin/bun src/seed.ts
import type { NewFact } from "./contracts";
import { config, members } from "./config";
import { db, nowIso } from "./db";
import { clearEvents, log } from "./events";
import * as memory from "./memory";

const TABLES = ["plan", "option", "skipped", "vote", "rsvp", "card", "plan_event", "msg", "fact", "call"];

export function resetDemo() {
  memory.initMemory();
  for (const t of TABLES) { try { db.exec(`DELETE FROM ${t}`); } catch { /* table owned by B/C may not exist yet */ } }
  db.exec("DELETE FROM kv WHERE key LIKE 'offer_at:%'");
  db.exec("DELETE FROM person");
  const ins = db.query("INSERT INTO person (handle, name, is_card_capable) VALUES (?,?,?)");
  for (const p of members()) ins.run(p.handle, p.name, p.cardCapable ? 1 : 0);
  clearEvents();
  if (process.env.TM_DEMO_SEED === "1") seedDemoFacts();
}

function seedDemoFacts() {
  const chatId = config.groupChatIds[0];
  if (!chatId) { log.warn("demo seed: no TM_GROUP_CHAT_IDS"); return; }
  const ms = members();
  const pick = (name: string, i: number) => ms.find((m) => m.name.toLowerCase() === name) ?? ms[i];
  const demo: [ReturnType<typeof pick>, NewFact["kind"], string, string][] = [
    [pick("nicole", 1), "diet", "vegetarian", "I'm vegetarian btw"],
    [pick("saksham", 0), "budget", "cheap", "broke this week lol"],
    [pick("maya", 2), "availability", "not after 20:30", "can't do after 8:30"],
  ];
  let n = 0;
  for (const [who, kind, value, quote] of demo) {
    if (!who) continue;
    const msgId = `demo_seed_${++n}`;
    memory.saveFacts(chatId, [{ chatId, handle: who.handle, name: who.name, kind, value, quote, msgId, saidAt: nowIso(), source: "demo_seed" }], { [msgId]: quote }, ms);
  }
  log.info(`demo seed: ${n} facts`);
}

if (import.meta.main) {
  resetDemo();
  log.info(`seeded ${members().length} people${process.env.TM_DEMO_SEED === "1" ? " + demo facts" : ""}`);
}
