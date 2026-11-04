import { esc, TYPES } from "./common.js";
import { cardHTML } from "./creatures.js";
import { ABIL, SKILLS, mod, profBonus, charOf } from "./charsheet.js";

/* The stat blocks shown beside the initiative tracker in the combat window.
   Enemies and NPCs show their stat block from the NPCs & Enemies library, players show a card made from their character
   sheet, and anyone without a linked stat block gets a small card with a way to link one. */

const sg = (n) => (n >= 0 ? "+" : "−") + Math.abs(n);
const ord = (n) => ["", "1st", "2nd", "3rd"][n] || `${n}th`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* A player's character as a stat block. */
export function pcCardHTML(e, sheet) {
  if (!sheet) {
    return `<article class="statcard pc"><p class="sc-sub">No character sheet yet</p><p class="hint" style="margin:.2rem 0 0">It shows up here once the player starts filling theirs in.</p></article>`;
  }
  const line = (label, v) => (String(v ?? "").trim() ? `<p class="sc-line"><b>${label}</b> ${esc(String(v))}</p>` : "");
  const c = charOf(JSON.parse(JSON.stringify(sheet)));   // a copy: charOf fills in anything missing
  const P = profBonus(c.info.level);
  const save = (k) => mod(c.abilities[k]) + (c.saves[k] ? P : 0);
  const skill = (s) => mod(c.abilities[s[2]]) + P * (c.skills[s[0]] || 0);
  const passive = 10 + mod(c.abilities.wis) + P * (c.skills.perception || 0);
  const init = mod(c.abilities.dex) + (Number(c.combat.initMisc) || 0);
  const saves = ABIL.filter(([k]) => c.saves[k]).map(([k]) => `${k.toUpperCase()} ${sg(save(k))}`).join(", ");
  const skills = SKILLS.filter((s) => c.skills[s[0]]).map((s) => `${s[1]} ${sg(skill(s))}${c.skills[s[0]] === 2 ? " ◉" : ""}`).join(", ");
  const slots = Object.keys(sheet.slots || {}).map(Number).filter((l) => sheet.slots[l]?.max > 0).sort((a, b) => a - b)
    .map((l) => `${ord(l)} ${Math.max(0, sheet.slots[l].max - (sheet.slots[l].used || 0))}/${sheet.slots[l].max}`).join(" · ");
  const attacks = c.attacks.filter((a) => String(a.name).trim()).map((a) => `<li><b>${esc(a.name)}</b> ${esc([a.bonus, a.damage].filter((x) => String(x).trim()).join(" · "))}</li>`).join("");
  const who = [c.info.level ? `Level ${c.info.level}` : "", c.info.race, c.info.class].filter((x) => String(x).trim()).join(" ");
  return `<article class="statcard pc">
    <p class="sc-sub">${esc(who || "Player character")}${String(c.info.player).trim() ? ` · played by ${esc(c.info.player)}` : ""}</p>
    <hr>
    ${line("Armor Class", c.combat.ac)}${line("Speed", c.combat.speed)}${line("Initiative", sg(init))}${line("Proficiency", sg(P))}${line("Passive Perception", passive)}
    ${Number(c.combat.tempHp) > 0 ? line("Temporary HP", c.combat.tempHp) : ""}
    <hr>
    <div class="sc-abil">${ABIL.map(([k]) => `<div><b>${k.toUpperCase()}</b><span>${c.abilities[k]} (${sg(mod(c.abilities[k]))})</span></div>`).join("")}</div>
    <hr>
    ${line("Saving Throws", saves)}${line("Skills", skills)}
    ${c.cast ? line("Spellcasting", `${c.cast.toUpperCase()} · save DC ${8 + P + mod(c.abilities[c.cast])} · attack ${sg(P + mod(c.abilities[c.cast]))}`) : ""}
    ${slots ? line("Spell slots left", slots) : ""}
    ${attacks ? `<h3 class="sc-h">Attacks</h3><ul class="cs-atk">${attacks}</ul>` : ""}
  </article>`;
}

/* A combatant with no stat block of its own: what we know from the token, and a way to link one from the library. */
export function basicCardHTML(e, library) {
  const kind = e.type === "npc" ? "NPC" : e.type === "enemy" ? "Enemy" : e.type === "object" ? "Object" : "Combatant";
  const opts = [...library].sort((a, b) => (a.type === e.type ? 0 : 1) - (b.type === e.type ? 0 : 1) || (a.name || "~").localeCompare(b.name || "~"))
    .map((c) => `<option value="${c.id}">${esc(c.name || "Unnamed")} (${c.type === "npc" ? "NPC" : "enemy"}${c.cr ? `, CR ${esc(c.cr)}` : ""})</option>`).join("");
  return `<article class="statcard ${e.type === "npc" ? "npc" : "enemy"}">
    <p class="sc-sub">${kind}. ${e.cid ? "Its stat block was removed from the library." : "No stat block is linked to this token."}</p>
    ${library.length ? `<div class="cs-link"><select data-linksel aria-label="Stat block to link"><option value="">Link a stat block…</option>${opts}</select><button type="button" class="btn small" data-link>Link</button></div>`
      : '<p class="hint" style="margin:.3rem 0 0">Make one in NPCs &amp; Enemies, then link it here.</p>'}
  </article>`;
}

const hpBlock = (e) => {
  const has = e.hp != null;
  const pct = has ? (e.maxHp ? clamp((e.hp / e.maxHp) * 100, 0, 100) : 100) : 0;
  return `<div class="cs-hp ${has && pct < 25 ? "low" : has && pct < 50 ? "mid" : ""}">
    <span class="cs-hpnum">HP ${has ? e.hp : "—"}${e.maxHp != null ? ` / ${e.maxHp}` : ""}</span>
    ${has ? `<span class="cs-bar"><i style="width:${pct}%"></i></span>` : ""}
    <span class="cs-hpbtns">${has ? '<button type="button" data-hp="-5">−5</button><button type="button" data-hp="-1">−1</button><button type="button" data-hp="1">+1</button><button type="button" data-hp="5">+5</button>' : ""}<button type="button" data-hpdlg>HP…</button></span>
  </div>`;
};

/* mountCombatPanel(el, handlers) draws the panel into `el`. handlers: onMode(mode), onUnpin(), onHp(id, delta), onHpDialog(id), onLink(id, creatureId). */
export function mountCombatPanel(el, h) {
  el.innerHTML = `
    <header class="cs-head">
      <div class="seg mini" role="group" aria-label="Which stat blocks to show">
        <button type="button" data-mode="turn" aria-pressed="true">Follow the turn</button>
        <button type="button" data-mode="all" aria-pressed="false">Everyone</button>
      </div>
      <span class="cs-hint" data-hint></span>
    </header>
    <div class="cs-body" data-body></div>`;
  const body = el.querySelector("[data-body]"), hint = el.querySelector("[data-hint]");
  let lastTurn = null;

  el.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) { h.onMode(m.dataset.mode); return; }
    if (e.target.closest("[data-unpin]")) { h.onUnpin(); return; }
    const card = e.target.closest(".cs-card");
    if (!card) return;
    const hp = e.target.closest("[data-hp]");
    if (hp) { h.onHp(card.dataset.id, Number(hp.dataset.hp)); return; }
    if (e.target.closest("[data-hpdlg]")) { h.onHpDialog(card.dataset.id); return; }
    if (e.target.closest("[data-link]")) { const v = card.querySelector("[data-linksel]").value; if (v) h.onLink(card.dataset.id, v); }
  });

  function cardFor({ it, e }, d, turnId) {
    const c = e.cid ? d.creatures.get(e.cid) : null;
    const inner = e.type === "pc" ? pcCardHTML(e, d.sheets.get(e.id)) : c ? cardHTML(c, { title: false }) : basicCardHTML(e, d.library);
    return `<section class="cs-card ${turnId === e.id ? "turn" : ""} ${e.down ? "down" : ""}" data-id="${e.id}">
      <div class="cs-top">
        <span class="dot" style="--c:${TYPES[e.type]?.color || "#999"}"></span>
        <b class="cs-name">${esc(e.name)}${e.hidden ? " <small>(hidden)</small>" : ""}</b>
        <span class="cs-kind">${e.type === "pc" ? "Player" : e.type === "npc" ? "NPC" : e.type === "enemy" ? "Enemy" : "Object"}</span>
        ${it.init != null ? `<span class="cs-init">Init ${esc(it.init)}</span>` : ""}
      </div>
      ${hpBlock(e)}
      ${inner}
    </section>`;
  }

  return {
    /* d: { ents, init, creatures (Map id -> creature), library (array), sheets (Map id -> sheet), mode, pinnedId } */
    render(d) {
      const byId = new Map(d.ents.map((e) => [e.id, e]));
      const order = d.init.list.map((it) => ({ it, e: byId.get(it.id) })).filter((x) => x.e);
      const turnId = d.init.on ? d.init.turnId : "";
      el.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === d.mode)));

      const ti = order.findIndex((x) => x.e.id === turnId);
      const next = ti >= 0 && order.length > 1 ? order[(ti + 1) % order.length].e.name : "";
      hint.textContent = d.init.on ? `Round ${d.init.round}${ti >= 0 ? ` · ${order[ti].e.name}'s turn` : ""}${next ? ` · next: ${next}` : ""}` : "Combat hasn't started";

      const scroll = body.scrollTop;
      if (!order.length) {
        body.innerHTML = '<div class="empty cs-empty"><h2>Nobody is in the initiative yet</h2><p>Use “Init” on a token, or “Add everyone”, and their stat blocks appear here.</p></div>';
      } else if (d.mode === "all") {
        body.innerHTML = `<div class="cs-grid">${order.map((x) => cardFor(x, d, turnId)).join("")}</div>`;
      } else {
        const showId = d.pinnedId && byId.has(d.pinnedId) && order.some((x) => x.e.id === d.pinnedId) ? d.pinnedId : turnId || order[0].e.id;
        const x = order.find((o) => o.e.id === showId) || order[0];
        const pinned = d.pinnedId && x.e.id === d.pinnedId && x.e.id !== turnId;
        body.innerHTML = `${pinned ? `<div class="cs-pinned">Showing ${esc(x.e.name)}. <button type="button" class="btn small" data-unpin>Follow the turn</button></div>` : ""}
          ${!turnId && !pinned ? '<p class="hint cs-note">Start combat to follow the turn, or click a name in the list to see their card.</p>' : ""}
          ${cardFor(x, d, turnId)}`;
      }
      body.scrollTop = scroll;
      // when the turn moves on, bring that card into view (the Everyone grid can be taller than the window)
      if (d.mode === "all" && turnId && turnId !== lastTurn) body.querySelector(".cs-card.turn")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      lastTurn = turnId;
    },
  };
}
