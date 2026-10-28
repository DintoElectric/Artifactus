import { esc, uid } from "./common.js";
import { blankStats } from "./campaign.js";
import { mod } from "./charsheet.js";

/* The DM's prep for one session. Everything here is private to the DM.
   mountPlan(container, plan, opts) draws the editor into `container` and edits `plan` in place.
   opts: { touch(), toast(msg), ask(html, onSubmit), addToMap(spec), getLocations(), goToLocation(id) } */

const BEAT_KINDS = [["scene", "Scene"], ["combat", "Combat"], ["social", "Social"], ["explore", "Exploration"], ["puzzle", "Puzzle or trap"], ["reveal", "Reveal"]];
const DIALOGUE_KINDS = [["read", "Read aloud"], ["say", "NPC says"], ["option", "Player option"], ["other", "Other"]];
const ABIL = ["str", "dex", "con", "int", "wis", "cha"];
const sg = (n) => (n >= 0 ? "+" : "−") + Math.abs(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* Which sections are open. Remembered as you move between sessions. */
const openSections = new Set(["overview", "beats"]);

const SECTIONS = [
  { key: "overview", title: "Overview and strong start" },
  { key: "beats", title: "Beats and scenes", add: "Add a beat", blank: () => ({ id: uid(), text: "", kind: "scene", note: "", done: false }) },
  { key: "secrets", title: "Secrets and clues", add: "Add a secret or clue", blank: () => ({ id: uid(), text: "", done: false }) },
  { key: "places", title: "Locations", add: "Add a place", blank: () => ({ id: uid(), name: "", notes: "", locId: "" }) },
  { key: "npcs", title: "NPCs", add: "Add an NPC", blank: () => ({ id: uid(), name: "", role: "", wants: "", secret: "", voice: "", notes: "" }) },
  { key: "dialogue", title: "Dialogue and read-aloud text", add: "Add dialogue", blank: () => ({ id: uid(), kind: "say", who: "", text: "" }) },
  { key: "enemies", title: "Enemies and stat blocks", add: "Add a stat block", blank: () => blankStats() },
  { key: "rewards", title: "Rewards and loot", add: "Add a reward", blank: () => ({ id: uid(), text: "", done: false }) },
  { key: "notes", title: "Contingencies and notes" },
];

function countText(key, plan) {
  const l = plan[key];
  const done = Array.isArray(l) ? l.filter((x) => x.done).length : 0;
  if (key === "beats") return l.length ? `${done}/${l.length} played` : "";
  if (key === "secrets") return l.length ? `${done}/${l.length} revealed` : "";
  if (key === "rewards") return l.length ? `${done}/${l.length} given` : "";
  if (key === "overview") return plan.goal.trim() || plan.strongStart.trim() ? "✓" : "";
  if (key === "notes") return plan.notes.trim() ? "✓" : "";
  return l.length ? String(l.length) : "";
}

export function mountPlan(container, plan, opts) {
  const { touch, toast, ask, addToMap, getLocations, goToLocation } = opts;

  /* ----- small pieces of markup ----- */
  const ta = (f, v, rows, ph, max) => `<textarea data-pf="${f}" rows="${rows}" maxlength="${max}" placeholder="${esc(ph)}" aria-label="${esc(ph)}">${esc(v)}</textarea>`;
  const inp = (f, v, ph, max, extra = "") => `<input type="text" data-pf="${f}" value="${esc(v)}" maxlength="${max}" placeholder="${esc(ph)}" aria-label="${esc(ph)}" ${extra}>`;
  const actions = (extra = "") => `<span class="plact">${extra}
    <button class="x" type="button" data-pmove data-d="-1" aria-label="Move up">↑</button>
    <button class="x" type="button" data-pmove data-d="1" aria-label="Move down">↓</button>
    <button class="x" type="button" data-pdel aria-label="Delete">×</button></span>`;
  const kindOptions = (list, cur) => list.map(([k, l]) => `<option value="${k}" ${cur === k ? "selected" : ""}>${l}</option>`).join("");

  /* ----- one item of each kind ----- */
  const ITEM = {
    beats: (b) => `
      <div class="plrow">
        <label class="check pldone"><input type="checkbox" data-pf="done" ${b.done ? "checked" : ""}><span class="sr">Played</span></label>
        <select data-pf="kind" aria-label="Kind of beat">${kindOptions(BEAT_KINDS, b.kind)}</select>${actions()}
      </div>
      ${ta("text", b.text, 2, "What happens, or what you want to hit", 1500)}
      <details class="plnote" ${b.note ? "open" : ""}><summary>Notes</summary>${ta("note", b.note, 3, "Details, options, how it could go", 3000)}</details>`,

    secrets: (b) => `
      <div class="plrow">
        <label class="check pldone"><input type="checkbox" data-pf="done" ${b.done ? "checked" : ""}><span class="sr">Revealed</span></label>
        ${ta("text", b.text, 2, "A secret or clue, and how the party might find it", 1500)}${actions()}
      </div>`,

    places: (b) => {
      const locs = getLocations?.() || [];
      return `
      <div class="plrow">${inp("name", b.name, "Place name", 80, 'class="plname"')}${actions()}</div>
      <div class="plrow">
        <select data-pf="locId" aria-label="Saved map for this place">
          <option value="">Not linked to a saved map</option>
          ${locs.map((l) => `<option value="${l.id}" ${b.locId === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}
          ${b.locId && !locs.some((l) => l.id === b.locId) ? `<option value="${b.locId}" selected>(map no longer saved)</option>` : ""}
        </select>
        ${b.locId && locs.some((l) => l.id === b.locId) ? '<button class="btn small" type="button" data-pgoto>Go there</button>' : ""}
      </div>
      ${ta("notes", b.notes, 3, "What's here, what to describe, who to meet", 3000)}`;
    },

    npcs: (b) => `
      <div class="plrow">${inp("name", b.name, "Name", 80, 'class="plname"')}${inp("role", b.role, "Who they are (innkeeper, spy...)", 120)}
        ${actions('<button class="btn small" type="button" data-ptomap>Add to map</button>')}</div>
      <div class="plgrid2">
        <label class="cf"><span>Wants</span>${ta("wants", b.wants, 2, "What they want", 1000)}</label>
        <label class="cf"><span>Secret</span>${ta("secret", b.secret, 2, "What they're hiding", 1000)}</label>
        <label class="cf"><span>Voice and manner</span>${ta("voice", b.voice, 2, "How they sound and act", 500)}</label>
        <label class="cf"><span>Notes</span>${ta("notes", b.notes, 2, "Anything else", 3000)}</label>
      </div>`,

    dialogue: (b) => `
      <div class="plrow">
        <select data-pf="kind" aria-label="Kind of line">${kindOptions(DIALOGUE_KINDS, b.kind)}</select>
        ${inp("who", b.who, "Who is speaking (optional)", 80)}${actions()}
      </div>
      ${ta("text", b.text, 3, "What you'll say or read aloud", 3000)}`,

    enemies: (e) => `
      <div class="plrow">${inp("name", e.name, "Creature name", 60, 'class="plname"')}${inp("kind", e.kind, "Medium humanoid, neutral evil", 100)}
        ${actions('<button class="btn small" type="button" data-ptomap>Add to map…</button>')}</div>
      <div class="plgrid">
        <label class="cf"><span>Armor class</span>${inp("ac", e.ac, "15 (leather)", 30)}</label>
        <label class="cf"><span>Hit points</span><input type="number" inputmode="numeric" data-pf="hp" min="0" max="9999" value="${e.hp}"></label>
        <label class="cf"><span>HP dice</span>${inp("hpNote", e.hpNote, "6d8+12", 40)}</label>
        <label class="cf"><span>Speed</span>${inp("speed", e.speed, "30 ft.", 80)}</label>
        <label class="cf"><span>Challenge</span>${inp("cr", e.cr, "1/2", 12)}</label>
        <label class="cf"><span>Usually appear</span><input type="number" inputmode="numeric" data-pf="count" min="1" max="20" value="${e.count || 1}"></label>
      </div>
      <div class="plabil">${ABIL.map((k) => `<label class="cf"><span>${k.toUpperCase()}</span>
        <input type="number" inputmode="numeric" data-pf="abilities.${k}" min="1" max="30" value="${e.abilities[k]}"><em data-mod="${k}">${sg(mod(e.abilities[k]))}</em></label>`).join("")}</div>
      <div class="plgrid2">
        <label class="cf"><span>Saving throws</span>${inp("saves", e.saves, "Dex +4, Wis +2", 120)}</label>
        <label class="cf"><span>Skills</span>${inp("skills", e.skills, "Stealth +6", 200)}</label>
        <label class="cf"><span>Resistances and immunities</span>${inp("resist", e.resist, "Poison", 250)}</label>
        <label class="cf"><span>Senses</span>${inp("senses", e.senses, "Darkvision 60 ft., passive Perception 11", 200)}</label>
        <label class="cf"><span>Languages</span>${inp("languages", e.languages, "Common, Goblin", 200)}</label>
      </div>
      <label class="cf"><span>Traits</span>${ta("traits", e.traits, 3, "Special traits, one per line", 4000)}</label>
      <label class="cf"><span>Actions</span>${ta("actions", e.actions, 4, "Multiattack. Scimitar: +4 to hit, 5 (1d6+2) slashing...", 4000)}</label>
      <label class="cf"><span>Reactions and legendary actions</span>${ta("extra", e.extra, 2, "Optional", 4000)}</label>`,

    rewards: (b) => `
      <div class="plrow">
        <label class="check pldone"><input type="checkbox" data-pf="done" ${b.done ? "checked" : ""}><span class="sr">Given</span></label>
        ${ta("text", b.text, 2, "Gold, an item, a favor, information...", 1000)}${actions()}
      </div>`,
  };

  const itemClass = (key, it) => `plitem ${key === "enemies" ? "stat" : ""} ${it.done ? "done" : ""} ${key === "dialogue" ? "pld-" + it.kind : ""}`;

  function sectionHTML(sec) {
    const body = sec.key === "overview"
      ? `<label class="cf"><span>Goal of the session</span><textarea data-pt="goal" rows="2" maxlength="4000" placeholder="What should happen, or what the party is trying to do">${esc(plan.goal)}</textarea></label>
         <label class="cf"><span>Strong start</span><textarea data-pt="strongStart" rows="3" maxlength="4000" placeholder="How the session opens: the first scene, image, or problem">${esc(plan.strongStart)}</textarea></label>`
      : sec.key === "notes"
      ? `<textarea data-pt="notes" rows="5" maxlength="8000" placeholder="If they go off the rails, spare ideas, things to remember" aria-label="Contingencies and notes">${esc(plan.notes)}</textarea>`
      : `${plan[sec.key].length ? "" : '<p class="hint" style="margin:0">Nothing yet.</p>'}
         ${plan[sec.key].map((it) => `<article class="${itemClass(sec.key, it)}" data-sec="${sec.key}" data-id="${it.id}">${ITEM[sec.key](it)}</article>`).join("")}
         <button class="btn small" type="button" data-padd="${sec.key}">${sec.add}</button>`;
    return `<details class="plsec" id="ps-${sec.key}" data-sec="${sec.key}" ${openSections.has(sec.key) ? "open" : ""}>
      <summary><span>${sec.title}</span><small class="plcount" data-count="${sec.key}">${countText(sec.key, plan)}</small></summary>
      <div class="plbody">${body}</div></details>`;
  }

  const navHTML = () => `<nav class="plannav" aria-label="Plan sections">${SECTIONS.map((s) =>
    `<button type="button" class="plchip" data-pnav="${s.key}">${s.title.split(" and ")[0]}${countText(s.key, plan) ? ` <small data-chipcount="${s.key}">${countText(s.key, plan)}</small>` : ""}</button>`).join("")}</nav>`;

  function render() {
    container.innerHTML = navHTML() + SECTIONS.map(sectionHTML).join("");
  }

  const refreshCounts = () => {
    for (const s of SECTIONS) {
      const t = countText(s.key, plan);
      const el = container.querySelector(`[data-count="${s.key}"]`);
      if (el) el.textContent = t;
      const chip = container.querySelector(`[data-pnav="${s.key}"]`);
      if (chip) { const c = chip.querySelector("[data-chipcount]"); if (c) c.textContent = t; else if (t) chip.insertAdjacentHTML("beforeend", ` <small data-chipcount="${s.key}">${t}</small>`); }
    }
  };

  const find = (sec, id) => plan[sec]?.find((x) => x.id === id);
  const itemOf = (el) => el.closest(".plitem");

  /* ----- typing and ticking ----- */
  container.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.pt) { plan[t.dataset.pt] = t.value; refreshCounts(); touch(); return; }
    const item = itemOf(t);
    if (!item || !t.dataset.pf || t.type === "checkbox" || t.tagName === "SELECT") return;
    const rec = find(item.dataset.sec, item.dataset.id);
    if (!rec) return;
    const f = t.dataset.pf;
    if (f.startsWith("abilities.")) {
      const n = parseInt(t.value);
      if (!Number.isFinite(n)) return;
      const k = f.slice(10);
      rec.abilities[k] = clamp(n, 1, 30);
      const m = item.querySelector(`[data-mod="${k}"]`);
      if (m) m.textContent = sg(mod(rec.abilities[k]));
    } else if (f === "hp" || f === "count") {
      const n = parseInt(t.value);
      if (!Number.isFinite(n)) return;
      rec[f] = f === "hp" ? clamp(n, 0, 9999) : clamp(n, 1, 20);
    } else rec[f] = t.value;
    touch();
  });

  container.addEventListener("change", (e) => {
    const t = e.target;
    const item = itemOf(t);
    if (!item || !t.dataset.pf) return;
    if (t.type !== "checkbox" && t.tagName !== "SELECT") return;
    const rec = find(item.dataset.sec, item.dataset.id);
    if (!rec) return;
    const f = t.dataset.pf;
    if (t.type === "checkbox") {
      rec[f] = t.checked;
      item.classList.toggle("done", t.checked);
      refreshCounts();
    } else {
      rec[f] = t.value;
      if (item.dataset.sec === "dialogue") item.className = itemClass("dialogue", rec);
      if (f === "locId") render();   // shows or hides the "Go there" button
    }
    touch();
  });

  container.addEventListener("toggle", (e) => {
    const sec = e.target.dataset?.sec;
    if (!sec || !e.target.classList.contains("plsec")) return;
    e.target.open ? openSections.add(sec) : openSections.delete(sec);
  }, true);

  /* ----- adding, moving, deleting ----- */
  container.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-pnav]");
    if (nav) {
      const d = container.querySelector(`#ps-${nav.dataset.pnav}`);
      if (d) { d.open = true; d.scrollIntoView?.({ block: "start", behavior: "smooth" }); }
      return;
    }
    const add = e.target.closest("[data-padd]");
    if (add) {
      const sec = SECTIONS.find((s) => s.key === add.dataset.padd);
      const item = sec.blank();
      plan[sec.key].push(item);
      openSections.add(sec.key);
      touch();
      render();
      container.querySelector(`[data-id="${item.id}"] [data-pf]:not([type="checkbox"]):not(select)`)?.focus();
      return;
    }
    const item = itemOf(e.target);
    if (!item) return;
    const sec = item.dataset.sec, list = plan[sec], i = list.findIndex((x) => x.id === item.dataset.id);
    if (i < 0) return;

    const mv = e.target.closest("[data-pmove]");
    if (mv) {
      const j = i + Number(mv.dataset.d);
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      touch();
      render();
      return;
    }
    const del = e.target.closest("[data-pdel]");
    if (del) {
      if (del.dataset.armed) { list.splice(i, 1); touch(); render(); return; }   // second tap: really delete
      del.dataset.armed = "1";
      del.textContent = "Delete?";
      del.classList.add("armed");
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "×"; del.classList.remove("armed"); } }, 3000);
      return;
    }
    if (e.target.closest("[data-pgoto]")) { if (list[i].locId) goToLocation?.(list[i].locId); return; }
    if (e.target.closest("[data-ptomap]")) toMap(sec, list[i]);
  });

  /* ----- onto the map ----- */
  function toMap(sec, rec) {
    if (!rec.name.trim()) { toast("Give it a name first."); return; }
    if (sec === "npcs") {
      const n = addToMap?.({ name: rec.name.trim(), type: "npc", count: 1 });
      toast(n ? `${rec.name.trim()} is on the map.` : "Couldn't add it to the map.");
      return;
    }
    const dex = mod(rec.abilities.dex);
    ask(`
      <form>
        <h2>Add ${esc(rec.name.trim())} to the map</h2>
        <div class="field"><label for="pm_n">How many</label><input id="pm_n" name="count" type="number" min="1" max="20" value="${rec.count || 1}" autofocus></div>
        <label class="check field"><input type="checkbox" name="init" checked> Add to the initiative list (${sg(dex)} for Dexterity)</label>
        <label class="check field"><input type="checkbox" name="hidden"> Hidden from players until I show them</label>
        <p class="hint">Each one starts with ${rec.hp || "no"} hit points.</p>
        <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Add to map</button></div>
      </form>`,
      (d, close) => {
        const count = clamp(parseInt(d.count) || 1, 1, 20);
        const n = addToMap?.({ name: rec.name.trim(), type: "enemy", count, hp: rec.hp || null, maxHp: rec.hp || null, initMod: dex, hidden: d.hidden === "on", toInit: d.init === "on" });
        close();
        toast(n ? `${count} ${rec.name.trim()} added to the map.` : "Couldn't add it to the map.");
      });
  }

  render();
}
