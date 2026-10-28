import { call, getAccount, clearAccount, esc } from "./common.js";
import { SheetStore, mountBook, mountNotes } from "./sheet.js";
import { mountChar } from "./charsheet.js";
import { Library } from "./library.js";

const $ = (s) => document.querySelector(s);
const acct = getAccount();
const id = new URLSearchParams(location.search).get("id") || "";
if (!acct) { location.replace("/"); throw new Error("Not signed in"); }
if (!id) { location.replace("home.html"); throw new Error("No character"); }

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* The character lives in the player's own library, so it follows them from campaign to campaign. */
const store = new SheetStore(null, id, { acct: acct.token }, `account/char/${id}`);
const library = new Library("");   // no campaign here: only the spell list shipped with the app, if there is one
library.load();

mountChar($("#paneSheet"), store, { hp: null });
mountBook($("#paneSpells"), store, { canEdit: true, library });
mountNotes($("#paneNotes"), store, { canEdit: true });

store.subscribe(() => {
  if (store.status === "auth") { clearAccount(); location.replace("/"); }
});
store.load();
window.addEventListener("beforeunload", (e) => { if (store.ops.length || store.saving) { e.preventDefault(); e.returnValue = ""; } });

/* ----- tabs ----- */
function setTab(t) {
  document.querySelectorAll(".hometabs [data-tab]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === t));
  $("#paneSheet").hidden = t !== "sheet";
  $("#paneSpells").hidden = t !== "spells";
  $("#paneNotes").hidden = t !== "notes";
}
document.querySelector(".hometabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) setTab(b.dataset.tab);
});

/* ----- name ----- */
let name = "";
async function loadName() {
  try {
    const r = await call("account/me", { acct: acct.token });
    const c = (r.characters || []).find((x) => x.id === id);
    if (!c) { location.replace("home.html"); return; }
    name = c.name;
    $("#charName").textContent = name;
    document.title = `${name} · DM Table`;
  } catch (err) {
    if (err.status === 401) { clearAccount(); location.replace("/"); }
  }
}
loadName();

const dlg = $("#dlg");
$("#renameBtn").onclick = () => {
  dlg.innerHTML = `
    <form>
      <h2>Rename character</h2>
      <div class="field"><label for="r_name">Name</label><input id="r_name" name="name" type="text" maxlength="60" value="${esc(name)}" required autofocus></div>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`;
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call(`account/characters/${id}`, { method: "PUT", body: { name: new FormData(e.target).get("name") }, acct: acct.token });
      dlg.close();
      await loadName();
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
};
window.__started = true;
