import { call, esc, uid } from "./common.js";
import { mod } from "./charsheet.js";

/* The DM's library of NPCs and enemies: stat blocks kept for the whole campaign, separate from any one session.
   mountCreatures(root, opts) draws the tab into `root` and returns a small API for the rest of the page.
   opts: { room, pin, toast(msg), addToMap(spec), showTab() } */

const ABIL = ["str", "dex", "con", "int", "wis", "cha"];
const sg = (n) => (n >= 0 ? "+" : "−") + Math.abs(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const STATUS = { saved: "Saved", saving: "Saving…", error: "Couldn't save. Trying again…" };

export const blankCreature = (type = "enemy") => ({
  id: uid(), type, name: "", kind: "", tags: "", role: "", ac: "", hp: 0, hpNote: "", speed: "30 ft.",
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  saves: "", skills: "", resist: "", senses: "", languages: "", cr: "",
  traits: "", actions: "", extra: "", wants: "", secret: "", voice: "", notes: "", count: 1, updated: Date.now(),
});

/* "1/4" and "2" both become numbers so challenge ratings sort properly. No rating sorts last. */
export function crValue(cr) {
  const t = String(cr ?? "").trim();
  if (!t) return Infinity;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : Infinity;
  const n = Number(t);
  return Number.isFinite(n) ? n : Infinity;
}

/* A stat block laid out for reading at the table. */
export function cardHTML(c) {
  const line = (label, v) => (String(v ?? "").trim() ? `<p class="sc-line"><b>${label}</b> ${esc(String(v))}</p>` : "");
  const block = (label, text) => (String(text ?? "").trim() ? `<h3 class="sc-h">${label}</h3><div class="sc-text">${esc(text)}</div>` : "");
  const npc = c.type === "npc";
  const sub = [c.kind, npc ? c.role : ""].filter((x) => String(x).trim()).join(" · ");
  const story = npc && [c.wants, c.secret, c.voice].some((x) => String(x).trim())
    ? `<hr>${block("Wants", c.wants)}${block("Secret", c.secret)}${block("Voice and manner", c.voice)}` : "";
  return `<article class="statcard ${npc ? "npc" : "enemy"}">
    <h2>${esc(c.name || "Unnamed")}</h2>
    ${sub ? `<p class="sc-sub">${esc(sub)}</p>` : ""}
    <hr>
    ${line("Armor Class", c.ac)}${line("Hit Points", c.hp ? `${c.hp}${String(c.hpNote).trim() ? ` (${c.hpNote})` : ""}` : "")}${line("Speed", c.speed)}
    <hr>
    <div class="sc-abil">${ABIL.map((k) => `<div><b>${k.toUpperCase()}</b><span>${c.abilities[k]} (${sg(mod(c.abilities[k]))})</span></div>`).join("")}</div>
    <hr>
    ${line("Saving Throws", c.saves)}${line("Skills", c.skills)}${line("Damage Resistances and Immunities", c.resist)}${line("Senses", c.senses)}${line("Languages", c.languages)}${line("Challenge", c.cr)}
    ${block("Traits", c.traits)}${block("Actions", c.actions)}${block("Bonus actions, reactions and legendary actions", c.extra)}
    ${story}
    ${block(npc ? "Notes" : "Tactics and notes", c.notes)}
  </article>`;
}

export function mountCreatures(root, { room, pin, toast, addToMap, showTab }) {
  let doc = null, selId = "", filter = "all", query = "", sort = "name";
  let status = "saved", saving = false, dirty = false, timer = null, loadPromise = null, loadError = "";

  root.innerHTML = `
    <div class="crea">
      <header class="camphead">
        <div class="seg mini" role="group" aria-label="Show">
          <button type="button" data-filter="all" aria-pressed="true">All</button>
          <button type="button" data-filter="npc" aria-pressed="false">NPCs</button>
          <button type="button" data-filter="enemy" aria-pressed="false">Enemies</button>
        </div>
        <input type="search" class="creasearch" data-q placeholder="Search name or tags" aria-label="Search the library">
        <select data-sort aria-label="Sort by" style="width:auto;min-height:36px">
          <option value="name">A to Z</option><option value="cr">Challenge</option><option value="recent">Recently edited</option>
        </select>
        <span class="grow"></span>
        <span class="sync" data-status>Saved</span>
        <button class="btn small primary" type="button" data-act="new-npc">New NPC</button>
        <button class="btn small primary" type="button" data-act="new-enemy">New enemy</button>
      </header>
      <div class="creabody">
        <aside class="crealist" data-list aria-label="NPCs and enemies"></aside>
        <section class="creaedit" data-edit></section>
      </div>
    </div>`;
  const listEl = root.querySelector("[data-list]"), editEl = root.querySelector("[data-edit]");
  // The card and the add-to-map question can be opened from other tabs (a token's Stats button), where this tab is hidden and
  // a pop-up inside it wouldn't show. So the pop-up lives at the top of the page instead.
  const doc0 = root.ownerDocument;
  doc0.querySelectorAll("dialog[data-crea-dlg]").forEach((d) => d.remove());
  const dlg = doc0.createElement("dialog");
  dlg.className = "campdlg";
  dlg.setAttribute("data-crea-dlg", "");
  doc0.body.appendChild(dlg);

  /* ----- saving ----- */
  const setStatus = (s) => { status = s; root.querySelector("[data-status]").textContent = STATUS[s]; };
  function touch() {
    dirty = true;
    setStatus("saving");
    clearTimeout(timer);
    timer = setTimeout(flush, 800);
  }
  async function flush() {
    if (saving || !dirty || !doc) return;
    saving = true; dirty = false;
    let failed = false;
    try {
      const r = await call(`bestiary/${room}`, { method: "PUT", body: { doc }, pin });
      doc.rev = r.rev;
      if (!dirty) setStatus("saved");
    } catch {
      failed = true; dirty = true;
      setStatus("error");
    } finally {
      saving = false;
      if (dirty) { clearTimeout(timer); timer = setTimeout(flush, failed ? 2500 : 200); }
    }
  }
  window.addEventListener("beforeunload", (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } });

  /* ----- the list ----- */
  const current = () => doc?.creatures.find((c) => c.id === selId);
  function visible() {
    const q = query.trim().toLowerCase();
    const list = doc.creatures.filter((c) => (filter === "all" || c.type === filter)
      && (!q || [c.name, c.kind, c.tags, c.role].some((t) => String(t).toLowerCase().includes(q))));
    const byName = (a, b) => (a.name || "~").localeCompare(b.name || "~", undefined, { sensitivity: "base" });
    if (sort === "cr") list.sort((a, b) => crValue(a.cr) - crValue(b.cr) || byName(a, b));
    else if (sort === "recent") list.sort((a, b) => b.updated - a.updated || byName(a, b));
    else list.sort(byName);
    return list;
  }
  const metaLine = (c) => [c.cr && `CR ${c.cr}`, c.ac && `AC ${c.ac}`, c.hp && `HP ${c.hp}`].filter(Boolean).join(" · ");

  function renderList() {
    if (!doc) { listEl.innerHTML = loadError ? `<p class="empty">${esc(loadError)} <button class="btn small" data-act="retry" type="button">Try again</button></p>` : '<p class="empty">Loading…</p>'; return; }
    const list = visible();
    listEl.innerHTML = list.map((c) => `<button type="button" class="crow ${c.id === selId ? "sel" : ""}" data-id="${c.id}">
      <span class="cname">${esc(c.name || "Unnamed")}</span><span class="ctype ${c.type}">${c.type === "npc" ? "NPC" : "Enemy"}</span>
      ${metaLine(c) ? `<small>${esc(metaLine(c))}</small>` : ""}</button>`).join("")
      || `<p class="empty">${doc.creatures.length ? "Nothing matches that." : "No NPCs or enemies yet. Add your first one."}</p>`;
  }

  /* ----- the editor ----- */
  const inp = (f, v, ph, max, extra = "") => `<input type="text" data-cf="${f}" value="${esc(v)}" maxlength="${max}" placeholder="${esc(ph)}" aria-label="${esc(ph)}" ${extra}>`;
  const ta = (f, v, rows, ph, max) => `<textarea data-cf="${f}" rows="${rows}" maxlength="${max}" placeholder="${esc(ph)}" aria-label="${esc(ph)}">${esc(v)}</textarea>`;

  function editHTML(c) {
    const npc = c.type === "npc";
    return `
      <div class="plrow creahead">
        ${inp("name", c.name, npc ? "NPC name" : "Creature name", 60, 'class="plname"')}
        <select data-cf="type" aria-label="NPC or enemy" style="width:auto"><option value="npc" ${npc ? "selected" : ""}>NPC</option><option value="enemy" ${npc ? "" : "selected"}>Enemy</option></select>
        <label class="cf crcr"><span>Challenge</span>${inp("cr", c.cr, "1/2", 12)}</label>
      </div>
      <div class="plrow">${inp("kind", c.kind, "Medium humanoid, neutral good", 100)}${inp("tags", c.tags, "Tags, separated by commas (town, Act 1, goblinoid)", 120)}</div>
      <div class="crea-actions">
        <button class="btn small primary" type="button" data-act="map">Add to map…</button>
        <button class="btn small" type="button" data-act="card">View card</button>
        <button class="btn small" type="button" data-act="dup">Duplicate</button>
        <button class="btn small danger" type="button" data-act="del">Delete</button>
      </div>
      ${npc ? `
      <fieldset class="crea-sec"><legend>Who they are</legend>
        <div class="plrow">${inp("role", c.role, "What they do (innkeeper, spy, captain of the guard...)", 120)}</div>
        <div class="plgrid2">
          <label class="cf"><span>Wants</span>${ta("wants", c.wants, 2, "What they want", 1000)}</label>
          <label class="cf"><span>Secret</span>${ta("secret", c.secret, 2, "What they're hiding", 1000)}</label>
          <label class="cf"><span>Voice and manner</span>${ta("voice", c.voice, 2, "How they sound and act", 500)}</label>
        </div>
      </fieldset>` : ""}
      <fieldset class="crea-sec"><legend>Stat block</legend>
        <div class="plgrid">
          <label class="cf"><span>Armor class</span>${inp("ac", c.ac, "15 (leather)", 30)}</label>
          <label class="cf"><span>Hit points</span><input type="number" inputmode="numeric" data-cf="hp" min="0" max="9999" value="${c.hp}"></label>
          <label class="cf"><span>HP dice</span>${inp("hpNote", c.hpNote, "6d8+12", 40)}</label>
          <label class="cf"><span>Speed</span>${inp("speed", c.speed, "30 ft.", 80)}</label>
          <label class="cf"><span>Usually appear</span><input type="number" inputmode="numeric" data-cf="count" min="1" max="20" value="${c.count || 1}"></label>
        </div>
        <div class="plabil">${ABIL.map((k) => `<label class="cf"><span>${k.toUpperCase()}</span>
          <input type="number" inputmode="numeric" data-cf="abilities.${k}" min="1" max="30" value="${c.abilities[k]}"><em data-mod="${k}">${sg(mod(c.abilities[k]))}</em></label>`).join("")}</div>
        <div class="plgrid2">
          <label class="cf"><span>Saving throws</span>${inp("saves", c.saves, "Dex +4, Wis +2", 120)}</label>
          <label class="cf"><span>Skills</span>${inp("skills", c.skills, "Stealth +6", 200)}</label>
          <label class="cf"><span>Resistances and immunities</span>${inp("resist", c.resist, "Poison", 250)}</label>
          <label class="cf"><span>Senses</span>${inp("senses", c.senses, "Darkvision 60 ft., passive Perception 11", 200)}</label>
          <label class="cf"><span>Languages</span>${inp("languages", c.languages, "Common, Goblin", 200)}</label>
        </div>
        <label class="cf"><span>Traits</span>${ta("traits", c.traits, 3, "Special traits, one per line", 4000)}</label>
        <label class="cf"><span>Actions</span>${ta("actions", c.actions, 4, "Multiattack. Scimitar: +4 to hit, 5 (1d6+2) slashing...", 4000)}</label>
        <label class="cf"><span>Bonus actions, reactions and legendary actions</span>${ta("extra", c.extra, 3, "Optional", 4000)}</label>
      </fieldset>
      <label class="cf"><span>${npc ? "Notes" : "Tactics and notes"}</span>${ta("notes", c.notes, 3, npc ? "Anything else worth remembering" : "How they fight, when they flee, what they carry", 3000)}</label>`;
  }

  function renderEdit() {
    const c = current();
    editEl.innerHTML = c ? editHTML(c) : `<div class="empty creaempty"><h2>${doc?.creatures.length ? "Pick someone from the list" : "Your library is empty"}</h2>
      <p>${doc?.creatures.length ? "Or add a new NPC or enemy." : "Make a stat block for an NPC or an enemy once, then add it to the map whenever you need it."}</p></div>`;
  }

  function render() { renderList(); renderEdit(); }

  function select(id) { selId = id; render(); }

  function addCreature(c, { focus = true } = {}) {
    doc.creatures.push(c);
    selId = c.id;
    touch();
    if (filter !== "all" && filter !== c.type) { filter = "all"; syncFilters(); }
    query = ""; root.querySelector("[data-q]").value = "";
    render();
    if (focus) editEl.querySelector('[data-cf="name"]')?.focus();
    return c;
  }

  function syncFilters() {
    root.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.filter === filter));
  }

  /* ----- header controls ----- */
  root.querySelector(".camphead").addEventListener("click", (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) { filter = f.dataset.filter; syncFilters(); if (doc) renderList(); return; }
    const b = e.target.closest("[data-act]");
    if (!b || !doc) return;
    if (b.dataset.act === "new-npc") addCreature(blankCreature("npc"));
    else if (b.dataset.act === "new-enemy") addCreature(blankCreature("enemy"));
  });
  root.querySelector("[data-q]").addEventListener("input", (e) => { query = e.target.value; if (doc) renderList(); });
  root.querySelector("[data-sort]").addEventListener("change", (e) => { sort = e.target.value; if (doc) renderList(); });

  listEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-act='retry']")) { loadPromise = null; ensureLoaded(); return; }
    const row = e.target.closest("[data-id]");
    if (row) select(row.dataset.id);
  });

  /* ----- typing in the editor ----- */
  editEl.addEventListener("input", (e) => {
    const t = e.target, f = t.dataset.cf, c = current();
    if (!f || !c || t.tagName === "SELECT") return;
    if (f.startsWith("abilities.")) {
      const n = parseInt(t.value);
      if (!Number.isFinite(n)) return;
      const k = f.slice(10);
      c.abilities[k] = clamp(n, 1, 30);
      const m = editEl.querySelector(`[data-mod="${k}"]`);
      if (m) m.textContent = sg(mod(c.abilities[k]));
    } else if (f === "hp" || f === "count") {
      const n = parseInt(t.value);
      if (!Number.isFinite(n)) return;
      c[f] = f === "hp" ? clamp(n, 0, 9999) : clamp(n, 1, 20);
    } else c[f] = t.value;
    c.updated = Date.now();
    if (["name", "cr", "ac", "hp", "kind", "tags", "role"].includes(f)) renderList();
    touch();
  });
  editEl.addEventListener("change", (e) => {
    const t = e.target, c = current();
    if (!c || t.dataset.cf !== "type") return;
    c.type = t.value === "npc" ? "npc" : "enemy";
    c.updated = Date.now();
    touch();
    render();   // NPCs have extra fields
  });

  /* ----- what the buttons do ----- */
  editEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    const c = current();
    if (!b || !c) return;
    switch (b.dataset.act) {
      case "map": askMap(c); break;
      case "card": openCard(c); break;
      case "dup": {
        const copy = { ...JSON.parse(JSON.stringify(c)), id: uid(), name: `${c.name || "Unnamed"} (copy)`, updated: Date.now() };
        addCreature(copy);
        toast?.("Copied. Edit the new one.");
        break;
      }
      case "del":
        if (!b.dataset.armed) {   // first tap asks, second tap deletes
          b.dataset.armed = "1"; b.textContent = "Really delete?";
          setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Delete"; } }, 3000);
        } else {
          const i = doc.creatures.findIndex((x) => x.id === c.id);
          doc.creatures.splice(i, 1);
          const next = visible()[0];
          selId = next ? next.id : "";
          touch();
          render();
        }
        break;
    }
  });

  /* ----- the stat block card, and putting creatures on the map ----- */
  function openCard(c) {
    dlg.innerHTML = `<div class="cardwrap">${cardHTML(c)}
      <div class="dlg-actions"><button type="button" class="btn" data-close>Close</button>
      <button type="button" class="btn" data-edit>Edit</button>
      <button type="button" class="btn primary" data-map>Add to map…</button></div></div>`;
    dlg.querySelector("[data-close]").onclick = () => dlg.close();
    dlg.querySelector("[data-edit]").onclick = () => { dlg.close(); showTab?.(); select(c.id); };
    dlg.querySelector("[data-map]").onclick = () => askMap(c);
    if (!dlg.open) dlg.showModal();
  }

  function askMap(c) {
    if (!c.name.trim()) { toast?.("Give it a name first."); return; }
    const dex = mod(c.abilities.dex);
    dlg.innerHTML = `
      <form>
        <h2>Add ${esc(c.name.trim())} to the map</h2>
        <div class="field"><label for="cm_n">How many</label><input id="cm_n" name="count" type="number" min="1" max="20" value="${c.count || 1}"></div>
        <label class="check field"><input type="checkbox" name="init" checked> Add to the initiative list (${sg(dex)} for Dexterity)</label>
        <label class="check field"><input type="checkbox" name="hidden"> Hidden from players until I show them</label>
        <p class="hint">Each one starts with ${c.hp || "no"} hit points${c.type === "npc" ? " and shows as an NPC" : ""}.</p>
        <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Add to map</button></div>
      </form>`;
    dlg.querySelector("[data-close]").onclick = () => dlg.close();
    dlg.querySelector("form").onsubmit = (ev) => {
      ev.preventDefault();
      const d = Object.fromEntries(new FormData(ev.target));
      const count = clamp(parseInt(d.count) || 1, 1, 20);
      const n = addToMap?.({ name: c.name.trim(), type: c.type, count, hp: c.hp || null, maxHp: c.hp || null, initMod: dex, hidden: d.hidden === "on", toInit: d.init === "on", cid: c.id });
      dlg.close();
      toast?.(n ? `${count} ${c.name.trim()} added to the map.` : "Couldn't add it to the map.");
    };
    if (!dlg.open) dlg.showModal();
  }

  /* ----- loading ----- */
  async function load() {
    try {
      const r = await call(`bestiary/${room}`, { pin });
      doc = { rev: r.doc.rev || 0, creatures: r.doc.creatures || [] };
      loadError = "";
      if (!current()) selId = visible()[0]?.id || "";
    } catch (err) {
      loadError = err.message || "Couldn't load the library.";
      loadPromise = null;
    }
    render();
    return !!doc;
  }
  const ensureLoaded = () => (loadPromise ||= load());

  render();

  /* ----- for the rest of the page ----- */
  return {
    load: ensureLoaded,
    /* Open a creature's stat block card. Resolves to false if it's no longer in the library. */
    async card(id) {
      await ensureLoaded();
      const c = doc?.creatures.find((x) => x.id === id);
      if (!c) return false;
      openCard(c);
      return true;
    },
    async edit(id) { await ensureLoaded(); if (doc?.creatures.some((x) => x.id === id)) { showTab?.(); select(id); return true; } return false; },
    async list() { await ensureLoaded(); return doc ? doc.creatures.map((c) => JSON.parse(JSON.stringify(c))) : []; },
    /* Save a creature to the library (for example from a session plan). Resolves to the saved creature, or null. */
    async add(spec) {
      await ensureLoaded();
      if (!doc) return null;
      const c = { ...blankCreature(spec.type === "npc" ? "npc" : "enemy"), ...JSON.parse(JSON.stringify(spec)), id: uid(), updated: Date.now() };
      c.abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...(spec.abilities || {}) };
      addCreature(c, { focus: false });
      return c;
    },
  };
}
