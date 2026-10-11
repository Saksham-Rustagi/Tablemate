// Create/update the Retell LLM + agent (+ number if RETELL_BUY_NUMBER=1). Prints ids (truncated), model, voice, number (masked), HTTP statuses.
import { ensureRetellSynced, retellLog, syncInfo } from "../src/retell_sync";

const trunc = (s?: string) => (s ? `${s.slice(0, 10)}…` : "-");
const mask = (n?: string) => (n ? `…${n.slice(-4)}` : "-");

let failed = false;
try {
  await ensureRetellSynced(process.env.PUBLIC_BASE_URL || "");
} catch (e) {
  failed = true;
  console.log(`SYNC FAILED: ${(e as Error).message}`);
}
for (const r of retellLog) console.log(`  ${r.method} ${r.path} → ${r.status}`);
console.log(`actions: ${syncInfo.actions.join(", ") || "-"}`);
console.log(`llm:     ${trunc(syncInfo.llm)}`);
console.log(`agent:   ${trunc(syncInfo.agent)}`);
console.log(`model:   ${syncInfo.model ?? "-"}`);
console.log(`voice:   ${syncInfo.voice ?? "-"}`);
console.log(`number:  ${mask(syncInfo.number)}`);
process.exit(failed ? 1 : 0);
