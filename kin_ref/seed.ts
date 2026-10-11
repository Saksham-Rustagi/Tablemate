// Demo seed: a made-up family (free-tier Gemini => made-up data only). Run: bun src/seed.ts  (wipes the memory tables)
import { db, nowIso } from "./db";
import { config, normalizeHandle } from "./config";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

export function seed() {
  db.exec("DELETE FROM person; DELETE FROM handle; DELETE FROM entity; DELETE FROM edge; DELETE FROM memory; DELETE FROM card; DELETE FROM reminder; DELETE FROM alert; DELETE FROM blocked; DELETE FROM message;");
  db.exec("DELETE FROM kv WHERE key NOT LIKE 'local_rowid%'");
  const P = db.query("INSERT INTO person (id, name, relation, emoji, is_caregiver, pronoun, last_contact_at, known_by_asha) VALUES (?,?,?,?,?,?,?,0)");
  P.run("priya", "Priya", "granddaughter", "👩🏽", 1, "she", daysAgo(12));
  P.run("raj", "Raj", "son", "👨🏽", 0, "he", daysAgo(21));
  P.run("anita", "Anita", "daughter", "👩🏽‍💼", 0, "she", daysAgo(3));
  const H = db.query("INSERT OR REPLACE INTO handle (address, person_id, confirmed) VALUES (?,?,1)");
  if (config.caregiverHandle) H.run(config.caregiverHandle, "priya");
  for (const h of (process.env.RAJ_HANDLES || "+15555550101").split(",")) H.run(normalizeHandle(h), "raj");
  for (const h of (process.env.ANITA_HANDLES || "+15555550102").split(",")) H.run(normalizeHandle(h), "anita");

  const E = db.query("INSERT INTO entity (id, kind, name, aliases, emoji) VALUES (?,?,?,?,?)");
  E.run("biscuit", "pet", "Biscuit", JSON.stringify(["biscuit the dog"]), "🐶");
  E.run("austin", "place", "Austin", "[]", "📍");
  E.run("diwali_2025", "event", "Diwali 2025", JSON.stringify(["diwali"]), "🪔");
  E.run("unc", "place", "UNC", JSON.stringify(["chapel hill", "carolina"]), "🎓");

  const G = db.query("INSERT INTO edge (src, rel, dst, label, added_by, at) VALUES (?,?,?,?,?,?)");
  G.run("raj", "owns", "biscuit", "dog", "priya", nowIso());
  G.run("raj", "lives_in", "austin", "lives in", "priya", nowIso());
  G.run("priya", "studies_at", "unc", "studies at", "priya", nowIso());
  G.run("priya", "attended", "diwali_2025", "celebrated", "priya", nowIso());
  G.run("raj", "attended", "diwali_2025", "celebrated", "priya", nowIso());

  const M = db.query("INSERT INTO memory (id, about, text, happened_on, added_by, source, created_at) VALUES (?,?,?,?,?,?,?)");
  M.run("m_01", "priya", "Priya visited Asha on Sunday, Sept 27, and brought mangoes", "2026-09-27", "priya", "family_to_kin", nowIso());
  M.run("m_02", "priya", "Priya is studying nursing at UNC in Chapel Hill", null, "priya", "family_to_kin", nowIso());
  M.run("m_03", "raj", "Raj lives in Austin with his dog Biscuit", null, "priya", "family_to_kin", nowIso());
  M.run("m_04", "biscuit", "Biscuit is Raj's golden retriever", null, "priya", "family_to_kin", nowIso());
  M.run("m_05", "diwali_2025", "Asha, Priya and Raj celebrated Diwali 2025 together at Raj's house in Austin", "2025-10-20", "priya", "family_to_kin", nowIso());
  M.run("m_06", "anita", "Anita takes care of Asha's bills", null, "priya", "family_to_kin", nowIso());
  M.run("m_07", "raj", "Raj calls Asha every Sunday evening", null, "anita", "family_to_kin", nowIso());
}

if (import.meta.main) {
  seed();
  const n = (t: string) => (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  console.log(`seeded: ${n("person")} people, ${n("handle")} handles, ${n("entity")} entities, ${n("edge")} edges, ${n("memory")} memories`);
}
