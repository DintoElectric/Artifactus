import { call, esc } from "./common.js";

const $ = (s, r = document) => r.querySelector(s);
let acct = JSON.parse(localStorage.getItem("dmAccount") || "null");
if (!acct) { location.replace("/"); throw new Error("Not signed in"); }

$("#acctName").textContent = acct.name;
let campaigns = [];

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function signOut() {
  localStorage.removeItem("dmAccount");
  localStorage.removeItem("dmTable");
  location.replace("/");
}

/* A request that signs you out if the account no longer recognises this device. */
async function api(path, opts = {}) {
  try {
    return await call(path, { ...opts, acct: acct.token });
  } catch (err) {
    if (err.status === 401 && /sign in again/i.test(err.message)) signOut();   // this device's login is no longer valid
    throw err;
  }
}

/* ----- the list ----- */
function render() {
  $("#list").innerHTML = campaigns.length ? campaigns.map((c) => `
    <li class="campcard" data-code="${c.code}">
      <div class="camptop">
        <h3>${esc(c.name)}</h3>
        <code title="Table code your players type">${esc(c.code)}</code>
      </div>
      <div class="campact">
        <button class="btn primary" type="button" data-act="open">Open</button>
        <button class="btn small" type="button" data-act="link">Copy player link</button>
        <button class="btn small" type="button" data-act="rename">Rename</button>
        <button class="btn small ghost danger" type="button" data-act="delete">Delete</button>
      </div>
    </li>`).join("")
    : '<li class="empty">No campaigns yet. Create your first one above.</li>';
}

async function load() {
  try {
    const r = await api("account/me");
    acct.name = r.name;
    campaigns = r.campaigns;
    render();
  } catch (err) {
    $("#list").innerHTML = `<li class="empty">Could not load your campaigns: ${esc(err.message)}</li>`;
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

function deleteDialog(c) {
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
        localStorage.setItem("dmAccount", JSON.stringify(acct));
        dlg.close();
        toast("Password changed.");
      } catch (err) { toast(err.message); }
    });
}

/* ----- events ----- */
$("#list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  const card = e.target.closest("[data-code]");
  if (!b || !card) return;
  const c = campaigns.find((x) => x.code === card.dataset.code);
  if (!c) return;
  if (b.dataset.act === "open") openCampaign(c.code);
  else if (b.dataset.act === "rename") renameDialog(c);
  else if (b.dataset.act === "delete") deleteDialog(c);
  else if (b.dataset.act === "link") {
    const link = `${location.origin}/play.html?room=${c.code}`;
    try { await navigator.clipboard.writeText(link); toast("Player link copied."); }
    catch { prompt("Copy this link for your players:", link); }
  }
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
load();
