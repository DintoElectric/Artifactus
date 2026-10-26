import { esc, uid } from "./common.js";

/* Character sheet (5th edition layout). Everything is saved through the same SheetStore as the
   spells and notes. Modifiers, saves, skills and spell numbers are worked out from what's typed. */

export const ABIL = [["str", "Strength"], ["dex", "Dexterity"], ["con", "Constitution"], ["int", "Intelligence"], ["wis", "Wisdom"], ["cha", "Charisma"]];
export const SKILLS = [
  ["acrobatics", "Acrobatics", "dex"], ["animal", "Animal Handling", "wis"], ["arcana", "Arcana", "int"], ["athletics", "Athletics", "str"],
  ["deception", "Deception", "cha"], ["history", "History", "int"], ["insight", "Insight", "wis"], ["intimidation", "Intimidation", "cha"],
  ["investigation", "Investigation", "int"], ["medicine", "Medicine", "wis"], ["nature", "Nature", "int"], ["perception", "Perception", "wis"],
  ["performance", "Performance", "cha"], ["persuasion", "Persuasion", "cha"], ["religion", "Religion", "int"], ["sleight", "Sleight of Hand", "dex"],
  ["stealth", "Stealth", "dex"], ["survival", "Survival", "wis"],
];
const PROF_LABEL = ["not proficient", "proficient", "expertise"];
const PROF_MARK = ["○", "●", "◉"];

export const blankChar = () => ({
  info: { class: "", race: "", background: "", alignment: "", player: "", xp: "", level: 1 },
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  saves: { str: false, dex: false, con: false, int: false, wis: false, cha: false },
  skills: {},
  combat: { ac: 10, speed: "30 ft", initMisc: 0, hitDice: "", deathS: 0, deathF: 0, inspiration: false, tempHp: 0 },
  cast: "",
  attacks: [],
  text: { features: "", profs: "", traits: "", ideals: "", bonds: "", flaws: "", backstory: "" },
  coins: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
});

/* Make sure a sheet has every field (older sheets saved before this existed won't). */
export function charOf(d) {
  const b = blankChar();
  const c = d.char && typeof d.char === "object" ? d.char : (d.char = {});
  // Fill in anything missing, but never replace an object that already exists: callers hold references to them.
  for (const k of Object.keys(b)) {
    if (Array.isArray(b[k])) { if (!Array.isArray(c[k])) c[k] = []; }
    else if (typeof b[k] === "object") {
      if (!c[k] || typeof c[k] !== "object") c[k] = {};
      for (const kk of Object.keys(b[k])) if (c[k][kk] === undefined) c[k][kk] = b[k][kk];
    } else if (c[k] === undefined) c[k] = b[k];
  }
  return c;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const mod = (score) => Math.floor(((Number(score) || 10) - 10) / 2);
export const profBonus = (level) => 2 + Math.floor((clamp(Number(level) || 1, 1, 20) - 1) / 4);
const sg = (n) => (n >= 0 ? "+" : "−") + Math.abs(n);

function calc(key, c) {
  const P = profBonus(c.info.level);
  const [type, k] = key.split(":");
  switch (type) {
    case "prof": return sg(P);
    case "mod": return sg(mod(c.abilities[k]));
    case "save": return sg(mod(c.abilities[k]) + (c.saves[k] ? P : 0));
    case "skill": {
      const s = SKILLS.find((x) => x[0] === k);
      return sg(mod(c.abilities[s[2]]) + P * (c.skills[k] || 0));
    }
    case "init": return sg(mod(c.abilities.dex) + c.combat.initMisc);
    case "passive": return String(10 + mod(c.abilities.wis) + P * (c.skills.perception || 0));
    case "dc": return c.cast ? String(8 + P + mod(c.abilities[c.cast])) : "—";
    case "atk": return c.cast ? sg(P + mod(c.abilities[c.cast])) : "—";
    default: return "";
  }
}

function setPath(d, path, val) {
  const parts = path.split(".");
  let o = charOf(d);
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = val;
}

const TYPING = "input[type=text],input[type=number],textarea,select";
const typingIn = (root) => root.contains(document.activeElement) && document.activeElement.matches(TYPING);
const STATUS = { saved: "Saved", saving: "Saving…", error: "Offline, retrying…", auth: "Log in again" };

/* hp: optional { get() -> {hp, maxHp, pending}, set(hp, maxHp) -> Promise<string> }. Players use it to
   send HP changes to the DM. The DM edits HP from the initiative list, so passes nothing. */
export function mountChar(root, store, { hp = null } = {}) {
  const open = new Set(["basics", "combat", "abilities"]);
  let hpMsg = "";

  const text = (label, path, val, extra = "") =>
    `<label class="cf"><span>${label}</span><input type="text" data-p="${path}" value="${esc(val)}" ${extra}></label>`;
  const number = (label, path, val, min, max) =>
    `<label class="cf"><span>${label}</span><input type="number" inputmode="numeric" data-p="${path}" data-t="num" data-min="${min}" data-max="${max}" value="${val}"></label>`;
  const area = (label, path, val, rows, max) =>
    `<label class="cf wide"><span>${label}</span><textarea data-p="${path}" rows="${rows}" maxlength="${max}">${esc(val)}</textarea></label>`;
  const calcSpan = (k) => `<b data-calc="${k}"></b>`;
  const section = (id, title, body) =>
    `<details class="csec" data-sec="${id}" ${open.has(id) ? "open" : ""}><summary>${title}</summary><div class="cbody">${body}</div></details>`;
  const pips = (key, n) => [0, 1, 2].map((i) =>
    `<button type="button" class="pip ${n > i ? "" : "used"}" data-act="ds" data-k="${key}" data-i="${i}"
      aria-label="${key === "deathS" ? "Death save success" : "Death save failure"} ${i + 1}, ${n > i ? "marked" : "empty"}" aria-pressed="${n > i}"></button>`).join("");

  const hpHTML = () => {
    if (!hp) return "";
    const h = hp.get();
    return `<div class="hpbox" data-hp>
      <div class="hpnum"><b>${h.hp ?? "?"}</b><span>/ ${h.maxHp ?? "?"} HP</span>${h.pending ? "<small>sending to your DM…</small>" : ""}</div>
      <div class="row">
        <input type="number" inputmode="numeric" min="0" data-f="hpamt" placeholder="Amount" aria-label="HP amount">
        <button class="btn danger" type="button" data-act="dmg">Damage</button>
        <button class="btn" type="button" data-act="heal">Heal</button>
      </div>
      <details class="hpset"><summary>Set HP directly</summary>
        <div class="row"><input type="number" inputmode="numeric" data-f="hpset" placeholder="Current" aria-label="Current HP" value="${h.hp ?? ""}">
        <input type="number" inputmode="numeric" data-f="hpmax" placeholder="Max" aria-label="Maximum HP" value="${h.maxHp ?? ""}">
        <button class="btn" type="button" data-act="sethp">Set</button></div>
      </details>
      <p class="msg" role="status">${esc(hpMsg)}</p>
    </div>`;
  };

  function render(force) {
    if (!force && typingIn(root)) return;
    const c = charOf(store.view);
    const i = c.info, cb = c.combat;

    const basics = `<div class="cgrid">
      ${text("Class", "info.class", i.class, 'maxlength="40"')}
      ${number("Level", "info.level", i.level, 1, 20)}
      ${text("Race", "info.race", i.race, 'maxlength="40"')}
      ${text("Background", "info.background", i.background, 'maxlength="40"')}
      ${text("Alignment", "info.alignment", i.alignment, 'maxlength="40"')}
      ${text("Experience", "info.xp", i.xp, 'maxlength="20"')}
      ${text("Player name", "info.player", i.player, 'maxlength="40"')}
    </div>`;

    const combat = `${hpHTML()}
      <div class="cgrid">
        ${number("Armor class", "combat.ac", cb.ac, 0, 40)}
        ${text("Speed", "combat.speed", cb.speed, 'maxlength="30"')}
        ${number("Initiative bonus", "combat.initMisc", cb.initMisc, -10, 20)}
        ${number("Temp HP", "combat.tempHp", cb.tempHp, 0, 999)}
        ${text("Hit dice", "combat.hitDice", cb.hitDice, 'maxlength="30" placeholder="e.g. 3d8"')}
      </div>
      <div class="cstats">
        <div><span>Initiative</span>${calcSpan("init")}</div>
        <div><span>Proficiency</span>${calcSpan("prof")}</div>
        <div><span>Passive Perception</span>${calcSpan("passive")}</div>
      </div>
      <label class="check"><input type="checkbox" data-p="combat.inspiration" data-t="bool" ${cb.inspiration ? "checked" : ""}> Inspiration</label>
      <div class="deaths"><span>Death saves</span>
        <span class="dpips"><small>Successes</small>${pips("deathS", cb.deathS)}</span>
        <span class="dpips"><small>Failures</small>${pips("deathF", cb.deathF)}</span>
      </div>`;

    const abilities = `<div class="abils">${ABIL.map(([k, name]) => `
      <div class="abil">
        <label class="cf"><span>${name}</span>
          <input type="number" inputmode="numeric" data-p="abilities.${k}" data-t="num" data-min="1" data-max="30" value="${c.abilities[k]}"></label>
        <div class="amod">${calcSpan("mod:" + k)}</div>
        <label class="check"><input type="checkbox" data-p="saves.${k}" data-t="bool" ${c.saves[k] ? "checked" : ""}> Save ${calcSpan("save:" + k)}</label>
      </div>`).join("")}</div>`;

    const skills = `<div class="skills">${SKILLS.map(([k, name, ab]) => {
      const lv = c.skills[k] || 0;
      return `<div class="skill">
        <button type="button" class="pipbtn" data-act="skill" data-k="${k}" aria-label="${name}: ${PROF_LABEL[lv]}. Tap to change">${PROF_MARK[lv]}</button>
        <span class="sk">${name} <small>${ab.toUpperCase()}</small></span>${calcSpan("skill:" + k)}
      </div>`;
    }).join("")}</div><p class="hint">Tap the circle to cycle: not proficient, proficient, expertise.</p>`;

    const attacks = `${c.attacks.map((a) => `
      <div class="atk" data-id="${a.id}">
        <input type="text" data-a="name" value="${esc(a.name)}" placeholder="Attack" maxlength="40" aria-label="Attack name">
        <input type="text" data-a="bonus" value="${esc(a.bonus)}" placeholder="+5" maxlength="10" aria-label="Attack bonus">
        <input type="text" data-a="damage" value="${esc(a.damage)}" placeholder="1d8+3 slashing" maxlength="40" aria-label="Damage">
        <button class="x" type="button" data-act="delatk" aria-label="Remove attack">×</button>
      </div>`).join("")}
      ${c.attacks.length < 12 ? '<button class="btn small" type="button" data-act="addatk">Add attack</button>' : ""}`;

    const casting = `<div class="cgrid">
        <label class="cf"><span>Spellcasting ability</span>
          <select data-p="cast" data-t="text"><option value="">None</option>${ABIL.map(([k, n]) =>
            `<option value="${k}" ${c.cast === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      </div>
      <div class="cstats"><div><span>Spell save DC</span>${calcSpan("dc")}</div><div><span>Spell attack</span>${calcSpan("atk")}</div></div>
      <p class="hint">Your slots and known spells are under Spells.</p>`;

    const feats = `${area("Features and traits", "text.features", c.text.features, 6, 3000)}
      ${area("Proficiencies and languages", "text.profs", c.text.profs, 4, 1500)}`;
    const story = `${area("Personality traits", "text.traits", c.text.traits, 2, 600)}
      ${area("Ideals", "text.ideals", c.text.ideals, 2, 600)}
      ${area("Bonds", "text.bonds", c.text.bonds, 2, 600)}
      ${area("Flaws", "text.flaws", c.text.flaws, 2, 600)}
      ${area("Backstory", "text.backstory", c.text.backstory, 6, 4000)}`;
    const coins = `<div class="cgrid coins">${["cp", "sp", "ep", "gp", "pp"].map((k) =>
      number(k.toUpperCase(), "coins." + k, c.coins[k], 0, 9999999)).join("")}</div>`;

    root.innerHTML = `
      <div class="bookhead"><h3>Character sheet</h3><span class="sync" data-status>${STATUS[store.status]}</span></div>
      ${section("basics", "Basics", basics)}
      ${section("combat", "Hit points and combat", combat)}
      ${section("abilities", "Abilities and saving throws", abilities)}
      ${section("skills", "Skills", skills)}
      ${section("attacks", "Attacks", attacks)}
      ${section("casting", "Spellcasting", casting)}
      ${section("feats", "Features and proficiencies", feats)}
      ${section("story", "Personality and backstory", story)}
      ${section("coins", "Coins", coins)}`;
    updateDerived();
  }

  function updateDerived() {
    const c = charOf(store.view);
    root.querySelectorAll("[data-calc]").forEach((el) => { el.textContent = calc(el.dataset.calc, c); });
  }

  store.subscribe(() => {
    const s = root.querySelector("[data-status]");
    if (s) s.textContent = STATUS[store.status];
    if (typingIn(root)) updateDerived();
    else render();
  });

  root.addEventListener("toggle", (e) => {
    const sec = e.target.dataset?.sec;
    if (!sec) return;
    e.target.open ? open.add(sec) : open.delete(sec);
  }, true);

  const read = (el) => {
    if (el.dataset.t === "bool") return el.checked;
    if (el.dataset.t === "num") {
      const n = parseInt(el.value);
      return Number.isFinite(n) ? clamp(n, Number(el.dataset.min), Number(el.dataset.max)) : null;
    }
    return el.value;
  };

  const onEdit = (e) => {
    const el = e.target;
    if (el.dataset.p) {
      const path = el.dataset.p;
      const val = read(el);
      if (val === null) return;   // blank number box while the player is still typing
      store.mutate((d) => setPath(d, path, val), { key: "c:" + path, delay: el.type === "checkbox" || el.tagName === "SELECT" ? 150 : 600 });
    } else if (el.dataset.a) {
      const id = el.closest("[data-id]").dataset.id, f = el.dataset.a, v = el.value;
      store.mutate((d) => { const a = charOf(d).attacks.find((x) => x.id === id); if (a) a[f] = v; }, { key: `a:${id}:${f}`, delay: 600 });
    }
  };
  root.addEventListener("input", (e) => { if (e.target.type !== "checkbox" && e.target.tagName !== "SELECT") onEdit(e); });
  root.addEventListener("change", (e) => { if (e.target.type === "checkbox" || e.target.tagName === "SELECT") onEdit(e); });

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "skill") {
      const k = b.dataset.k;
      store.mutate((d) => { const s = charOf(d).skills; s[k] = ((s[k] || 0) + 1) % 3; if (!s[k]) delete s[k]; });
    } else if (act === "ds") {
      const k = b.dataset.k, i = Number(b.dataset.i);
      store.mutate((d) => { const cb = charOf(d).combat; cb[k] = cb[k] > i ? i : i + 1; });
    } else if (act === "addatk") {
      store.mutate((d) => { charOf(d).attacks.push({ id: uid(), name: "", bonus: "", damage: "" }); });
    } else if (act === "delatk") {
      const id = b.closest("[data-id]").dataset.id;
      store.mutate((d) => { const c = charOf(d); c.attacks = c.attacks.filter((a) => a.id !== id); });
    } else if (hp && (act === "dmg" || act === "heal" || act === "sethp")) {
      hpAction(act);
    }
  });

  async function hpAction(act) {
    const h = hp.get();
    const amt = Math.abs(parseInt(root.querySelector('[data-f="hpamt"]')?.value)) || 0;
    let nextHp = h.hp, nextMax = null, text = "";
    if (act === "sethp") {
      const cur = parseInt(root.querySelector('[data-f="hpset"]').value);
      const mx = parseInt(root.querySelector('[data-f="hpmax"]').value);
      if (Number.isFinite(cur)) nextHp = Math.max(0, cur);
      if (Number.isFinite(mx)) nextMax = Math.max(1, mx);
    } else if (amt) {
      const base = h.hp ?? h.maxHp ?? 0;
      if (act === "dmg") {
        const temp = charOf(store.view).combat.tempHp;
        const soak = Math.min(temp, amt);
        if (soak) store.mutate((d) => { charOf(d).combat.tempHp = Math.max(0, charOf(d).combat.tempHp - soak); });
        nextHp = Math.max(0, base - (amt - soak));
        text = soak ? `${soak} absorbed by temp HP. ` : "";
      } else {
        nextHp = h.maxHp != null ? Math.min(h.maxHp, base + amt) : base + amt;
      }
    } else return;
    if (nextHp == null) nextHp = 0;
    hpMsg = text + (await hp.set(nextHp, nextMax));
    refresh();
  }

  function refresh() {
    const el = root.querySelector("[data-hp]");
    if (!el || !hp || (el.contains(document.activeElement) && document.activeElement.matches(TYPING))) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = hpHTML();
    const fresh = tmp.firstElementChild;
    const wasOpen = el.querySelector(".hpset")?.open;
    el.replaceWith(fresh);
    if (wasOpen) fresh.querySelector(".hpset").open = true;
  }

  render(true);
  return { refresh };
}
