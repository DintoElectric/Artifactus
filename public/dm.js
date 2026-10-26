import { call, uid, esc, clamp, TYPES, MapView } from "./common.js";
import { mountRoller } from "./dice.js";
import { SheetStore, mountBook, mountNotes, blankSheet } from "./sheet.js";

const $ = (s, r = document) => r.querySelector(s);
const saved = JSON.parse(localStorage.getItem("dmTable") || "null");
if (!saved) { location.replace("/"); throw new Error("No table"); }
const { room, pin } = saved;

let state = null;
let tab = "map";
let selId = null;
let localMap = null;
let newType = "pc";
const localImgs = new Map();
let mode = "none", paintTool = "reveal";   // map tool: none | fog | align | shape
let shareDm = localStorage.getItem("shareDm:" + room) === "1";

/* ---------- map ---------- */
const mv = new MapView($("#stage"), {
  interactive: true,
  emptyText: "Upload a map to get started.",
  onMove(id, x, y) {
    const e = ent(id);
    if (!e) return;
    e.x = x; e.y = y;
    bump(); scheduleSave(300);
  },
  onMoveEnd(id, x, y) {
    const e = ent(id);
    if (!e) return;
    e.x = x; e.y = y;
    bump(); scheduleSave(300);
  },
  onSelect(id) { select(id); },
  onEdit(id) { editToken(id); },
  onFogStroke() { scheduleFogUpload(); },
  onGridMove() { gridChanged(); },
  onShapeChange() { gridChanged(); updateShapeButtons(); },
  onDraftChange() { updateShapeButtons(); },
  imgUrl(e) {
    if (!e.img) return null;
    const l = localImgs.get(e.id);
    return l && l.rev === e.img ? l.url : `/api/img/${room}/${e.id}?v=${e.img}`;
  },
});

const ent = (id) => state.ents.find((e) => e.id === id);

/* ---------- saving ---------- */
let timer = null, saving = false, dirty = false;
const bump = () => { state.rev = (state.rev || 0) + 1; dirty = true; };

function setSync(text, bad = false) {
  const s = $("#sync");
  s.textContent = text;
  s.classList.toggle("bad", bad);
}

function scheduleSave(delay = 250) {
  dirty = true;
  if (timer) return;
  setSync("Saving…");
  timer = setTimeout(() => { timer = null; flush(); }, delay);
}

async function flush() {
  if (saving || !dirty) return;
  saving = true; dirty = false;
  let failed = false;
  try {
    await call(`state/${room}`, { method: "PUT", body: state, pin });
    if (!dirty) setSync("Saved");
  } catch (err) {
    failed = true; dirty = true;
    setSync(err.status === 401 ? "Wrong PIN" : "Offline, retrying…", true);
  } finally {
    saving = false;
    if (dirty && !timer) scheduleSave(failed ? 2500 : 60);
  }
}

window.addEventListener("beforeunload", (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } });

function changed() {
  bump();
  renderMap();
  renderSide();
  if (tab === "inv") renderInv();
  if (tab === "party") renderParty();
  if (tab === "obj") renderObjectives();
  scheduleSave();
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* ---------- dialogs ---------- */
const dlg = $("#dlg");
function openDlg(html, onSubmit, onMount) {
  dlg.innerHTML = html;
  const f = dlg.querySelector("form");
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    onSubmit(data, e.submitter?.value);
  });
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
  onMount?.(dlg);
  dlg.showModal();
}

/* ---------- map panel ---------- */
function mapSrc() {
  if (!state.mapRev) return null;
  return localMap?.rev === state.mapRev ? localMap.url : `/api/map/${room}?v=${state.mapRev}`;
}

function renderMap() {
  mv.setMap(state.mapRev, mapSrc());
  mv.update({
    ents: state.ents,
    grid: state.grid,
    turnId: state.init.on ? state.init.turnId : null,
    selId,
  });
  mv.setFog(state.fog.on, state.fog.rev, state.fog.rev ? `/api/fog/${room}?v=${state.fog.rev}` : null);
  $("#fogOn").checked = !!state.fog.on;
  $("#fogCtl").hidden = !state.fog.on;
  syncPaint();
  $("#gridOn").checked = !!state.grid.on;
  $("#gridBar").hidden = !state.grid.on;
  $("#gridOpacity").value = Math.round((state.grid.opacity ?? 0.3) * 100);
  $("#gridDark").checked = !!state.grid.dark;
  $("#snapOn").checked = !!state.grid.snap;
  $("#mapOn").checked = !!state.mapOn;
  const sz = $("#gridSize");
  sz.max = Math.max(40, Math.round(Math.max(state.mapW, state.mapH) / 6));
  sz.value = state.grid.size;
}

async function compress(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  let q = 0.86;
  for (let i = 0; i < 7; i++) {
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= 3.4 * 1024 * 1024) return { blob, w, h };
    q = Math.max(0.6, q - 0.08);
    scale *= 0.85;
  }
  throw new Error("That map is too large even after shrinking. Try a smaller image.");
}

$("#upload").onclick = () => $("#file").click();
$("#file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  setSync("Uploading map…");
  try {
    const { blob, w, h } = await compress(f);
    await call(`map/${room}`, { method: "PUT", body: blob, pin });
    const rev = Date.now();
    localMap = { rev, url: URL.createObjectURL(blob) };
    state.mapRev = rev; state.mapW = w; state.mapH = h;
    state.grid.size = Math.round(Math.max(w, h) / 30);
    state.fog.rev = 0;
    changed();
    toast("Map uploaded. Turn on “Map visible to players” when you're ready to show it.");
  } catch (err) {
    setSync("Saved");
    toast(err.message || "Could not upload the map.");
  } finally {
    e.target.value = "";
  }
});
$("#fit").onclick = () => mv.fit();
$("#mapOn").onchange = (e) => { state.mapOn = e.target.checked; changed(); };
$("#gridOn").onchange = (e) => { state.grid.on = e.target.checked; changed(); };
$("#snapOn").onchange = (e) => { state.grid.snap = e.target.checked; bump(); scheduleSave(); renderMap(); };
function gridChanged() {
  bump(); scheduleSave(300);
  mv.update({ grid: state.grid, ents: state.ents, turnId: state.init.on ? state.init.turnId : null, selId });
}
$("#gridSize").addEventListener("input", (e) => { state.grid.size = Number(e.target.value); gridChanged(); });
$("#gridOpacity").addEventListener("input", (e) => { state.grid.opacity = Number(e.target.value) / 100; gridChanged(); });
$("#gridDark").onchange = (e) => { state.grid.dark = e.target.checked; gridChanged(); };
$("#resetGridPos").onclick = () => { state.grid.ox = 0; state.grid.oy = 0; gridChanged(); };
$("#gridBar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nudge]");
  if (!b) return;
  const [dx, dy] = b.dataset.nudge.split(",").map(Number);
  const g = state.grid.size;
  state.grid.ox = ((((state.grid.ox || 0) + dx * 2) % g) + g) % g;
  state.grid.oy = ((((state.grid.oy || 0) + dy * 2) % g) + g) % g;
  gridChanged();
});
$("#alignBtn").onclick = () => setMode("align");
$("#shapeBtn").onclick = () => setMode("shape");
$("#closeShape").onclick = () => { if (!mv.closeShape()) toast("Place at least 3 corners first."); };
$("#undoPoint").onclick = () => mv.undoPoint();
$("#clearShapes").onclick = () => {
  if (!(state.grid.areas || []).length && !mv.draft.length) return;
  if (confirm("Remove all grid shapes? The grid will cover the whole map again.")) mv.clearShapes();
};

/* ---------- map tools: only one at a time (fog, move grid, shape grid) ---------- */
const HINTS = {
  fog: "Drag on the map to paint. Turn off Paint fog to move tokens or pan.",
  align: "Drag the map to slide the grid under it, or use the arrows to fine-tune.",
  shape: "Click to place corners, then Close shape. Drag a corner to adjust it, double-click to delete it. The grid only shows inside shapes.",
};
function setMode(m) { mode = mode === m ? "none" : m; syncPaint(); }
function updateShapeButtons() {
  $("#closeShape").disabled = mv.draft.length < 3;
  $("#undoPoint").disabled = !mv.draft.length;
  $("#clearShapes").disabled = !mv.draft.length && !(state.grid.areas || []).length;
}
function syncPaint() {
  if (!state.fog.on && mode === "fog") mode = "none";
  if (!state.grid.on && (mode === "align" || mode === "shape")) mode = "none";
  mv.paintMode = mode === "fog" ? paintTool : null;
  mv.moveGrid = mode === "align";
  mv.shapeMode = mode === "shape";
  mv.brush = Number($("#brush").value) / 100;
  mv.renderShapes();
  mv.root.classList.toggle("paint", mode === "fog");
  mv.root.classList.toggle("aim", mode === "align" || mode === "shape");
  $("#paintBtn").setAttribute("aria-pressed", mode === "fog");
  $("#alignBtn").setAttribute("aria-pressed", mode === "align");
  $("#shapeBtn").setAttribute("aria-pressed", mode === "shape");
  $("#shapeCtl").hidden = mode !== "shape";
  const hint = $("#gridHint");
  hint.hidden = mode !== "align" && mode !== "shape";
  hint.textContent = HINTS[mode] || "";
  $("#paintHint").hidden = mode !== "fog";
  $("#fogReveal").setAttribute("aria-pressed", paintTool === "reveal");
  $("#fogHide").setAttribute("aria-pressed", paintTool === "hide");
  updateShapeButtons();
}

/* ---------- fog of war ---------- */
let fogTimer = null;
function scheduleFogUpload() {
  setSync("Saving fog…");
  clearTimeout(fogTimer);
  fogTimer = setTimeout(uploadFog, 450);
}
async function uploadFog() {
  try {
    const blob = await mv.exportFog();
    await call(`fog/${room}`, { method: "PUT", body: blob, pin });
    const rev = Date.now();
    mv.markFogKey(rev);
    state.fog.rev = rev;
    changed();
  } catch (err) {
    setSync("Fog not saved", true);
    toast("Could not save the fog: " + err.message);
  }
}

$("#fogOn").onchange = (e) => { state.fog.on = e.target.checked; changed(); };
$("#paintBtn").onclick = () => setMode("fog");
$("#fogReveal").onclick = () => { paintTool = "reveal"; syncPaint(); };
$("#fogHide").onclick = () => { paintTool = "hide"; syncPaint(); };
$("#brush").addEventListener("input", syncPaint);
$("#revealAll").onclick = () => { mv.fogFill(true); scheduleFogUpload(); };
$("#hideAll").onclick = () => {
  if (!confirm("Hide the whole map again?")) return;
  mv.fogFill(false);
  scheduleFogUpload();
};
$("#revealPcs").onclick = () => {
  if (!state.mapW) return;
  const r = (state.grid.size * 3) / state.mapW;
  const pcs = state.ents.filter((e) => e.type === "pc");
  if (!pcs.length) { toast("Add a player token first."); return; }
  pcs.forEach((e) => mv.paint(e.x, e.y, e.x, e.y, r, true));
  scheduleFogUpload();
};

/* ---------- tabs ---------- */
const TABS = { map: ["tabMap", "paneMap"], inv: ["tabInv", "paneInv"], party: ["tabParty", "paneParty"], obj: ["tabObj", "paneObj"] };
function setTab(t) {
  tab = t;
  for (const [k, [btn, pane]] of Object.entries(TABS)) {
    $("#" + btn).setAttribute("aria-selected", k === t);
    $("#" + pane).hidden = k !== t;
  }
  if (t === "inv") renderInv();
  if (t === "party") { renderParty(); pullSheets(); }
  if (t === "obj") renderObjectives();
}
for (const [k, [btn]] of Object.entries(TABS)) $("#" + btn).onclick = () => setTab(k);

/* ---------- tokens ---------- */
$("#typeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-type]");
  if (!b) return;
  newType = b.dataset.type;
  $("#typeSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
});

$("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#tokName").value.trim();
  const count = clamp(parseInt($("#tokCount2").value) || 1, 1, 20);
  if (!name) { toast("Give the token a name."); return; }
  addTokens(name, newType, count);
  $("#tokName").value = "";
  $("#tokCount2").value = 1;
});

function addTokens(name, type, count) {
  const c = mv.centerPoint() || { x: 0.5, y: 0.5 };
  const w = state.mapW || 1, h = state.mapH || 1, g = state.grid.size;
  for (let i = 0; i < count; i++) {
    const ox = count > 1 ? (i % 4) - 1.5 : 0;
    const e = {
      id: uid(),
      name: count > 1 ? `${name} ${i + 1}` : name,
      type,
      x: clamp(c.x + (ox * g * 1.1) / w, 0, 1),
      y: clamp(c.y + (Math.floor(i / 4) * g * 1.1) / h, 0, 1),
      size: 1, hp: null, maxHp: null, hidden: false, down: false,
    };
    state.ents.push(e);
    if (type === "pc") state.inv[e.id] = [];
  }
  if (!state.mapRev) toast("Tokens will show up once you upload a map.");
  changed();
}

function select(id) {
  selId = id;
  renderMap();
  renderTokens();
  $(`#tokList [data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

function editToken(id) {
  const e = ent(id);
  if (!e) return;
  const sizes = [[0.5, "Tiny (half square)"], [1, "Medium (1 square)"], [2, "Large (2 squares)"], [3, "Huge (3 squares)"], [4, "Gargantuan (4 squares)"]];
  openDlg(`
    <form>
      <h2>Edit token</h2>
      <div class="field"><label for="f_name">Name</label><input id="f_name" name="name" type="text" value="${esc(e.name)}" maxlength="40" required></div>
      <div class="field"><label for="f_type">Type</label><select id="f_type" name="type">
        ${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${e.type === k ? "selected" : ""}>${v.label}</option>`).join("")}</select></div>
      <div class="field"><label for="f_size">Size</label><select id="f_size" name="size">
        ${sizes.map(([v, l]) => `<option value="${v}" ${(e.size || 1) === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="row">
        <div class="field"><label for="f_hp">HP</label><input id="f_hp" name="hp" type="number" value="${e.hp ?? ""}"></div>
        <div class="field"><label for="f_mhp">Max HP</label><input id="f_mhp" name="maxHp" type="number" value="${e.maxHp ?? ""}"></div>
      </div>
      <div class="field"><label for="f_img">Token image</label><input id="f_img" name="image" type="file" accept="image/*"></div>
      ${e.img ? '<label class="check field"><input type="checkbox" name="rmimg"> Remove current image</label>' : ""}
      <label class="check field"><input type="checkbox" name="hidden" ${e.hidden ? "checked" : ""}> Hidden from players</label>
      <label class="check field"><input type="checkbox" name="down" ${e.down ? "checked" : ""}> Down / dead</label>
      <div class="dlg-actions">
        <button type="button" class="btn danger push" data-delete>Delete token</button>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`,
    (d) => {
      const wasPc = e.type === "pc";
      e.name = d.name.trim() || e.name;
      e.type = d.type;
      e.size = Number(d.size) || 1;
      e.hp = d.hp === "" ? null : Number(d.hp);
      e.maxHp = d.maxHp === "" ? null : Number(d.maxHp);
      e.hidden = d.hidden === "on";
      e.down = d.down === "on";
      if (e.type === "pc" && !state.inv[e.id]) state.inv[e.id] = [];
      if (wasPc && e.type !== "pc") returnItemsToStash(e.id);
      const file = d.image instanceof File && d.image.size > 0 ? d.image : null;
      if (d.rmimg === "on" && !file) removeTokenImage(e);
      dlg.close();
      changed();
      if (file) uploadTokenImage(e, file);
    },
    (root) => root.querySelector("[data-delete]").addEventListener("click", () => {
      if (!confirm(`Delete ${e.name}?`)) return;
      deleteToken(e.id);
      dlg.close();
    }));
}

async function squareImage(file, size = 192) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#20283a";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
}

async function uploadTokenImage(e, file) {
  setSync("Uploading image…");
  try {
    const blob = await squareImage(file);
    await call(`img/${room}/${e.id}`, { method: "PUT", body: blob, pin });
    const rev = Date.now();
    localImgs.set(e.id, { rev, url: URL.createObjectURL(blob) });
    e.img = rev;
    changed();
  } catch (err) {
    setSync("Saved");
    toast("Could not upload the image: " + (err.message || "unknown error"));
  }
}

function removeTokenImage(e) {
  e.img = null;
  localImgs.delete(e.id);
  call(`img/${room}/${e.id}`, { method: "DELETE", pin }).catch(() => {});
}

function returnItemsToStash(id) {
  const items = state.inv[id] || [];
  state.inv.stash = (state.inv.stash || []).concat(items);
  delete state.inv[id];
}

function deleteToken(id) {
  const gone = ent(id);
  if (gone?.img) removeTokenImage(gone);
  returnItemsToStash(id);
  state.ents = state.ents.filter((e) => e.id !== id);
  removeFromInit(id, false);
  if (selId === id) selId = null;
  changed();
}

function hpDialog(id) {
  const e = ent(id);
  if (!e) return;
  openDlg(`
    <form>
      <h2>${esc(e.name)}: HP ${e.hp ?? "?"}${e.maxHp != null ? " / " + e.maxHp : ""}</h2>
      <div class="field"><label for="h_amt">Amount</label><input id="h_amt" name="amt" type="number" min="0" inputmode="numeric" autofocus></div>
      <div class="dlg-actions" style="justify-content:flex-start;margin-top:0">
        <button type="submit" value="dmg" class="btn danger">Damage</button>
        <button type="submit" value="heal" class="btn">Heal</button>
      </div>
      <h3 style="margin-top:1.2rem">Set directly</h3>
      <div class="row" style="margin-top:.5rem">
        <div class="field"><label for="h_hp">HP</label><input id="h_hp" name="hp" type="number" value="${e.hp ?? ""}"></div>
        <div class="field"><label for="h_mhp">Max HP</label><input id="h_mhp" name="maxHp" type="number" value="${e.maxHp ?? ""}"></div>
      </div>
      <div class="dlg-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" value="set" class="btn primary">Set HP</button>
      </div>
    </form>`,
    (d, act) => {
      const amt = Math.abs(Number(d.amt) || 0);
      if (act === "set") {
        e.hp = d.hp === "" ? null : Number(d.hp);
        e.maxHp = d.maxHp === "" ? null : Number(d.maxHp);
      } else if (amt) {
        const base = e.hp ?? e.maxHp ?? 0;
        e.hp = act === "dmg" ? Math.max(0, base - amt) : e.maxHp != null ? Math.min(e.maxHp, base + amt) : base + amt;
      }
      dlg.close();
      changed();
    });
}

/* ---------- initiative ---------- */
const hpText = (e) => (e.hp != null ? `${e.hp}${e.maxHp != null ? "/" + e.maxHp : ""}` : "HP");

function renderInit() {
  const I = state.init;
  const byId = new Map(state.ents.map((e) => [e.id, e]));
  $("#roundLbl").textContent = I.on ? `Round ${I.round}` : "Not started";
  $("#startBtn").textContent = I.on ? "End combat" : "Start combat";
  const rows = I.list.map((it) => {
    const e = byId.get(it.id);
    if (!e) return "";
    return `<li class="irow ${I.on && I.turnId === it.id ? "turn" : ""} ${e.down ? "down" : ""}" data-id="${e.id}">
      <span class="dot" style="--c:${TYPES[e.type].color}"></span>
      <button class="iname" data-act="edit" title="Edit token">${esc(e.name)}${e.hidden ? " (hidden)" : ""}</button>
      <button class="ihp" data-act="hp" title="Damage or heal">${hpText(e)}</button>
      <input class="iinit" type="number" inputmode="numeric" data-act="init" value="${it.init ?? ""}" aria-label="Initiative for ${esc(e.name)}">
      <button class="x" data-act="uninit" aria-label="Remove ${esc(e.name)} from initiative">×</button>
    </li>`;
  }).join("");
  $("#initList").innerHTML = rows || '<li class="empty">Use “Init” on a token below, or “Add everyone”.</li>';
}

$("#initList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  const row = e.target.closest(".irow");
  if (!b || !row) return;
  const id = row.dataset.id;
  if (b.dataset.act === "edit") editToken(id);
  else if (b.dataset.act === "hp") hpDialog(id);
  else if (b.dataset.act === "uninit") { removeFromInit(id, true); }
});
$("#initList").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "init") return;
  const id = e.target.closest(".irow").dataset.id;
  const it = state.init.list.find((x) => x.id === id);
  if (!it) return;
  it.init = e.target.value === "" ? null : Number(e.target.value);
  bump(); scheduleSave();
});

function addToInit(id) {
  if (!state.init.list.some((i) => i.id === id)) state.init.list.push({ id, init: null });
}
function removeFromInit(id, render) {
  const I = state.init;
  const idx = I.list.findIndex((i) => i.id === id);
  if (idx < 0) return;
  if (I.turnId === id) {
    const nxt = I.list[idx + 1] || I.list[0];
    I.turnId = nxt && nxt.id !== id ? nxt.id : null;
  }
  I.list.splice(idx, 1);
  if (!I.list.length) I.on = false;
  if (render) changed();
}
const sortInit = () => state.init.list.sort((a, b) => (b.init ?? -Infinity) - (a.init ?? -Infinity));

$("#sortBtn").onclick = () => { sortInit(); changed(); };
$("#rollBtn").onclick = () => {
  let n = 0;
  for (const it of state.init.list) {
    const e = ent(it.id);
    if (e && e.type !== "pc" && it.init == null) { it.init = 1 + Math.floor(Math.random() * 20); n++; }
  }
  if (!n) toast("Nobody to roll for. Players enter their own numbers.");
  sortInit();
  changed();
};
$("#addAllBtn").onclick = () => { state.ents.forEach((e) => addToInit(e.id)); changed(); };
$("#startBtn").onclick = () => {
  const I = state.init;
  if (I.on) { I.on = false; I.turnId = null; }
  else {
    if (!I.list.length) { toast("Add some tokens to initiative first."); return; }
    sortInit();
    I.on = true; I.round = 1; I.turnId = I.list[0].id;
  }
  changed();
};
function step(dir) {
  const I = state.init;
  if (!I.on || !I.list.length) return;
  let idx = I.list.findIndex((i) => i.id === I.turnId);
  if (idx < 0) idx = dir > 0 ? -1 : 0;
  for (let tries = 0; tries < I.list.length; tries++) {
    idx += dir;
    if (idx >= I.list.length) { idx = 0; I.round++; }
    if (idx < 0) { idx = I.list.length - 1; I.round = Math.max(1, I.round - 1); }
    const e = ent(I.list[idx].id);
    if (e && !e.down) break;
  }
  I.turnId = I.list[idx].id;
  changed();
}
$("#nextBtn").onclick = () => step(1);
$("#prevBtn").onclick = () => step(-1);

/* ---------- token list ---------- */
function renderTokens() {
  $("#tokCount").textContent = `${state.ents.length} on the map`;
  $("#tokList").innerHTML = state.ents.map((e) => {
    const inInit = state.init.list.some((i) => i.id === e.id);
    return `<li class="trow ${selId === e.id ? "sel" : ""} ${e.down ? "down" : ""}" data-id="${e.id}">
      <span class="dot" style="--c:${TYPES[e.type].color}"></span>
      <button class="tname" data-act="focus">${esc(e.name)}</button>
      <button class="btn small ghost" data-act="vis" aria-pressed="${!!e.hidden}">${e.hidden ? "Hidden" : "Visible"}</button>
      <button class="btn small ghost" data-act="init" aria-pressed="${inInit}">Init</button>
      <button class="btn small ghost" data-act="edit">Edit</button>
    </li>`;
  }).join("") || '<li class="empty">No tokens yet. Add your players first.</li>';
}
$("#tokList").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-act]");
  const row = ev.target.closest(".trow");
  if (!b || !row) return;
  const id = row.dataset.id;
  const e = ent(id);
  if (!e) return;
  switch (b.dataset.act) {
    case "focus": select(id); mv.focus(id); break;
    case "vis": e.hidden = !e.hidden; changed(); break;
    case "init":
      if (state.init.list.some((i) => i.id === id)) removeFromInit(id, true);
      else { addToInit(id); changed(); }
      break;
    case "edit": editToken(id); break;
  }
});

function renderSide() { renderInit(); renderTokens(); }

/* ---------- inventory ---------- */
const owners = () => [
  { id: "stash", name: "Party stash", kind: "stash", sub: "Shared with all players" },
  ...state.ents.filter((e) => e.type === "pc").map((e) => ({ id: e.id, name: e.name, kind: "pc", sub: "Visible to players" })),
  { id: "dm", name: "DM only", kind: "dm", sub: "Hidden from players" },
];

function renderInv() {
  for (const o of owners()) state.inv[o.id] ||= [];
  $("#board").innerHTML = owners().map((o) => {
    const items = state.inv[o.id];
    return `<section class="col ${o.kind}" data-owner="${o.id}">
      <header><h3>${esc(o.name)}</h3><span class="sub" style="margin:0">${items.length} item${items.length === 1 ? "" : "s"}</span></header>
      <div class="sub">${o.sub}</div>
      <div class="items">${items.map((it) => `
        <article class="item" data-id="${it.id}" data-owner="${o.id}">
          <span class="grip" aria-hidden="true">⋮⋮</span>
          <div class="imain"><b>${esc(it.name)}</b>${it.note ? `<small>${esc(it.note)}</small>` : ""}</div>
          <div class="qty"><button data-q="-1" aria-label="Decrease quantity">−</button><span>${it.qty}</span><button data-q="1" aria-label="Increase quantity">+</button></div>
        </article>`).join("")}</div>
      <button class="btn small" data-add="${o.id}" type="button">Add item</button>
    </section>`;
  }).join("");
}

const board = $("#board");
let justDragged = false;

board.addEventListener("click", (e) => {
  if (justDragged) return;
  const add = e.target.closest("[data-add]");
  if (add) return itemDialog(add.dataset.add, null);
  const item = e.target.closest(".item");
  if (!item) return;
  const owner = item.dataset.owner;
  const it = state.inv[owner].find((x) => x.id === item.dataset.id);
  if (!it) return;
  const q = e.target.closest("[data-q]");
  if (q) { it.qty = Math.max(1, it.qty + Number(q.dataset.q)); changed(); return; }
  itemDialog(owner, it);
});

function itemDialog(owner, it) {
  openDlg(`
    <form>
      <h2>${it ? "Edit item" : "Add item"}</h2>
      <div class="field"><label for="i_name">Name</label><input id="i_name" name="name" type="text" value="${esc(it?.name || "")}" maxlength="60" required autofocus></div>
      <div class="field"><label for="i_qty">Quantity</label><input id="i_qty" name="qty" type="number" min="1" value="${it?.qty || 1}"></div>
      <div class="field"><label for="i_note">Notes</label><input id="i_note" name="note" type="text" value="${esc(it?.note || "")}" maxlength="120" placeholder="Weight, damage, attunement…"></div>
      <div class="dlg-actions">
        ${it ? '<button type="button" class="btn danger push" data-delete>Delete</button>' : ""}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">${it ? "Save" : "Add"}</button>
      </div>
    </form>`,
    (d) => {
      const name = d.name.trim();
      if (!name) return;
      const qty = Math.max(1, parseInt(d.qty) || 1);
      if (it) { it.name = name; it.qty = qty; it.note = d.note.trim(); }
      else (state.inv[owner] ||= []).push({ id: uid(), name, qty, note: d.note.trim() });
      dlg.close();
      changed();
    },
    (root) => root.querySelector("[data-delete]")?.addEventListener("click", () => {
      state.inv[owner] = state.inv[owner].filter((x) => x.id !== it.id);
      dlg.close();
      changed();
    }));
}

/* Pointer-based drag between columns: works with mouse, finger, and stylus. */
board.addEventListener("pointerdown", (e) => {
  const item = e.target.closest(".item");
  if (!item || e.target.closest("button")) return;
  if (e.pointerType === "mouse" ? e.button !== 0 : !e.target.closest(".grip")) return;
  armDrag(e, item);
});

function dropIndex(col, y, skipId) {
  const cards = [...col.querySelectorAll(".item")].filter((c) => c.dataset.id !== skipId);
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return cards.length;
}

function moveItem(from, id, to, idx) {
  const src = state.inv[from] || [];
  const i = src.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [it] = src.splice(i, 1);
  const dst = (state.inv[to] ||= []);
  dst.splice(Math.min(idx, dst.length), 0, it);
  changed();
}

function armDrag(e, itemEl) {
  const sx = e.clientX, sy = e.clientY;
  const from = itemEl.dataset.owner, id = itemEl.dataset.id;
  let ghost = null;
  const colAt = (x, y) => document.elementFromPoint(x, y)?.closest(".col");
  const mark = (col) => {
    board.querySelectorAll(".col.over").forEach((c) => { if (c !== col) c.classList.remove("over"); });
    col?.classList.add("over");
  };
  const onMove = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      ghost = itemEl.cloneNode(true);
      ghost.classList.add("ghost");
      ghost.style.width = itemEl.offsetWidth + "px";
      document.body.appendChild(ghost);
      itemEl.classList.add("dragging");
    }
    ghost.style.transform = `translate(${ev.clientX + 10}px,${ev.clientY + 10}px)`;
    mark(colAt(ev.clientX, ev.clientY));
  };
  const finish = (ev, cancelled) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    if (!ghost) return;
    justDragged = true;
    setTimeout(() => (justDragged = false), 60);
    ghost.remove();
    itemEl.classList.remove("dragging");
    mark(null);
    if (cancelled) return;
    const col = colAt(ev.clientX, ev.clientY);
    if (!col) return;
    moveItem(from, id, col.dataset.owner, dropIndex(col, ev.clientY, id));
  };
  const onUp = (ev) => finish(ev, false);
  const onCancel = (ev) => finish(ev, true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/* ---------- party: spell slots, spells, player notes ---------- */
const sheets = new Map();   // character id -> { store, el }

function renderParty() {
  const box = $("#party");
  const pcs = state.ents.filter((e) => e.type === "pc");
  for (const [pid, o] of sheets) {
    if (!pcs.some((p) => p.id === pid)) { o.el.remove(); sheets.delete(pid); }
  }
  for (const pc of pcs) {
    let o = sheets.get(pc.id);
    if (!o) {
      const store = new SheetStore(room, pc.id, pin);
      const el = document.createElement("section");
      el.className = "pcard";
      el.innerHTML = '<h2></h2><div class="book"></div><details class="notesbox"><summary>Player notes</summary><div class="nbody"></div></details>';
      box.appendChild(el);
      mountBook(el.querySelector(".book"), store, { canEdit: true });
      mountNotes(el.querySelector(".nbody"), store, { canEdit: false });
      store.subscribe(() => {
        el.querySelector("summary").textContent = `Player notes (${store.view.notes.length})`;
      });
      o = { store, el };
      sheets.set(pc.id, o);
      store.load();
    }
    o.el.querySelector("h2").textContent = pc.name;
  }
  let empty = box.querySelector(".empty");
  if (!pcs.length) {
    if (!empty) { empty = document.createElement("p"); empty.className = "empty"; box.appendChild(empty); }
    empty.textContent = "Add a Player token to track their spell slots, spells and notes.";
  } else empty?.remove();
}

async function pullSheets() {
  if (!state || tab !== "party" || document.hidden || !sheets.size) return;
  try {
    const r = await call(`sheets/${room}`, { pin });
    for (const [pid, o] of sheets) o.store.adopt(r.sheets[pid] || blankSheet());
  } catch { /* try again on the next tick */ }
}

/* ---------- objectives ---------- */
const STATUS_LABEL = { active: "Active", done: "Completed", failed: "Failed" };

function renderObjectives() {
  const list = state.objectives;
  $("#objList").innerHTML = list.length ? list.map((o, i) => `
    <article class="obj ${o.status} ${o.hidden ? "hid" : ""}" data-id="${o.id}">
      <header>
        <h3>${esc(o.title)}</h3>
        <span class="pill">${o.hidden ? "Hidden · " : ""}${STATUS_LABEL[o.status]}</span>
      </header>
      ${o.note ? `<p class="onote">${esc(o.note)}</p>` : ""}
      ${o.steps.length ? `<ul class="steps">${o.steps.map((st) => `
        <li><label class="check"><input type="checkbox" data-act="step" data-s="${st.id}" ${st.done ? "checked" : ""}> <span class="${st.done ? "done" : ""}">${esc(st.text)}</span></label></li>`).join("")}</ul>` : ""}
      <div class="oact">
        <select data-act="status" aria-label="Status of ${esc(o.title)}">
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${o.status === k ? "selected" : ""}>${v}</option>`).join("")}
        </select>
        <button class="btn small" data-act="vis">${o.hidden ? "Show to players" : "Hide from players"}</button>
        <button class="btn small" data-act="edit">Edit</button>
        <button class="btn small ghost" data-act="up" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
        <button class="btn small ghost" data-act="down" ${i === list.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
      </div>
    </article>`).join("") : '<p class="empty">No objectives yet. Add the party\'s goals, quests or secrets.</p>';
}

function objDialog(obj) {
  const isNew = !obj;
  const o = obj || { id: uid(), title: "", note: "", status: "active", hidden: true, steps: [] };
  openDlg(`
    <form>
      <h2>${isNew ? "Add objective" : "Edit objective"}</h2>
      <div class="field"><label for="o_title">Title</label><input id="o_title" name="title" type="text" maxlength="80" value="${esc(o.title)}" required autofocus></div>
      <div class="field"><label for="o_note">Description</label><textarea id="o_note" name="note" rows="3" maxlength="600">${esc(o.note)}</textarea></div>
      <div class="field"><label for="o_steps">Steps (one per line)</label><textarea id="o_steps" name="steps" rows="4" maxlength="800">${esc(o.steps.map((s) => s.text).join("\n"))}</textarea></div>
      <div class="field"><label for="o_status">Status</label><select id="o_status" name="status">
        ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${o.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <label class="check field"><input type="checkbox" name="show" ${o.hidden ? "" : "checked"}> Show to players</label>
      <div class="dlg-actions">
        ${isNew ? "" : '<button type="button" class="btn danger push" data-delete>Delete</button>'}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`,
    (d) => {
      const title = d.title.trim();
      if (!title) return;
      const old = new Map(o.steps.map((s) => [s.text, s]));
      const steps = String(d.steps || "").split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 20)
        .map((t) => old.get(t) || { id: uid(), text: t, done: false });
      Object.assign(o, { title, note: d.note.trim(), steps, status: d.status, hidden: d.show !== "on" });
      if (isNew) state.objectives.push(o);
      dlg.close();
      changed();
    },
    (root) => root.querySelector("[data-delete]")?.addEventListener("click", () => {
      if (!confirm(`Delete "${o.title}"?`)) return;
      state.objectives = state.objectives.filter((x) => x.id !== o.id);
      dlg.close();
      changed();
    }));
}

$("#addObj").onclick = () => objDialog(null);
$("#objList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  const card = e.target.closest(".obj");
  if (!b || !card || b.tagName === "SELECT" || b.tagName === "INPUT") return;
  const list = state.objectives;
  const i = list.findIndex((x) => x.id === card.dataset.id);
  if (i < 0) return;
  const o = list[i];
  if (b.dataset.act === "edit") objDialog(o);
  else if (b.dataset.act === "vis") { o.hidden = !o.hidden; changed(); }
  else if (b.dataset.act === "up" && i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; changed(); }
  else if (b.dataset.act === "down" && i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; changed(); }
});
$("#objList").addEventListener("change", (e) => {
  const card = e.target.closest(".obj");
  const o = card && state.objectives.find((x) => x.id === card.dataset.id);
  if (!o) return;
  if (e.target.dataset.act === "status") { o.status = e.target.value; changed(); }
  else if (e.target.dataset.act === "step") {
    const st = o.steps.find((x) => x.id === e.target.dataset.s);
    if (st) { st.done = e.target.checked; changed(); }
  }
});

/* ---------- initiative sent by players ---------- */
async function pullSubs() {
  if (!state || document.hidden) return;
  try {
    const subs = await call(`subs/${room}`, { pin });
    const seen = state.subT || 0;
    let maxT = seen, applied = 0;
    for (const sub of subs) {
      if (sub.t <= seen) continue;
      maxT = Math.max(maxT, sub.t);
      const e = ent(sub.id);
      if (!e || e.type !== "pc") continue;
      addToInit(sub.id);
      state.init.list.find((i) => i.id === sub.id).init = sub.init;
      applied++;
      toast(`${e.name} sent initiative ${sub.init}`);
    }
    if (maxT > seen) {
      state.subT = maxT;
      if (applied) sortInit();
      changed();
    }
  } catch { /* try again on the next tick */ }
}

/* ---------- roll feed ---------- */
let feedKey = "";
async function pullFeed() {
  if (!state || document.hidden) return;
  try {
    const feed = await call(`feed/${room}`, { pin });
    const key = JSON.stringify(feed.map((r) => r.t + r.r));
    if (key === feedKey) return;
    feedKey = key;
    renderFeed(feed);
  } catch { /* try again on the next tick */ }
}

function renderFeed(feed) {
  $("#feedCount").textContent = feed.length ? `${feed.length} roll${feed.length === 1 ? "" : "s"}` : "";
  $("#feedList").innerHTML = feed.length
    ? feed.map((r) => `<li class="${r.dm ? "dmroll" : ""}">
        <span><span class="who">${esc(r.who)}</span><span class="lab">${esc(r.label)}</span></span>
        <b class="tot ${r.nat === 20 ? "crit" : r.nat === 1 ? "fumble" : ""}">${r.total}</b>
        <span class="det">${esc(r.detail)} · ${new Date(r.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
      </li>`).join("")
    : '<li class="empty" style="display:block">Player rolls will show up here.</li>';
}

$("#feedOn").onchange = (e) => { state.feedOn = e.target.checked; changed(); };
$("#shareDm").onchange = (e) => {
  shareDm = e.target.checked;
  localStorage.setItem("shareDm:" + room, shareDm ? "1" : "0");
};
$("#clearFeed").onclick = async () => {
  if (!confirm("Clear the roll feed for everyone?")) return;
  try { await call(`feed/${room}`, { method: "DELETE", pin }); feedKey = ""; pullFeed(); }
  catch (err) { toast("Could not clear the feed: " + err.message); }
};

/* ---------- header ---------- */
$("#code").textContent = room;
$("#copyLink").onclick = async () => {
  const link = `${location.origin}/play.html?room=${room}`;
  try { await navigator.clipboard.writeText(link); toast("Player link copied."); }
  catch { prompt("Copy this link for your players:", link); }
};
$("#leave").onclick = () => {
  if (!confirm("Leave this table? You can resume it later with the table code and PIN.")) return;
  localStorage.removeItem("dmTable");
  location.href = "/";
};

/* ---------- start ---------- */
(async function start() {
  try {
    const r = await call(`login/${room}`, { method: "POST", body: { pin } });
    state = r.state;
    state.ents ||= []; state.inv ||= {}; state.init ||= { list: [], turnId: null, round: 1, on: false };
    state.grid ||= { on: false, size: 60, snap: false };
    state.fog ||= { on: false, rev: 0 };
    state.grid.opacity ??= 0.3;
    state.grid.ox ||= 0; state.grid.oy ||= 0;
    state.grid.areas ||= [];
    state.feedOn ??= false;
    state.objectives ||= [];
    state.inv.stash ||= []; state.inv.dm ||= [];
    renderMap();
    renderSide();
    mountRoller($("#dice"), {
      onRoll(r) {
        if (shareDm) call(`roll/${room}`, { method: "POST", body: { dm: true, ...r }, pin }).catch(() => {});
      },
    });
    $("#feedOn").checked = state.feedOn;
    $("#shareDm").checked = shareDm;
    pullSubs();
    pullFeed();
    setInterval(() => { pullSubs(); pullFeed(); }, 3000);
    setInterval(pullSheets, 4000);
  } catch (err) {
    if (err.status === 401 || err.status === 404) {
      localStorage.removeItem("dmTable");
      location.replace("/");
    } else {
      document.body.innerHTML = `<p style="padding:2rem">Could not load the table: ${esc(err.message)}. Refresh to try again.</p>`;
    }
  }
})();
