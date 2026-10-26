import { call, esc, TYPES, MapView } from "./common.js";
import { mountRoller, rand } from "./dice.js";
import { SheetStore, mountBook, mountNotes } from "./sheet.js";
import { Library } from "./library.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const room = (params.get("room") || "").toUpperCase();
if (!room) { location.replace("/"); throw new Error("No table"); }
$("#pcode").textContent = room;

const EMPTY_MAP = "Waiting for the DM to show the map…";
const TITLES = { init: "Initiative", goals: "Goals", inv: "Items", spells: "Spells", notes: "Notes", dice: "Dice" };
const PANES = { init: "sheetBody", goals: "sheetBody", inv: "sheetBody", spells: "spellBody", notes: "noteBody", dice: "diceBody" };

let st = null, rev = "", ft = 0, feed = null, sheet = null, sheetKey = "", initMsg = "";
let mod = parseInt(localStorage.getItem("mod:" + room)) || 0;

/* ---------- who am I: logging in to a character ---------- */
const LKEY = "login:" + room;
const WKEY = "watch:" + room;
let session = JSON.parse(localStorage.getItem(LKEY) || "null");   // { pid, name, token }
let me = session?.pid || "";
let loginNote = "";
let inviteChar = params.get("c") || "";
const auth = () => ({ token: session?.token || undefined });

function saveSession(s) {
  session = s;
  me = s?.pid || "";
  if (s) localStorage.setItem(LKEY, JSON.stringify(s)); else localStorage.removeItem(LKEY);
  sheetKey = "";
  storePid = "";
  updateWho();
  if (st) { render(); renderSheet(true); }
}

function logout(note) {
  loginNote = note || "";
  saveSession(null);
  sessionStorage.removeItem(WKEY);
  openLogin();
}

function updateWho() {
  $("#whoBtn").textContent = session ? session.name : "Log in";
}

const loginDlg = $("#loginDlg");
function openLogin(preselect) {
  if (!st) return;
  const pcs = st.ents.filter((e) => e.type === "pc");
  const pick = (preselect || inviteChar) && pcs.find((p) => p.id === (preselect || inviteChar));
  inviteChar = "";
  loginDlg.innerHTML = `
    <h2>Who are you playing?</h2>
    <p class="msg" id="loginMsg" role="alert">${esc(loginNote)}</p>
    ${pcs.length ? `<ul class="chars" id="charList">${pcs.map((p) => `
      <li><button class="btn charbtn" type="button" data-pid="${p.id}"><span>${esc(p.name)}</span><small>${p.locked ? "PIN" : "Open"}</small></button></li>`).join("")}</ul>`
      : '<p class="empty">Your DM hasn\'t added any player characters yet.</p>'}
    <form id="pinForm" hidden>
      <div class="field"><label for="pinIn">PIN for <b id="pinName"></b></label>
        <input id="pinIn" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></div>
      <div class="row">
        <button class="btn primary" type="submit">Log in</button>
        <button class="btn" type="button" id="pinBack">Back</button>
      </div>
    </form>
    <div class="dlg-actions"><button class="btn ghost" type="button" id="watchBtn">Just watching</button></div>`;
  loginNote = "";
  if (!loginDlg.open) loginDlg.showModal();
  if (pick) choose(pick.id);
}

let chosen = "";
function choose(pid) {
  const p = st.ents.find((e) => e.id === pid);
  if (!p) return;
  chosen = pid;
  if (!p.locked) { submitLogin(""); return; }
  $("#charList").hidden = true;
  $("#pinForm").hidden = false;
  $("#pinName").textContent = p.name;
  $("#loginMsg").textContent = "";
  $("#pinIn").value = "";
  $("#pinIn").focus();
}

async function submitLogin(pin) {
  try {
    const r = await call(`playerlogin/${room}`, { method: "POST", body: { pid: chosen, pin } });
    loginDlg.close();
    sessionStorage.removeItem(WKEY);
    saveSession({ pid: r.pid, name: r.name, token: r.token });
  } catch (err) {
    if ($("#pinForm").hidden) {            // an "open" character turned out to need a PIN
      $("#charList").hidden = true;
      $("#pinForm").hidden = false;
      $("#pinName").textContent = st.ents.find((e) => e.id === chosen)?.name || "";
      $("#pinIn").focus();
    }
    $("#loginMsg").textContent = err.message;
  }
}

loginDlg.addEventListener("click", (e) => {
  const c = e.target.closest("[data-pid]");
  if (c) choose(c.dataset.pid);
  else if (e.target.id === "pinBack") { $("#pinForm").hidden = true; $("#charList").hidden = false; $("#loginMsg").textContent = ""; }
  else if (e.target.id === "watchBtn") { sessionStorage.setItem(WKEY, "1"); loginDlg.close(); }
});
loginDlg.addEventListener("submit", (e) => { e.preventDefault(); submitLogin($("#pinIn").value); });
loginDlg.addEventListener("cancel", () => sessionStorage.setItem(WKEY, "1"));
$("#whoBtn").onclick = () => {
  if (session && !confirm(`You're playing ${session.name}. Switch character?`)) return;
  if (session) { saveSession(null); }
  openLogin();
};

/* Ask for a login once the character list arrives, unless they chose to just watch. */
function maybeAskLogin() {
  if (session || sessionStorage.getItem(WKEY) === "1" || loginDlg.open) return;
  if (st.ents.some((e) => e.type === "pc")) openLogin();
}

/* ---------- map ---------- */
const mv = new MapView($("#map"), {
  interactive: false,
  emptyText: EMPTY_MAP,
  imgUrl: (e) => (e.img ? `/api/img/${room}/${e.id}?v=${e.img}` : null),
});

// Every roll goes to the DM; the DM decides whether the other players see the feed.
function postRoll(r) {
  call(`roll/${room}`, { method: "POST", body: { pid: me || undefined, ...r }, ...auth() }).catch(() => {});
}
mountRoller($("#roller"), { onRoll: postRoll });

function setDockHeight() {
  document.documentElement.style.setProperty("--dockh", $("#dock").offsetHeight + "px");
}
setDockHeight();
window.addEventListener("resize", setDockHeight);

function render() {
  const I = st.init;
  const showMap = st.mapOn && st.mapRev;
  if (showMap) mv.setMap(st.mapRev, `/api/map/${room}?v=${st.mapRev}`);
  else mv.setMap(null, null, EMPTY_MAP);
  const fog = st.fog || { on: false, rev: 0 };
  mv.setFog(showMap && fog.on, fog.rev, fog.rev ? `/api/fog/${room}?v=${fog.rev}` : null);
  mv.update({ ents: st.ents, grid: st.grid, turnId: I.on ? I.turnId : null });

  if (me && !st.ents.some((e) => e.id === me && e.type === "pc")) { saveSession(null); return; }
  const turn = I.on ? st.ents.find((e) => e.id === I.turnId) : null;
  const banner = $("#banner");
  banner.classList.toggle("me", !!turn && turn.id === me);
  banner.textContent = !I.on ? "" : turn ? (turn.id === me ? "Your turn" : `Round ${I.round} · ${turn.name}`) : `Round ${I.round}`;
  renderFeed();
  renderSheet(false);
}

function renderFeed() {
  const wrap = $("#feedWrap");
  if (!feed) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $("#feedList").innerHTML = feed.length
    ? feed.map((r) => `<li class="${r.dm ? "dmroll" : ""}">
        <span><span class="who">${esc(r.who)}</span><span class="lab">${esc(r.label)}</span></span>
        <b class="tot ${r.nat === 20 ? "crit" : r.nat === 1 ? "fumble" : ""}">${r.total}</b>
        <span class="det">${esc(r.detail)}</span>
      </li>`).join("")
    : '<li class="empty" style="display:block">No rolls yet.</li>';
}

/* ---------- sheet panels ---------- */
const hp = (e) => (e.type === "pc" && e.hp != null ? `${e.hp}${e.maxHp != null ? "/" + e.maxHp : ""} HP` : "");
const loginPrompt = (what) => `<p class="empty">Log in to your character to ${what}.</p><button class="btn primary" data-act="login" type="button">Log in</button>`;

function itemList(items) {
  if (!items || !items.length) return '<p class="empty">Nothing here yet.</p>';
  return `<ul class="pitems">${items.map((it) =>
    `<li><span><b>${esc(it.name)}</b>${it.note ? `<small>${esc(it.note)}</small>` : ""}</span><span>×${it.qty}</span></li>`).join("")}</ul>`;
}

/* Spells and notes live in a per-character sheet saved on the server. */
const library = new Library(room);
let store = null, storePid = "";
function bindStore() {
  if (!me) {
    store = null; storePid = "";
    $("#spellBody").innerHTML = loginPrompt("track your spells");
    $("#noteBody").innerHTML = loginPrompt("keep notes");
    return;
  }
  if (storePid === me) return;
  storePid = me;
  store = new SheetStore(room, me, auth());
  store.subscribe(() => { if (store.status === "auth") logout("Your login changed, so please sign in again."); });
  for (const [sel, mount] of [["#spellBody", mountBook], ["#noteBody", mountNotes]]) {
    const host = $(sel);
    host.innerHTML = "";
    const inner = document.createElement("div");
    host.appendChild(inner);
    mount(inner, store, { canEdit: true, library });
  }
  store.load();
  library.load();
}
setInterval(() => {
  if (!document.hidden && store && (sheet === "spells" || sheet === "notes")) store.load();
}, 5000);

function renderSheet(force) {
  const box = $("#sheet");
  document.querySelectorAll("[data-sheet]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sheet === sheet));
  if (!sheet) { box.hidden = true; return; }
  box.hidden = false;
  $("#sheetTitle").textContent = TITLES[sheet];
  for (const id of ["sheetBody", "spellBody", "noteBody", "diceBody"]) $("#" + id).hidden = id !== PANES[sheet];
  if (!st) return;
  if (sheet === "dice") return;
  if (sheet === "spells" || sheet === "notes") { bindStore(); return; }

  const pcs = st.ents.filter((e) => e.type === "pc");
  const key = sheet + JSON.stringify(
    sheet === "init" ? [st.init, st.ents.map((e) => [e.id, e.name, e.hp, e.maxHp, e.down]), me, initMsg]
    : sheet === "goals" ? st.objectives || []
    : [st.inv, pcs.map((p) => [p.id, p.name]), me]);
  if (!force && key === sheetKey) return;
  // Don't wipe what the player is typing.
  const active = document.activeElement;
  if (!force && $("#sheetBody").contains(active) && active.matches("input,select")) return;
  sheetKey = key;

  const body = $("#sheetBody");
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
      : `<div class="initbox">${loginPrompt("send your initiative")}</div>`;
    body.innerHTML = send +
      (rows ? (I.on ? "" : '<p class="empty">Combat hasn\'t started yet.</p>') + `<ol>${rows}</ol>` : '<p class="empty">No combat right now.</p>');
  } else if (sheet === "goals") {
    const objs = st.objectives || [];
    const group = (status, label) => {
      const list = objs.filter((o) => o.status === status);
      if (!list.length) return "";
      return `<h3 class="goalhead">${label}</h3>${list.map((o) => `
        <article class="obj ${o.status}">
          <h4>${esc(o.title)}</h4>
          ${o.note ? `<p class="onote">${esc(o.note)}</p>` : ""}
          ${o.steps.length ? `<ul class="steps">${o.steps.map((s) => `<li class="${s.done ? "done" : ""}"><span aria-hidden="true">${s.done ? "✓" : "○"}</span> ${esc(s.text)}<span class="sr"> (${s.done ? "done" : "not done"})</span></li>`).join("")}</ul>` : ""}
        </article>`).join("")}`;
    };
    body.innerHTML = objs.length ? group("active", "Active") + group("done", "Completed") + group("failed", "Failed")
      : '<p class="empty">Your DM hasn\'t shared any goals yet.</p>';
  } else {
    body.innerHTML = (me ? itemList(st.inv[me]) : loginPrompt("see your items")) +
      `<p class="plabel">Party stash</p>` + itemList(st.inv.stash);
  }
}

async function sendInit(value, note) {
  try {
    await call(`initiative/${room}`, { method: "POST", body: { id: me, init: value }, ...auth() });
    initMsg = note;
  } catch (err) {
    if (err.status === 401) { logout("Your login changed, so please sign in again."); return; }
    initMsg = err.message;
  }
  renderSheet(true);
}

$("#sheet").addEventListener("click", (e) => {
  if (e.target.closest('[data-act="login"]')) openLogin();
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
    postRoll({ label: "Initiative", total, detail: `d20 [${d}]${m}`, nat: d === 20 || d === 1 ? d : null });
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
updateWho();

/* ---------- polling ---------- */
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(poll, 2000); };

async function poll() {
  if (document.hidden) { schedule(); return; }
  try {
    const r = await call(`state/${room}?rev=${rev}&ft=${ft}`);
    $("#conn").classList.remove("off");
    if (!r.unchanged) {
      const first = !st;
      st = r.state; rev = st.rev;
      feed = r.feed || null;
      ft = feed && feed.length ? feed[0].t : 0;
      render();
      if (first || !session) maybeAskLogin();
    }
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
