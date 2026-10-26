import { esc } from "./common.js";

// Fair random integer from 1 to n using the browser's crypto source.
export const rand = (n) => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return 1 + (a[0] % n);
};

const clampInt = (v, lo = -50, hi = 50) => Math.min(hi, Math.max(lo, parseInt(v) || 0));

/* Roll an expression such as "2d6+3", "d20-1" or "4d8+2d6+5". */
export function rollExpr(src) {
  const s = String(src || "").toLowerCase().replace(/\s+/g, "");
  if (!s) throw new Error("Type a roll like 2d6+3.");
  const norm = /^[+-]/.test(s) ? s : "+" + s;
  const terms = norm.match(/[+-][^+-]+/g);
  if (!terms || terms.join("") !== norm || terms.length > 10) throw new Error("Could not read that roll. Try 2d6+3.");
  let total = 0, diceCount = 0;
  const parts = [];
  for (const t of terms) {
    const sign = t[0] === "-" ? -1 : 1;
    const body = t.slice(1);
    const m = body.match(/^(\d*)d(\d+)$/);
    if (m) {
      const n = m[1] === "" ? 1 : parseInt(m[1]);
      const sides = parseInt(m[2]);
      if (n < 1 || n > 50 || sides < 2 || sides > 1000) throw new Error("Use 1 to 50 dice with 2 to 1000 sides.");
      const rolls = Array.from({ length: n }, () => rand(sides));
      const sum = rolls.reduce((a, b) => a + b, 0);
      total += sign * sum;
      diceCount += n;
      parts.push({ sign, label: `${n}d${sides}`, rolls, sides });
    } else if (/^\d+$/.test(body)) {
      total += sign * parseInt(body);
      parts.push({ sign, label: String(parseInt(body)) });
    } else {
      throw new Error("Could not read that roll. Try 2d6+3.");
    }
  }
  if (!diceCount) throw new Error("Include at least one die, like 1d20+2.");
  const first = parts[0];
  const nat = parts.filter((p) => p.rolls).length === 1 && first.rolls?.length === 1 && first.sides === 20 ? first.rolls[0] : null;
  return { total, parts, nat };
}

export function describe(r) {
  return r.parts
    .map((p, i) => {
      const sign = i === 0 ? (p.sign < 0 ? "−" : "") : p.sign < 0 ? " − " : " + ";
      return sign + (p.rolls ? `${p.label} [${p.rolls.join(", ")}]` : p.label);
    })
    .join("");
}

/* d20 with advantage or disadvantage. */
export function rollAdv(mod, mode) {
  const a = rand(20), b = rand(20);
  const pick = mode === "adv" ? Math.max(a, b) : Math.min(a, b);
  const m = mod ? (mod > 0 ? ` + ${mod}` : ` − ${Math.abs(mod)}`) : "";
  return {
    total: pick + mod,
    nat: pick,
    text: `d20 [${a}, ${b}] take ${mode === "adv" ? "higher" : "lower"}${m}`,
  };
}

/* Mounts a dice roller into any element. onRoll receives every result so the page can share it. */
export function mountRoller(root, opts = {}) {
  root.innerHTML = `
    <div class="dice">
      <div class="dice-btns" role="group" aria-label="Roll one die">
        ${[4, 6, 8, 10, 12, 20, 100].map((n) => `<button class="btn" type="button" data-die="${n}">d${n}</button>`).join("")}
      </div>
      <div class="dice-row">
        <label for="dm-mod-${root.id}">Modifier</label>
        <input id="dm-mod-${root.id}" type="number" inputmode="numeric" value="0" data-mod>
        <button class="btn small" type="button" data-adv="adv">Advantage</button>
        <button class="btn small" type="button" data-adv="dis">Disadvantage</button>
      </div>
      <form class="dice-form" data-form autocomplete="off">
        <input type="text" placeholder="2d6+3" aria-label="Dice formula" data-expr maxlength="40">
        <button class="btn primary" type="submit">Roll</button>
      </form>
      <div class="dice-out" aria-live="polite"><small>Tap a die or type a formula.</small></div>
      <ol class="dice-log"></ol>
    </div>`;

  const out = root.querySelector(".dice-out");
  const log = root.querySelector(".dice-log");
  const modEl = root.querySelector("[data-mod]");
  const exprEl = root.querySelector("[data-expr]");
  const history = [];

  const show = (label, total, detail, nat) => {
    out.innerHTML = `<div class="big ${nat === 20 ? "crit" : nat === 1 ? "fumble" : ""}">${total}</div><small>${esc(detail)}</small>`;
    history.unshift({ label, total });
    history.length = Math.min(history.length, 8);
    log.innerHTML = history.map((h) => `<li><span>${esc(h.label)}</span><b>${h.total}</b></li>`).join("");
    opts.onRoll?.({ label, total, detail, nat: nat === 20 || nat === 1 ? nat : null });
  };
  const error = (msg) => { out.innerHTML = `<small class="bad">${esc(msg)}</small>`; };
  const modText = (m) => (m ? (m > 0 ? `+${m}` : `-${Math.abs(m)}`) : "");

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const mod = clampInt(modEl.value);
    if (b.dataset.die) {
      const expr = `1d${b.dataset.die}${modText(mod)}`;
      const r = rollExpr(expr);
      show(expr, r.total, describe(r), r.nat);
    } else if (b.dataset.adv) {
      const r = rollAdv(mod, b.dataset.adv);
      show(`d20 ${b.dataset.adv === "adv" ? "adv" : "dis"}${modText(mod)}`, r.total, r.text, r.nat);
    }
  });

  root.querySelector("[data-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      const r = rollExpr(exprEl.value);
      show(exprEl.value.replace(/\s+/g, ""), r.total, describe(r), r.nat);
    } catch (err) {
      error(err.message);
    }
  });
}
