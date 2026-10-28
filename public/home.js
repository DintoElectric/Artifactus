import { call, esc, getAccount, setAccount, clearAccount } from "./common.js";

const $ = (s, r = document) => r.querySelector(s);
let acct = getAccount();
if (!acct) { location.replace("/"); throw new Error("Not signed in"); }
$("#acctName").textContent = acct.name;

let data = { campaigns: [], characters: [], playing: [] };
let tab = sessionStorage.getItem("homeTab") || "chars";

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

function signOut() {
  clearAccount();
  localStorage.removeItem("dmTable");
  location.replace("/");
}

/* A request that signs you out if the account no longer recognises this device. */
async function api(path, opts = {}) {
  try {
    return await call(path, { ...opts, acct: acct.token });
  } catch (err) {
    if (err.status === 401 && /sign in again/i.test(err.message)) signOut();
    throw err;
  }
}

/* ----- tabs ----- */
function setTab(t) {
  tab = t;
  sessionStorage.setItem("homeTab", t);
  document.querySelectorAll(".hometabs [data-tab]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === t));
  $("#tabChars").hidden = t !== "chars";
  $("#tabPlay").hidden = t !== "play";
  $("#tabRun").hidden = t !== "run";
}
document.querySelector(".hometabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) setTab(b.dataset.tab);
});

/* ----- characters ----- */
const STATUS = { pending: "Waiting for the DM", active: "Playing", denied: "Not accepted", gone: "Campaign deleted" };

function renderChars() {
  $("#charList").innerHTML = data.characters.length ? data.characters.map((c) => {
    const where = data.playing.filter((p) => p.charId === c.id && p.status !== "denied");
    return `<li class="campcard" data-id="${c.id}">
      <div class="camptop"><h3>${esc(c.name)}</h3><span class="pill">${esc(c.summary)}</span></div>
      <p class="hint" style="margin:0">${where.length ? where.map((p) => `${esc(STATUS[p.status] || p.status)}: ${esc(p.campaign)}`).join("<br>") : "Not in a campaign yet"}</p>
      <div class="campact">
        <a class="btn primary" href="character.html?id=${encodeURIComponent(c.id)}">Open sheet</a>
        <button class="btn small" type="button" data-act="join">Join a campaign</button>
        <button class="btn small ghost danger" type="button" data-act="delchar">Delete</button>
      </div>
    </li>`;
  }).join("") : '<li class="empty">No characters yet. Create one above, and fill in the full sheet whenever you like.</li>';

  $("#joinChar").innerHTML = data.characters.length
    ? data.characters.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.summary)})</option>`).join("")
    : '<option value="">Create a character first</option>';
}

/* ----- campaigns I play ----- */
function renderPlay() {
  $("#playList").innerHTML = data.playing.length ? data.playing.map((p) => `
    <li class="campcard" data-code="${p.code}">
      <div class="camptop"><h3>${esc(p.campaign)}</h3><code title="Campaign code">${esc(p.code)}</code></div>
      <p style="margin:0">As <b>${esc(p.charName)}</b> <span class="pill st-${p.status}">${esc(STATUS[p.status] || p.status)}</span></p>
      ${p.status === "pending" ? '<p class="hint" style="margin:0">Your DM will see this the next time they have the table open.</p>' : ""}
      ${p.status === "denied" ? '<p class="hint" style="margin:0">The DM didn\'t accept this request. You can ask again with the same or another character.</p>' : ""}
      <div class="campact">
        ${p.status === "active" ? `<a class="btn primary" href="play.html?room=${encodeURIComponent(p.code)}">Open</a>` : ""}
        <button class="btn small ghost ${p.status === "active" ? "danger" : ""}" type="button" data-act="leave">${p.status === "active" ? "Leave campaign" : p.status === "pending" ? "Cancel request" : "Remove"}</button>
      </div>
    </li>`).join("")
    : '<li class="empty">You haven\'t joined any campaigns yet.</li>';
}

/* ----- campaigns I run ----- */
function renderRun() {
  $("#list").innerHTML = data.campaigns.length ? data.campaigns.map((c) => `
    <li class="campcard" data-code="${c.code}">
      <div class="camptop"><h3>${esc(c.name)}</h3><code title="Table code your players type">${esc(c.code)}</code></div>
      <div class="campact">
        <button class="btn primary" type="button" data-act="open">Open</button>
        <button class="btn small" type="button" data-act="link">Copy player link</button>
        <button class="btn small" type="button" data-act="rename">Rename</button>
        <button class="btn small ghost danger" type="button" data-act="delete">Delete</button>
      </div>
    </li>`).join("")
    : '<li class="empty">No campaigns yet. Create your first one above.</li>';
}

function render() { renderChars(); renderPlay(); renderRun(); }

async function load() {
  try {
    const r = await api("account/me");
    acct.name = r.name;
    data = { campaigns: r.campaigns, characters: r.characters || [], playing: r.playing || [] };
    render();
  } catch (err) {
    const msg = `<li class="empty">Could not load your account: ${esc(err.message)}</li>`;
    $("#charList").innerHTML = msg;
  }
}

function openCampaign(code) {
  localStorage.setItem("dmTable", JSON.stringify({ room: code, pin: "acct:" + acct.token, via: "account" }));
  location.href = "dm.html";
}

/* ----- dialogs ----- */
const dlg = $("#dlg");
function ask(html, onSubmit, onMount) {
  dlg.innerHTML = html;
  const f = dlg.querySelector("form");
  f.addEventListener("submit", (e) => { e.preventDefault(); onSubmit(Object.fromEntries(new FormData(f)), f); });
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
  onMount?.(dlg);
  dlg.showModal();
}

function renameDialog(c) {
  ask(`
    <form>
      <h2>Rename campaign</h2>
      <div class="field"><label for="r_name">Name</label><input id="r_name" name="name" type="text" maxlength="80" value="${esc(c.name)}" required autofocus></div>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`,
    async (d) => {
      try { await api(`account/campaigns/${c.code}`, { method: "PUT", body: { name: d.name } }); dlg.close(); await load(); }
      catch (err) { toast(err.message); }
    });
}

function deleteCampaignDialog(c) {
  ask(`
    <form>
      <h2>Delete "${esc(c.name)}"?</h2>
      <p style="margin:0 0 .7rem">This erases its maps, characters, notes and session log for good. Your players will no longer be able to join with code <b>${esc(c.code)}</b>.</p>
      <div class="field"><label for="d_name">Type the campaign name to confirm</label><input id="d_name" name="name" type="text" autocomplete="off" autofocus></div>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn danger">Delete forever</button></div>
    </form>`,
    async (d) => {
      if (d.name.trim() !== c.name.trim()) { toast("That doesn't match the campaign name."); return; }
      try {
        await api(`account/campaigns/${c.code}`, { method: "DELETE" });
        dlg.close();
        toast("Campaign deleted.");
        await load();
      } catch (err) { toast(err.message); }
    });
}

function deleteCharDialog(c) {
  ask(`
    <form>
      <h2>Delete ${esc(c.name)}?</h2>
      <p style="margin:0 0 .7rem">The whole sheet, spells and notes are erased for good. A character that is in a campaign can't be deleted until you leave it.</p>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Keep</button><button type="submit" class="btn danger">Delete forever</button></div>
    </form>`,
    async () => {
      try { await api(`account/characters/${c.id}`, { method: "DELETE" }); dlg.close(); toast("Character deleted."); await load(); }
      catch (err) { dlg.close(); toast(err.message); }
    });
}

function joinDialog(c) {
  ask(`
    <form>
      <h2>Join a campaign as ${esc(c.name)}</h2>
      <div class="field"><label for="j_code">Campaign code from your DM</label>
        <input id="j_code" name="code" type="text" autocapitalize="characters" autocomplete="off" maxlength="8" required autofocus></div>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Ask to join</button></div>
    </form>`,
    async (d) => { if (await requestJoin(d.code, c.id)) dlg.close(); });
}

function passwordDialog() {
  ask(`
    <form>
      <h2>Change password</h2>
      <div class="field"><label for="p_old">Current password</label><input id="p_old" name="old" type="password" autocomplete="current-password" required autofocus></div>
      <div class="field"><label for="p_new">New password (8 or more characters)</label><input id="p_new" name="next" type="password" autocomplete="new-password" required></div>
      <div class="field"><label for="p_new2">Confirm new password</label><input id="p_new2" name="again" type="password" autocomplete="new-password" required></div>
      <p class="hint">You'll be signed out of your other devices.</p>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Change password</button></div>
    </form>`,
    async (d) => {
      if (d.next !== d.again) { toast("The new passwords don't match."); return; }
      try {
        const r = await api("account/password", { method: "POST", body: { old: d.old, next: d.next } });
        acct.token = r.token;
        setAccount(acct);
        dlg.close();
        toast("Password changed.");
      } catch (err) { toast(err.message); }
    });
}

/* ----- joining ----- */
async function requestJoin(code, charId) {
  try {
    await api("account/join", { method: "POST", body: { code, charId } });
    toast("Request sent. Your DM will see it when they next have the table open.");
    await load();
    setTab("play");
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

/* ----- events ----- */
$("#charList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  const card = e.target.closest("[data-id]");
  const c = card && data.characters.find((x) => x.id === card.dataset.id);
  if (!b || !c) return;
  if (b.dataset.act === "join") joinDialog(c);
  else if (b.dataset.act === "delchar") deleteCharDialog(c);
});

$("#playList").addEventListener("click", (e) => {
  const b = e.target.closest('[data-act="leave"]');
  const card = e.target.closest("[data-code]");
  if (!b || !card) return;
  const p = data.playing.find((x) => x.code === card.dataset.code);
  if (!p) return;
  const leave = async () => {
    try { await api(`account/playing/${p.code}`, { method: "DELETE" }); dlg.close(); await load(); }
    catch (err) { dlg.close(); toast(err.message); }
  };
  if (p.status !== "active") { leave(); return; }
  ask(`
    <form>
      <h2>Leave ${esc(p.campaign)}?</h2>
      <p style="margin:0 0 .7rem">${esc(p.charName)} stays in your characters. Your DM will need to remove your token from their map.</p>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Stay</button><button type="submit" class="btn danger">Leave campaign</button></div>
    </form>`, leave);
});

$("#list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  const card = e.target.closest("[data-code]");
  if (!b || !card) return;
  const c = data.campaigns.find((x) => x.code === card.dataset.code);
  if (!c) return;
  if (b.dataset.act === "open") openCampaign(c.code);
  else if (b.dataset.act === "rename") renameDialog(c);
  else if (b.dataset.act === "delete") deleteCampaignDialog(c);
  else if (b.dataset.act === "link") {
    const link = `${location.origin}/play.html?room=${c.code}`;
    try { await navigator.clipboard.writeText(link); toast("Player link copied."); }
    catch { prompt("Copy this link for your players:", link); }
  }
});

$("#newChar").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#newCharErr").textContent = "";
  try {
    const r = await api("account/characters", { method: "POST", body: { name: $("#newCharName").value } });
    location.href = `character.html?id=${encodeURIComponent(r.id)}`;
  } catch (err) {
    $("#newCharErr").textContent = err.message;
  }
});

$("#joinForm2").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#joinErr2").textContent = "";
  if (!$("#joinChar").value) { $("#joinErr2").textContent = "Create a character first."; return; }
  if (await requestJoin($("#joinCode2").value, $("#joinChar").value)) $("#joinCode2").value = "";
});

$("#newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#newErr").textContent = "";
  try {
    const r = await api("account/campaigns", { method: "POST", body: { name: $("#newName").value } });
    openCampaign(r.code);
  } catch (err) {
    $("#newErr").textContent = err.message;
  }
});

$("#claimForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#claimErr").textContent = "";
  try {
    await api("account/claim", { method: "POST", body: { code: $("#claimCode").value, pin: $("#claimPin").value } });
    $("#claimCode").value = ""; $("#claimPin").value = "";
    toast("Table added to your campaigns.");
    await load();
  } catch (err) {
    $("#claimErr").textContent = err.message;
  }
});

$("#pwBtn").onclick = passwordDialog;
$("#outBtn").onclick = signOut;
setTab(tab);
load();
window.__started = true;
