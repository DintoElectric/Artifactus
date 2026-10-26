import { call, esc, TYPES, MapView } from "./common.js";
import { mountRoller, rand } from "./dice.js";

const $ = (s) => document.querySelector(s);
const room = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
if (!room) { location.replace("/"); throw new Error("No table"); }
$("#pcode").textContent = room;

const EMPTY_MAP = "Waiting for the DM to show the map…";
let st = null, rev = "", sheet = null, sheetKey = "", initMsg = "";
let me = localStorage.getItem("me:" + room) || "";
let mod = parseInt(localStorage.getItem("mod:" + room)) || 0;

const mv = new MapView($("#map"), {
  interactive: false,
  emptyText: EMPTY_MAP,
  imgUrl: (e) => (e.img ? `/api/img/${room}/${e.id}?v=${e.img}` : null),
});
mountRoller($("#diceBody"));

function setDockHeight() {
  document.documentElement.style.setProperty("--dockh", $("#dock").offsetHeight + "px");
}
setDockHeight();
window.addEventListener("resize", setDockHeight);

/* ---------- render ---------- */
function render() {
  const I = st.init;
  const showMap = st.mapOn && st.mapRev;
  if (showMap) mv.setMap(st.mapRev, `/api/map/${room}?v=${st.mapRev}`);
  else mv.setMap(null, null, EMPTY_MAP);
  const fog = st.fog || { on: false, rev: 0 };
  mv.setFog(showMap && fog.on, fog.rev, fog.rev ? `/api/fog/${room}?v=${fog.rev}` : null);
  mv.update({ ents: st.ents, grid: st.grid, turnId: I.on ? I.turnId : null });

  const turn = I.on ? st.ents.find((e) => e.id === I.turnId) : null;
  const banner = $("#banner");
  banner.classList.toggle("me", !!turn && turn.id === me);
  banner.textContent = !I.on ? "" : turn ? (turn.id === me ? "Your turn" : `Round ${I.round} · ${turn.name}`) : `Round ${I.round}`;
  renderSheet(false);
}

const hp = (e) => (e.type === "pc" && e.hp != null ? `${e.hp}${e.maxHp != null ? "/" + e.maxHp : ""} HP` : "");

function itemList(items) {
  if (!items || !items.length) return '<p class="empty">Nothing here yet.</p>';
  return `<ul class="pitems">${items.map((it) =>
    `<li><span><b>${esc(it.name)}</b>${it.note ? `<small>${esc(it.note)}</small>` : ""}</span><span>×${it.qty}</span></li>`).join("")}</ul>`;
}

const meSelect = (pcs) => `
  <div class="field"><label for="meSel">Your character</label>
    <select id="meSel"><option value="">Choose…</option>${pcs.map((p) =>
      `<option value="${p.id}" ${p.id === me ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>`;

function renderSheet(force) {
  const box = $("#sheet");
  document.querySelectorAll("[data-sheet]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sheet === sheet));
  if (!sheet) { box.hidden = true; return; }
  box.hidden = false;
  $("#sheetTitle").textContent = { init: "Initiative", inv: "Inventory", dice: "Dice" }[sheet];
  $("#diceBody").hidden = sheet !== "dice";
  $("#sheetBody").hidden = sheet === "dice";
  if (sheet === "dice") return;

  const pcs = st.ents.filter((e) => e.type === "pc");
  if (me && !pcs.some((p) => p.id === me)) me = "";
  const key = sheet + JSON.stringify(sheet === "init"
    ? [st.init, st.ents.map((e) => [e.id, e.name, e.hp, e.maxHp, e.down]), me, initMsg]
    : [st.inv, pcs.map((p) => [p.id, p.name]), me]);
  if (!force && key === sheetKey) return;
  // Don't wipe what the player is typing.
  const active = document.activeElement;
  if (!force && $("#sheetBody").contains(active) && active.matches("input,select")) return;
  sheetKey = key;

  if (sheet === "init") {
    const I = st.init;
    const byId = new Map(st.ents.map((e) => [e.id, e]));
    const rows = I.list.map((it) => {
      const e = byId.get(it.id);
      if (!e) return "";
      return `<li class="prow ${I.on && I.turnId === e.id ? "turn" : ""} ${e.down ? "down" : ""}">
        <span class="dot" style="--c:${TYPES[e.type].color}"></span>
        <span class="pn">${esc(e.name)}</span><span class="pv">${hp(e)}</span><b>${it.init ?? ""}</b></li>`;
    }).join("");
    const mine = I.list.find((i) => i.id === me);
    const send = me
      ? `<div class="initbox">
          <div class="row">
            <div class="field"><label for="modIn">Initiative modifier</label><input id="modIn" type="number" inputmode="numeric" value="${mod}"></div>
            <button class="btn primary" type="button" data-act="roll">Roll d20</button>
          </div>
          <div class="row">
            <div class="field"><label for="initIn">Or enter your roll</label><input id="initIn" type="number" inputmode="numeric"></div>
            <button class="btn" type="button" data-act="send">Send to DM</button>
          </div>
          <p class="msg" role="status">${esc(initMsg || (mine?.init != null ? `Your initiative: ${mine.init}` : ""))}</p>
        </div>`
      : '<p class="empty">Choose your character to send your initiative.</p>';
    $("#sheetBody").innerHTML = meSelect(pcs) + send +
      (rows ? (I.on ? "" : '<p class="empty">Combat hasn\'t started yet.</p>') + `<ol>${rows}</ol>` : '<p class="empty">No combat right now.</p>');
  } else {
    $("#sheetBody").innerHTML = meSelect(pcs) + (me ? itemList(st.inv[me]) : "") +
      `<p class="plabel">Party stash</p>` + itemList(st.inv.stash);
  }
}

async function sendInit(value, note) {
  try {
    await call(`initiative/${room}`, { method: "POST", body: { id: me, init: value } });
    initMsg = note;
  } catch (err) {
    initMsg = err.message;
  }
  renderSheet(true);
}

$("#sheetBody").addEventListener("change", (e) => {
  if (e.target.id === "meSel") {
    me = e.target.value;
    localStorage.setItem("me:" + room, me);
    initMsg = "";
    render();
    renderSheet(true);
  }
});
$("#sheetBody").addEventListener("input", (e) => {
  if (e.target.id === "modIn") {
    mod = parseInt(e.target.value) || 0;
    localStorage.setItem("mod:" + room, mod);
  }
});
$("#sheetBody").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !me) return;
  if (b.dataset.act === "roll") {
    const d = rand(20);
    const total = d + mod;
    const m = mod ? (mod > 0 ? ` + ${mod}` : ` − ${Math.abs(mod)}`) : "";
    sendInit(total, `You rolled ${d}${m} = ${total}. Sent to the DM.`);
  } else if (b.dataset.act === "send") {
    const v = parseInt($("#initIn").value);
    if (!Number.isFinite(v)) { initMsg = "Enter a number first."; renderSheet(true); return; }
    sendInit(v, `Sent ${v} to the DM.`);
  }
});

document.querySelectorAll("[data-sheet]").forEach((b) =>
  b.addEventListener("click", () => {
    sheet = sheet === b.dataset.sheet ? null : b.dataset.sheet;
    initMsg = "";
    if (st) renderSheet(true);
  }));
$("#sheetClose").onclick = () => { sheet = null; if (st) renderSheet(true); };
$("#fitBtn").onclick = () => mv.fit();

/* ---------- polling ---------- */
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(poll, 2000); };

async function poll() {
  if (document.hidden) { schedule(); return; }
  try {
    const r = await call(`state/${room}?rev=${rev}`);
    $("#conn").classList.remove("off");
    if (!r.unchanged) { st = r.state; rev = st.rev; render(); }
  } catch (err) {
    if (err.status === 404) {
      document.body.innerHTML = '<p style="padding:2rem;font-size:1.1rem">This table no longer exists. Check the code with your DM.</p>';
      return;
    }
    $("#conn").classList.add("off");
  }
  schedule();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { clearTimeout(timer); poll(); } });
poll();
