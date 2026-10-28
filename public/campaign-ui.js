import { call, esc } from "./common.js";
import {
  CAMPAIGN_FIELDS, SESSION_FIELDS, blankSession, normalizeDoc, sharedView, buildReport, prettyDate, planCounts, planHasContent,
} from "./campaign.js";
import { mountPlan } from "./session-plan.js";
import { makeDocx, downloadBlob } from "./docx.js";

const STATUS = { saved: "Saved", saving: "Saving…", error: "Offline, retrying…" };
const rowsFor = (text) => Math.max(3, Math.min(14, Math.ceil(String(text).length / 70) + 1));

/* onShared(rev) is called when the part players can see has changed, so their phones refresh.
   addToMap(spec), getLocations() and goToLocation(id) connect a session plan to the map and saved locations. */
export function mountCampaign(root, { room, pin, toast, onShared, addToMap, getLocations, goToLocation }) {
  let doc = null, view = "details", selId = "", loadFailed = false;
  const sviews = new Map();   // per session: showing its plan or its log
  let status = "saved", saving = false, dirty = false, timer = null, lastShared = "";

  root.innerHTML = `
    <div class="camp">
      <header class="camphead">
        <div class="seg mini" role="group" aria-label="Campaign sections">
          <button type="button" data-view="details" aria-pressed="true">Game details</button>
          <button type="button" data-view="sessions" aria-pressed="false">Sessions</button>
        </div>
        <span class="hint">Tick "Share with players" on anything you want them to see.</span>
        <span class="grow"></span>
        <span class="sync" data-status>Saved</span>
        <button class="btn small primary" type="button" data-act="export">Export report</button>
      </header>
      <div class="campbody" data-body></div>
    </div>
    <dialog class="campdlg"></dialog>`;
  const body = root.querySelector("[data-body]");
  const dlg = root.querySelector(".campdlg");

  /* ----- saving ----- */
  const setStatus = (s) => { status = s; root.querySelector("[data-status]").textContent = STATUS[s]; };

  function touch() {
    dirty = true;
    setStatus("saving");
    clearTimeout(timer);
    timer = setTimeout(flush, 800);
  }

  async function flush() {
    if (saving || !dirty) return;
    saving = true; dirty = false;
    let failed = false;
    try {
      const r = await call(`campdoc/${room}`, { method: "PUT", body: { doc }, pin });
      doc.rev = r.rev;
      if (!dirty) setStatus("saved");
      const key = JSON.stringify(sharedView(doc));
      if (key !== lastShared) { lastShared = key; onShared?.(r.rev); }
    } catch (err) {
      failed = true; dirty = true;
      setStatus("error");
    } finally {
      saving = false;
      if (dirty) { clearTimeout(timer); timer = setTimeout(flush, failed ? 2500 : 200); }
    }
  }
  window.addEventListener("beforeunload", (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } });

  /* ----- rendering ----- */
  const sorted = () => [...doc.sessions].sort((a, b) => b.number - a.number);
  const current = () => doc.sessions.find((s) => s.id === selId);

  const fieldHTML = (scope, f, val) => `
    <section class="cfield">
      <header>
        <label for="${scope}-${f.key}">${f.label}</label>
        ${f.share
          ? `<label class="check shr"><input type="checkbox" data-share="${f.key}" ${val.shared ? "checked" : ""}> Share with players</label>`
          : '<span class="hint">Only you see this</span>'}
      </header>
      <textarea id="${scope}-${f.key}" data-f="${f.key}" rows="${rowsFor(val.text)}" maxlength="20000" placeholder="${esc(f.hint)}">${esc(val.text)}</textarea>
    </section>`;

  function renderDetails() {
    body.innerHTML = `
      <div class="cfields">
        <label class="cf"><span>Campaign name</span><input type="text" data-name value="${esc(doc.campaign.name)}" maxlength="80" placeholder="The name of your game"></label>
        <div class="btnrow">
          <button class="btn small" type="button" data-act="shareall">Share every section</button>
          <button class="btn small" type="button" data-act="hideall">Stop sharing everything</button>
        </div>
        ${CAMPAIGN_FIELDS.map((f) => fieldHTML("c", f, doc.campaign.fields[f.key])).join("")}
      </div>`;
  }

  const listLabel = (s) => {
    const c = planCounts(s.plan);
    return `<span class="sn">Session ${s.number}${s.title ? ": " + esc(s.title) : ""}</span><small>${esc(prettyDate(s.date))}${c.beats ? ` · ${c.beatsDone}/${c.beats} beats` : ""}${Object.values(s.fields).some((f) => f.shared && f.text.trim()) ? " · shared" : ""}</small>`;
  };

  /* A new or planned-but-not-yet-played session opens on its plan; one with a log opens on the log. */
  const viewOf = (s) => sviews.get(s.id) || (planHasContent(s.plan) || !Object.values(s.fields).some((f) => f.text.trim()) ? "plan" : "log");

  /* A small question dialog, used by the plan (for example, how many goblins to add to the map). */
  function ask(html, onSubmit) {
    dlg.innerHTML = html;
    dlg.querySelector("[data-close]").onclick = () => dlg.close();
    dlg.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      onSubmit(Object.fromEntries(new FormData(e.target)), () => dlg.close());
    };
    dlg.showModal();
  }

  const planTouch = () => {
    const s = current();
    const btn = s && body.querySelector(`.sitem[data-sid="${s.id}"]`);
    if (btn) btn.innerHTML = listLabel(s);
    touch();
  };

  function renderSessions() {
    const s = current();
    body.innerHTML = `
      <div class="sessions">
        <nav class="slist" aria-label="Sessions">
          <button class="btn primary" type="button" data-act="newsess">New session</button>
          <ul>${sorted().map((x) => `<li><button type="button" class="sitem" data-sid="${x.id}" aria-pressed="${x.id === selId}">${listLabel(x)}</button></li>`).join("")}</ul>
          ${doc.sessions.length ? "" : '<p class="empty">No sessions yet. Add one after your next game.</p>'}
        </nav>
        <div class="sedit">${s ? sessionEditor(s) : '<p class="empty">Choose a session, or add a new one.</p>'}</div>
      </div>`;
    const pc = body.querySelector("[data-plan]");
    if (pc && s) mountPlan(pc, s.plan, { touch: planTouch, toast: (m) => toast?.(m), ask, addToMap, getLocations, goToLocation });
  }

  const sessionEditor = (s) => {
    const v = viewOf(s);
    return `
    <div class="smeta cfields">
      <div class="row">
        <label class="cf" style="flex:0 0 5.5rem"><span>Number</span><input type="number" inputmode="numeric" data-sm="number" value="${s.number}" min="0" max="9999"></label>
        <label class="cf" style="flex:2 1 12rem"><span>Title</span><input type="text" data-sm="title" value="${esc(s.title)}" maxlength="120" placeholder="Session title"></label>
        <label class="cf" style="flex:1 1 9rem"><span>Date</span><input type="date" data-sm="date" value="${esc(s.date)}"></label>
      </div>
      <div class="row" style="align-items:center">
        <div class="seg mini" role="group" aria-label="Plan or log">
          <button type="button" data-sview="plan" aria-pressed="${v === "plan"}">Plan</button>
          <button type="button" data-sview="log" aria-pressed="${v === "log"}">Log</button>
        </div>
        <span class="hint">${v === "plan" ? "Your prep for this session. Players never see it." : "What happened. Tick “Share with players” on anything they can see."}</span>
      </div>
      <div class="btnrow">
        ${v === "log" ? `<button class="btn small" type="button" data-act="sharesess">Share this whole session</button>
        <button class="btn small" type="button" data-act="hidesess">Stop sharing it</button>` : ""}
        <button class="btn small" type="button" data-act="exportsess">Export this session</button>
        <button class="btn small danger" type="button" data-act="delsess">Delete</button>
      </div>
      ${v === "plan" ? '<div class="plan" data-plan></div>' : SESSION_FIELDS.map((f) => fieldHTML("s", f, s.fields[f.key])).join("")}
    </div>`;
  };

  function render() {
    root.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === view));
    if (!doc) {
      body.innerHTML = loadFailed
        ? '<div class="cfields"><p class="empty">Could not load your campaign, so editing is switched off to protect what you saved.</p><button class="btn primary" type="button" data-act="retry">Try again</button></div>'
        : '<p class="empty">Loading…</p>';
      return;
    }
    if (view === "details") renderDetails(); else renderSessions();
  }

  /* ----- editing ----- */
  const scopeFields = () => (view === "details" ? doc.campaign.fields : current()?.fields);

  body.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.name !== undefined) doc.campaign.name = t.value;
    else if (t.dataset.f) { const f = scopeFields(); if (f) f[t.dataset.f].text = t.value; }
    else if (t.dataset.sm) {
      const s = current();
      if (!s) return;
      if (t.dataset.sm === "number") { const n = parseInt(t.value); if (!Number.isFinite(n)) return; s.number = Math.max(0, Math.min(9999, n)); }
      else s[t.dataset.sm] = t.value;
      const btn = body.querySelector(`.sitem[data-sid="${s.id}"]`);
      if (btn) btn.innerHTML = listLabel(s);
    } else return;
    touch();
  });

  body.addEventListener("change", (e) => {
    if (!e.target.dataset.share) return;
    const f = scopeFields();
    if (!f) return;
    f[e.target.dataset.share].shared = e.target.checked;
    const s = view === "sessions" ? current() : null;
    if (s) { const btn = body.querySelector(`.sitem[data-sid="${s.id}"]`); if (btn) btn.innerHTML = listLabel(s); }
    touch();
  });

  const setAllShared = (fields, defs, on) => {
    defs.filter((d) => d.share).forEach((d) => { fields[d.key].shared = on; });
  };

  body.addEventListener("click", (e) => {
    const item = e.target.closest("[data-sid]");
    if (item) { selId = item.dataset.sid; renderSessions(); return; }
    const sv = e.target.closest("[data-sview]");
    if (sv) { const cur = current(); if (cur) { sviews.set(cur.id, sv.dataset.sview); renderSessions(); } return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "retry") { loadFailed = false; render(); load(); return; }
    if (act === "shareall" || act === "hideall") { setAllShared(doc.campaign.fields, CAMPAIGN_FIELDS, act === "shareall"); renderDetails(); touch(); }
    else if (act === "newsess") {
      const next = doc.sessions.reduce((m, s) => Math.max(m, s.number), 0) + 1;
      const s = blankSession(next);
      doc.sessions.push(s);
      selId = s.id;
      renderSessions();
      body.querySelector('[data-sm="title"]')?.focus();
      touch();
    } else if (act === "delsess") {
      const s = current();
      if (!s || !confirm(`Delete Session ${s.number}${s.title ? ": " + s.title : ""}? This can't be undone.`)) return;
      doc.sessions = doc.sessions.filter((x) => x.id !== s.id);
      selId = sorted()[0]?.id || "";
      renderSessions();
      touch();
    } else if (act === "sharesess" || act === "hidesess") {
      const s = current();
      if (!s) return;
      setAllShared(s.fields, SESSION_FIELDS, act === "sharesess");
      renderSessions();
      touch();
    } else if (act === "exportsess") {
      const s = current();
      if (s) exportDialog({ onlySession: s.id });
    }
  });

  root.querySelector(".camphead").addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]");
    if (v) { view = v.dataset.view; if (view === "sessions" && !current()) selId = sorted()[0]?.id || ""; render(); return; }
    if (e.target.closest('[data-act="export"]')) exportDialog({});
  });

  /* ----- export to Word ----- */
  function exportDialog({ onlySession = null }) {
    if (dirty) flush();
    const sessions = sorted();
    dlg.innerHTML = `
      <form>
        <h2>Export a report</h2>
        <fieldset class="optset"><legend>Who is it for?</legend>
          <label class="check"><input type="radio" name="mode" value="full" checked> Full DM report (everything, including your private notes)</label>
          <label class="check"><input type="radio" name="mode" value="players"> Player recap (only what you've shared)</label>
        </fieldset>
        <label class="check"><input type="checkbox" name="camp" ${onlySession ? "" : "checked"}> Include the game details</label>
        <label class="check"><input type="checkbox" name="plan" checked> Include session plans (full DM report only)</label>
        <fieldset class="optset"><legend>Sessions</legend>
          ${sessions.length ? `<div class="btnrow"><button type="button" class="btn small" data-all="1">Select all</button><button type="button" class="btn small" data-all="0">Select none</button></div>
          <div class="sesspick">${sessions.map((s) => `
            <label class="check"><input type="checkbox" name="s" value="${s.id}" ${!onlySession || onlySession === s.id ? "checked" : ""}> Session ${s.number}${s.title ? ": " + esc(s.title) : ""}</label>`).join("")}</div>`
          : '<p class="hint">No sessions yet.</p>'}
        </fieldset>
        <p class="hint">You get a Word file to attach to an email.</p>
        <div class="dlg-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Download .docx</button>
        </div>
      </form>`;
    dlg.querySelector("[data-close]").onclick = () => dlg.close();
    dlg.querySelectorAll("[data-all]").forEach((b) => (b.onclick = () => {
      dlg.querySelectorAll('input[name="s"]').forEach((c) => { c.checked = b.dataset.all === "1"; });
    }));
    dlg.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const ids = f.getAll("s");
      const blocks = buildReport(doc, { mode: f.get("mode"), includeCampaign: f.get("camp") === "on", includePlan: f.get("plan") === "on", sessionIds: ids });
      const base = (doc.campaign.name.trim() || "Campaign").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "Campaign";
      downloadBlob(makeDocx(blocks), `${base}-${f.get("mode") === "players" ? "Player-Recap" : "Report"}-${new Date().toISOString().slice(0, 10)}.docx`);
      dlg.close();
      toast?.("Report downloaded.");
    };
    dlg.showModal();
  }

  /* ----- load ----- */
  async function load() {
    try {
      doc = normalizeDoc((await call(`campdoc/${room}`, { pin })).doc);
      loadFailed = false;
    } catch (err) {
      toast?.("Could not load the campaign: " + err.message);
      doc = null;
      loadFailed = true;
      render();
      return;
    }
    lastShared = JSON.stringify(sharedView(doc));
    selId = sorted()[0]?.id || "";
    render();
  }

  render();
  return { load, loaded: () => !!doc, flushNow: flush };
}
