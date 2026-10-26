import { call, esc, uid, clamp } from "./common.js";
import { compressMap, makeThumb } from "./images.js";

/* Saved locations. Each location remembers its map image, grid settings, fog, and where every token
   stood, so moving the party is "pick a location", not "upload and set everything up again".

   The live table (map, grid, fog, token spots) always lives in the table state. The active location's
   saved copy is refreshed from it a few seconds after anything changes, and again just before leaving. */

const clone = (o) => JSON.parse(JSON.stringify(o));
export const defaultGrid = (w, h) => ({
  on: false, size: Math.max(16, Math.round(Math.max(w, h) / 30)), snap: false, opacity: 0.3, dark: false, ox: 0, oy: 0, areas: [],
});

/* What gets remembered about a location from the live table. */
export function snapshotOf(state) {
  const tokens = {};
  for (const e of state.ents) tokens[e.id] = { x: e.x, y: e.y, hidden: !!e.hidden };
  return { mapRev: state.mapRev, mapW: state.mapW, mapH: state.mapH, grid: clone(state.grid), fog: { on: !!state.fog.on, rev: state.fog.rev }, tokens };
}

/* Put a location's map, grid and fog onto the live table. */
export function applyMap(state, loc) {
  state.locId = loc.id;
  state.locName = loc.name;
  state.mapRev = loc.mapRev;
  state.mapW = loc.mapW;
  state.mapH = loc.mapH;
  state.grid = { ...defaultGrid(loc.mapW, loc.mapH), ...clone(loc.grid) };
  state.fog = { on: !!loc.fog?.on, rev: loc.fog?.rev || 0 };
}

/* Move the tokens: ones that were here before go back where they were; ones brought along arrive near the
   middle; anything else that isn't from here is hidden until the DM places it. */
export function applyTokens(state, loc, bring) {
  const rec = loc.tokens || {};
  const w = state.mapW || 1, h = state.mapH || 1, g = state.grid.size;
  let n = 0;
  for (const e of state.ents) {
    const r = rec[e.id];
    if (r) { e.x = r.x; e.y = r.y; e.hidden = !!r.hidden; }
    else if (bring[e.type]) {
      e.x = clamp(0.5 + (((n % 5) - 2) * g * 1.1) / w, 0, 1);
      e.y = clamp(0.5 + (Math.floor(n / 5) * g * 1.1) / h, 0, 1);
      n++;
    } else { e.hidden = true; e.x = 0.5; e.y = 0.5; }
  }
}

/* ctx: { room, pin, toast, state(), setSync(), changed(), setLocalMap(rev, url), flushFog(), quick (a <select>), images? } */
export function mountLocations(root, ctx) {
  const { room, pin } = ctx;
  const imgs = ctx.images || { compressMap, makeThumb };
  let doc = null, loadFailed = false, timer = null, saving = false, dirty = false;
  const keys = new Map();         // location id -> last saved snapshot (so we only save real changes)
  const localUrls = new Map();    // location id -> { rev, url } for maps just uploaded from this screen
  const S = () => ctx.state();
  const active = () => doc?.locations.find((l) => l.id === S().locId);
  const byId = (id) => doc?.locations.find((l) => l.id === id);

  root.innerHTML = `
    <div class="locs">
      <header class="camphead">
        <button class="btn primary" type="button" data-act="add">Add location</button>
        <span class="hint">Each location remembers its map, grid, fog and where the tokens stand.</span>
        <span class="grow"></span>
        <span class="sync" data-status>Saved</span>
      </header>
      <div class="locbody" data-body></div>
    </div>
    <dialog class="campdlg"></dialog>`;
  const body = root.querySelector("[data-body]");
  const dlg = root.querySelector(".campdlg");
  const status = (t, bad = false) => { const el = root.querySelector("[data-status]"); el.textContent = t; el.classList.toggle("bad", bad); };

  /* ----- saving the list ----- */
  async function saveDoc() {
    if (saving) { dirty = true; return; }
    saving = true; dirty = false;
    status("Saving…");
    try {
      const r = await call(`locs/${room}`, { method: "PUT", body: { doc }, pin });
      doc.rev = r.rev;
      status("Saved");
    } catch (err) {
      status("Not saved", true);
      ctx.toast?.("Could not save your locations: " + err.message);
    } finally {
      saving = false;
      if (dirty) saveDoc();
    }
  }

  /* Copy the live table into the active location's record. Returns true if anything changed. */
  function syncActive() {
    const loc = active();
    if (!loc) return false;
    const snap = snapshotOf(S());
    const key = JSON.stringify(snap);
    if (keys.get(loc.id) === key) return false;
    Object.assign(loc, snap);
    keys.set(loc.id, key);
    return true;
  }

  /* Called whenever the table changes; saves the active location a few seconds later. */
  function touch() {
    if (!doc || !active()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (syncActive()) saveDoc(); }, 3000);
  }

  /* ----- rendering ----- */
  const thumbUrl = (l) => (l.thumbRev ? `/api/thumb/${room}/${l.id}?v=${l.thumbRev}` : "");

  let quickKey = "";
  function renderQuick() {
    const sel = ctx.quick;
    if (!sel) return;
    const cur = S().locId;
    const unsaved = S().mapRev && !cur;
    // Only rebuild when something visible changed, so an open dropdown isn't closed by unrelated updates.
    const key = JSON.stringify([cur, !!unsaved, (doc?.locations || []).map((l) => [l.id, l.name])]);
    if (key === quickKey) return;
    quickKey = key;
    sel.innerHTML = (doc?.locations.length ? "" : '<option value="">No saved locations</option>') +
      (unsaved ? '<option value="">Current map (not saved)</option>' : "") +
      (doc?.locations || []).map((l) => `<option value="${l.id}" ${l.id === cur ? "selected" : ""}>${esc(l.name)}</option>`).join("");
    sel.disabled = !doc || !doc.locations.length;
  }

  function render() {
    renderQuick();
    if (!doc) {
      body.innerHTML = loadFailed
        ? '<div class="cfields"><p class="empty">Could not load your locations, so changes are switched off to protect what you saved.</p><button class="btn primary" type="button" data-act="retry">Try again</button></div>'
        : '<p class="empty">Loading…</p>';
      return;
    }
    const st = S();
    const legacy = st.mapRev && !st.locId;
    body.innerHTML = `
      ${legacy ? `<div class="locnote"><span>The map on the table right now isn't saved as a location.</span>
        <button class="btn small primary" type="button" data-act="savecurrent">Save it as a location</button></div>` : ""}
      ${doc.locations.length ? `<ul class="locgrid">${doc.locations.map((l) => card(l, l.id === st.locId)).join("")}</ul>`
        : '<p class="empty">No locations yet. Add one with a map image, then switch between them any time.</p>'}`;
  }

  const card = (l, isActive) => `
    <li class="loccard ${isActive ? "on" : ""}" data-id="${l.id}">
      <div class="locthumb">${l.thumbRev ? `<img src="${thumbUrl(l)}" alt="" loading="lazy">` : '<span class="hint">No preview</span>'}
        ${isActive ? '<span class="badge">Showing now</span>' : ""}</div>
      <div class="locinfo">
        <h3>${esc(l.name)}</h3>
        ${l.notes ? `<p>${esc(l.notes.length > 110 ? l.notes.slice(0, 110) + "…" : l.notes)}</p>` : ""}
      </div>
      <div class="locact">
        <button class="btn small primary" type="button" data-act="load" ${isActive ? "disabled" : ""}>${isActive ? "Current" : "Go here"}</button>
        <button class="btn small" type="button" data-act="edit">Edit</button>
      </div>
    </li>`;

  /* ----- uploading maps ----- */
  async function uploadFiles(id, file) {
    const { blob, w, h } = await imgs.compressMap(file);
    const thumb = await imgs.makeThumb(blob);
    await call(`map/${room}/${id}`, { method: "PUT", body: blob, pin });
    await call(`thumb/${room}/${id}`, { method: "PUT", body: thumb, pin });
    const rev = Date.now();
    localUrls.set(id, { rev, url: URL.createObjectURL(blob) });
    return { rev, w, h };
  }

  async function createLocation({ name, notes, file }) {
    ctx.setSync("Uploading map…");
    try {
      const id = uid();
      const { rev, w, h } = await uploadFiles(id, file);
      const loc = { id, name, notes, mapRev: rev, mapW: w, mapH: h, thumbRev: rev, grid: defaultGrid(w, h), fog: { on: false, rev: 0 }, tokens: {} };
      doc.locations.push(loc);
      keys.set(id, JSON.stringify(snapshotOf({ ...S(), ...{ mapRev: rev, mapW: w, mapH: h, grid: loc.grid, fog: loc.fog, ents: [] } })));
      await saveDoc();
      render();
      ctx.setSync("Saved");
      return loc;
    } catch (err) {
      ctx.setSync("Saved");
      ctx.toast?.(err.message || "Could not upload the map.");
      return null;
    }
  }

  async function replaceMap(id, file) {
    const loc = byId(id);
    ctx.setSync("Uploading map…");
    try {
      const { rev, w, h } = await uploadFiles(id, file);
      Object.assign(loc, { mapRev: rev, mapW: w, mapH: h, thumbRev: rev, fog: { on: loc.fog.on, rev: 0 } });
      loc.grid = { ...loc.grid, size: defaultGrid(w, h).size, areas: [] };
      if (S().locId === id) {
        applyMap(S(), loc);
        ctx.setLocalMap(rev, localUrls.get(id).url);
        keys.delete(id);
        ctx.changed();
      }
      await saveDoc();
      render();
      ctx.setSync("Saved");
      ctx.toast?.("Map replaced. The grid size was reset and the fog was cleared for the new image.");
    } catch (err) {
      ctx.setSync("Saved");
      ctx.toast?.(err.message || "Could not upload the map.");
    }
  }

  /* The "Upload map" button on the Map tab: replaces the active location's map, or starts a new location. */
  async function uploadMap(file) {
    if (!doc) { ctx.toast?.("Locations are still loading. Try again in a moment."); return; }
    const cur = active();
    if (cur) return replaceMap(cur.id, file);
    const name = (file.name || "Map").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Map";
    const loc = await createLocation({ name, notes: "", file });
    if (loc) { adopt(loc); ctx.toast?.(`Saved as the location "${loc.name}". Turn on “Map visible to players” when you're ready.`); }
  }

  /* Make a location the table's map without moving any tokens (used for the very first map). */
  function adopt(loc) {
    applyMap(S(), loc);
    if (localUrls.get(loc.id)) ctx.setLocalMap(loc.mapRev, localUrls.get(loc.id).url);
    keys.set(loc.id, JSON.stringify(snapshotOf(S())));
    ctx.changed();
    render();
  }

  /* ----- switching ----- */
  async function switchTo(id, { bring, hideMap }) {
    const target = byId(id);
    if (!target || S().locId === id) return;
    await ctx.flushFog?.();
    clearTimeout(timer);
    const leaving = active();
    if (leaving) syncActive();
    const st = S();
    applyMap(st, target);
    applyTokens(st, target, bring);
    if (hideMap) st.mapOn = false;
    const local = localUrls.get(id);
    if (local && local.rev === target.mapRev) ctx.setLocalMap(local.rev, local.url);
    keys.set(id, JSON.stringify(snapshotOf(st)));
    ctx.changed();
    render();
    await saveDoc();
    ctx.toast?.(hideMap ? `Now at ${target.name}. The map is hidden from players until you turn it back on.` : `Now at ${target.name}.`);
  }

  /* ----- dialogs ----- */
  function openDlg(html, onSubmit, onMount) {
    dlg.innerHTML = html;
    const f = dlg.querySelector("form");
    f.addEventListener("submit", (e) => { e.preventDefault(); onSubmit(new FormData(f)); });
    dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
    onMount?.(dlg);
    dlg.showModal();
  }

  function switchDialog(id) {
    const target = byId(id);
    if (!target) return;
    const here = active();
    openDlg(`
      <form>
        <h2>Go to ${esc(target.name)}</h2>
        <p class="hint" style="margin:0 0 .6rem">${here ? `You're leaving ${esc(here.name)}. Its tokens, grid and fog are remembered.` : "Players see the new map as soon as you go."}</p>
        <fieldset class="optset"><legend>Bring these tokens along</legend>
          <label class="check"><input type="checkbox" name="pc" checked> Player characters</label>
          <label class="check"><input type="checkbox" name="npc"> NPCs</label>
          <label class="check"><input type="checkbox" name="enemy"> Enemies</label>
        </fieldset>
        <p class="hint" style="margin:0 0 .6rem">Tokens that were at ${esc(target.name)} before go back to where you left them. Others that aren't brought along are hidden there.</p>
        <label class="check" style="margin-bottom:.4rem"><input type="checkbox" name="hide"> Hide the map from players until I turn it back on</label>
        <div class="dlg-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Go there</button>
        </div>
      </form>`,
      (f) => {
        dlg.close();
        switchTo(id, { bring: { pc: f.get("pc") === "on", npc: f.get("npc") === "on", enemy: f.get("enemy") === "on" }, hideMap: f.get("hide") === "on" });
      });
  }

  function addDialog() {
    openDlg(`
      <form>
        <h2>Add a location</h2>
        <label class="cf" style="margin-bottom:.7rem"><span>Name</span><input type="text" name="name" maxlength="80" placeholder="The Rusty Anchor" required autofocus></label>
        <label class="cf" style="margin-bottom:.7rem"><span>Map image</span><input type="file" name="file" accept="image/*" required></label>
        <label class="cf" style="margin-bottom:.7rem"><span>Notes (optional)</span><textarea name="notes" rows="3" maxlength="1500" placeholder="What's here, secrets, who to meet"></textarea></label>
        <label class="check"><input type="checkbox" name="go" checked> Go there when it's saved</label>
        <div class="dlg-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save location</button>
        </div>
      </form>`,
      async (f) => {
        dlg.close();
        const file = f.get("file");
        if (!(file instanceof File) || !file.size) return;
        const loc = await createLocation({ name: String(f.get("name")).trim() || "Untitled", notes: String(f.get("notes") || ""), file });
        if (loc && f.get("go") === "on") {
          if (S().mapRev || S().locId) switchDialog(loc.id); else adopt(loc);
        }
      });
  }

  function editDialog(id) {
    const loc = byId(id);
    if (!loc) return;
    openDlg(`
      <form>
        <h2>Edit location</h2>
        <label class="cf" style="margin-bottom:.7rem"><span>Name</span><input type="text" name="name" maxlength="80" value="${esc(loc.name)}" required></label>
        <label class="cf" style="margin-bottom:.7rem"><span>Notes</span><textarea name="notes" rows="3" maxlength="1500">${esc(loc.notes)}</textarea></label>
        <label class="cf" style="margin-bottom:.4rem"><span>Replace the map image (resets the grid size and clears the fog)</span><input type="file" name="file" accept="image/*"></label>
        <div class="dlg-actions">
          <button type="button" class="btn danger push" data-delete>Delete</button>
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`,
      async (f) => {
        dlg.close();
        loc.name = String(f.get("name")).trim() || loc.name;
        loc.notes = String(f.get("notes") || "");
        if (S().locId === id) { S().locName = loc.name; ctx.changed(); }
        const file = f.get("file");
        if (file instanceof File && file.size) await replaceMap(id, file);
        else { await saveDoc(); render(); }
      },
      (root) => root.querySelector("[data-delete]").addEventListener("click", () => {
        const isActive = S().locId === id;
        if (!confirm(isActive ? `"${loc.name}" is the map players see right now. Delete it anyway?` : `Delete "${loc.name}"? Its map, grid and fog are removed.`)) return;
        dlg.close();
        deleteLocation(id);
      }));
  }

  async function deleteLocation(id) {
    const loc = byId(id);
    if (!loc) return;
    doc.locations = doc.locations.filter((l) => l.id !== id);
    keys.delete(id);
    if (S().locId === id) {
      const st = S();
      Object.assign(st, { locId: "", locName: "", mapRev: 0, mapW: 0, mapH: 0 });
      st.fog = { on: false, rev: 0 };
      st.grid = { ...defaultGrid(0, 0), size: 60 };
      ctx.changed();
    }
    for (const kind of ["map", "fog", "thumb"]) call(`${kind}/${room}/${id}`, { method: "DELETE", pin }).catch(() => {});
    await saveDoc();
    render();
  }

  /* The table had a map from before locations existed: copy it into a saved location. */
  async function saveCurrent() {
    const st = S();
    ctx.setSync("Saving the map as a location…");
    try {
      const id = uid();
      const mapBlob = await (await fetch(`/api/map/${room}?v=${st.mapRev}`)).blob();
      const thumb = await imgs.makeThumb(mapBlob);
      await call(`map/${room}/${id}`, { method: "PUT", body: mapBlob, pin });
      await call(`thumb/${room}/${id}`, { method: "PUT", body: thumb, pin });
      let fogRev = 0;
      if (st.fog.rev) {
        const fogBlob = await (await fetch(`/api/fog/${room}?v=${st.fog.rev}`)).blob();
        await call(`fog/${room}/${id}`, { method: "PUT", body: fogBlob, pin });
        fogRev = Date.now();
      }
      const rev = Date.now();
      const loc = { id, name: "Main map", notes: "", ...snapshotOf(st), mapRev: rev, thumbRev: rev, fog: { on: !!st.fog.on, rev: fogRev } };
      doc.locations.push(loc);
      applyMap(st, loc);
      keys.set(id, JSON.stringify(snapshotOf(st)));
      ctx.changed();
      await saveDoc();
      render();
      ctx.setSync("Saved");
      ctx.toast?.('Saved as "Main map". You can rename it with Edit.');
    } catch (err) {
      ctx.setSync("Saved");
      ctx.toast?.("Could not save the current map: " + err.message);
    }
  }

  /* ----- events ----- */
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.closest("[data-id]")?.dataset.id;
    const act = b.dataset.act;
    if (act === "retry") { loadFailed = false; render(); load(); }
    else if (!doc) return;
    else if (act === "add") addDialog();
    else if (act === "load" && id) switchDialog(id);
    else if (act === "edit" && id) editDialog(id);
    else if (act === "savecurrent") saveCurrent();
  });

  if (ctx.quick) {
    ctx.quick.addEventListener("change", () => {
      const id = ctx.quick.value;
      renderQuick();                         // snap the dropdown back until they confirm
      if (id && id !== S().locId) switchDialog(id);
    });
  }

  async function load() {
    try {
      doc = (await call(`locs/${room}`, { pin })).doc;
      loadFailed = false;
      for (const l of doc.locations) keys.set(l.id, JSON.stringify({ mapRev: l.mapRev, mapW: l.mapW, mapH: l.mapH, grid: l.grid, fog: l.fog, tokens: l.tokens }));
    } catch (err) {
      doc = null; loadFailed = true;
      ctx.toast?.("Could not load your locations: " + err.message);
    }
    render();
  }

  render();
  return { load, touch, uploadMap, render, refreshQuick: renderQuick, active, createLocation, switchTo, deleteLocation, saveCurrent, flush: async () => { if (syncActive()) await saveDoc(); } };
}
