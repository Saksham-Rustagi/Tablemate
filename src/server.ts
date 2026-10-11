// HTTP: plan card pages + taps (public, via tunnel), invite.ics, media, Retell (delegated to calls.ts),
// and the localhost-only dashboard (+ reset / simulate / forget).
import { existsSync } from "fs";
import { config, memberByHandle, members } from "./config";
import { db } from "./db";
import { log, eventsSince, lastSeq, emit } from "./events";
import { handleForToken } from "./cards/service";
import { renderPlanPage } from "./cards/render";
import { renderDashboard } from "./dash/page";
import { geminiUsed } from "./ai/gemini";
import * as calls from "./calls";
import * as memory from "./memory";
import { act, getPlan, icsFor, latestPlan, planEvents, rsvpsOf, STATES, viewFor, votesOf, optionsOf } from "./plan";
import { drain, fakeLocalMessage, route } from "./router";
import { resetDemo } from "./seed";

const html = (b: string, status = 200) => new Response(b, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { "cache-control": "no-store" } });
const isLocal = (req: Request) => !req.headers.get("cf-connecting-ip") && !req.headers.get("x-forwarded-for");

type Health = () => { local: boolean; cloud: boolean };
let health: Health = () => ({ local: false, cloud: false });

function dashState() {
  const p = latestPlan();
  const nameOf = (h: string) => memberByHandle(h)?.name ?? h;
  let callRows: any[] = [];
  if (p) { try { callRows = db.query("SELECT * FROM call WHERE plan_id = ? ORDER BY attempt").all(p.id) as any[]; } catch { /* C's table may not exist yet */ } }
  const facts = config.groupChatIds.flatMap((c) => { try { return memory.factsFor(c); } catch { return []; } });
  return {
    states: STATES,
    members: members(),
    chats: config.groupChatIds.length,
    facts,
    plan: p ? {
      id: p.id, state: p.state, meal: p.meal, day: p.day, organizer: nameOf(p.organizer), chosen: p.chosen_time,
      window: [p.window_start, p.window_end], attempt: p.attempt, statusLine: p.status_line, askTime: p.ask_time,
      votingClosed: !!p.voting_closed, deadline: p.deadline_at,
      options: optionsOf(p.id).map((o, i) => ({ idx: i, name: o.name, emoji: o.emoji, why: o.why, walkMin: o.walkMin, rating: o.rating })),
      votes: votesOf(p.id).map((v) => ({ name: nameOf(v.handle), idx: v.option_idx, via: v.via })),
      rsvps: rsvpsOf(p.id).map((r) => ({ name: nameOf(r.handle), status: r.status, time: r.time_pref })),
      filtered: JSON.parse(p.filtered || "[]"),
      events: planEvents(p.id),
      view: viewFor(p.id, p.organizer),
      calls: callRows.map((c) => ({ attempt: c.attempt, place: c.place_name ?? c.place_id, status: c.status, dialed: c.dialed })),
    } : null,
    health: { ...health(), tunnel: !!config.publicBaseUrl, gemini: { used: geminiUsed(), limit: config.geminiDailyLimit } },
  };
}

/** The whole HTTP surface as one function (tests call it directly with a Request). */
export async function handle(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const p = u.pathname;
  try {
    // ---------- plan card ----------
    let m = p.match(/^\/plan\/([\w-]+)(\/state|\/act|\/invite\.ics)?$/);
    if (m) {
      const [, id, sub] = m;
      const who = handleForToken(id, u.searchParams.get("t"));
      if (!who || !getPlan(id)) return sub ? json({ ok: false, error: "expired" }, 403) : html("<h1>This card has expired.</h1>", 403);
      if (!sub && req.method === "GET") return html(renderPlanPage(viewFor(id, who)!));
      if (sub === "/state" && req.method === "GET") return json(viewFor(id, who));
      if (sub === "/act" && req.method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        const r = await act(id, who, String(body.action || ""), body);
        return json(r.body, r.status);
      }
      if (sub === "/invite.ics" && req.method === "GET") {
        const ics = icsFor(id);
        return ics ? new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="dinner.ics"' } }) : new Response("not booked", { status: 404 });
      }
    }
    // ---------- Retell (calls.ts) ----------
    if (p.startsWith("/retell/")) {
      const r = await calls.retellRoutes(req, u);
      return r ?? new Response("not found", { status: 404 });
    }
    if (p === "/diag" && req.method === "POST") {
      const d: any = await req.json().catch(() => ({}));
      log.info(`device: ${d.page ?? "?"} ${d.ev ?? "load"} ${d.id ?? ""} ${d.w ? `${d.w}x${d.h}` : ""}${d.msg ? " " + d.msg : ""}`);
      return new Response("ok");
    }
    // ---------- media ----------
    m = p.match(/^\/media\/([\w.-]+\.(?:jpg|jpeg|png))$/);
    if (m && req.method === "GET") {
      const f = `${config.dataDir}/media/${m[1]}`;
      return existsSync(f) ? new Response(Bun.file(f)) : new Response("not found", { status: 404 });
    }
    if (p === "/health") return json({ ok: true, ...health(), gemini: geminiUsed() });

    // ---------- dashboard (localhost only) ----------
    if (p.startsWith("/dash")) {
      if (!isLocal(req)) return new Response("not found", { status: 404 });
      if (p === "/dash") return html(renderDashboard());
      if (p === "/dash/state") return json(dashState());
      if (p === "/dash/events") {
        const since = Number(u.searchParams.get("since") || 0);
        return json({ seq: lastSeq(), events: eventsSince(since > lastSeq() ? 0 : since) });
      }
      if (p === "/dash/reset" && req.method === "POST") { resetDemo(); log.info("dashboard: demo reset"); return json({ ok: true }); }
      if (p === "/dash/simulate" && req.method === "POST") {
        const b: any = await req.json().catch(() => ({}));
        const who = memberByHandle(b.handle);
        const chatId = String(b.chatId || config.groupChatIds[0] || "");
        if (!who || !String(b.text ?? "").trim() || !chatId) return json({ ok: false, error: "need a member handle, text and an enrolled chat" }, 400);
        const [space, message] = fakeLocalMessage(chatId, who.handle, String(b.text));
        await route(space, message);
        if (b.wait) await drain();
        return json({ ok: true, id: message.id });
      }
      if (p === "/dash/forget" && req.method === "POST") {
        const b: any = await req.json().catch(() => ({}));
        memory.forgetFact(Number(b.id));
        return json({ ok: true });
      }
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    log.error(`HTTP ${p}`, e);
    return json({ ok: false }, 500);
  }
}

export function startServer(opts: { health: Health }) {
  health = opts.health;
  return Bun.serve({ port: config.port, idleTimeout: 0, fetch: handle });
}

/** Push a health event every 10 s for the dashboard. */
export function startHealthTicker(h: Health) {
  health = h;
  setInterval(() => {
    const x = h();
    emit({ kind: "health", local: x.local, cloud: x.cloud, tunnel: !!config.publicBaseUrl, gemini: { used: geminiUsed(), limit: config.geminiDailyLimit } });
  }, 10000);
}
