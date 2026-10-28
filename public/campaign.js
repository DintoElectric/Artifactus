/* Campaign details and the session log.
   The DM edits the whole document. Players only ever receive the parts marked "share". */

export const CAMPAIGN_FIELDS = [
  { key: "overview", label: "Overview", hint: "The big picture of the game in a few sentences.", share: true },
  { key: "premise", label: "Premise", hint: "What the party is here to do, and what is at stake.", share: true },
  { key: "themes", label: "Themes and tone", hint: "For example: found family, dread, heists, humor.", share: true },
  { key: "setting", label: "World and setting", hint: "Places, history, how magic works.", share: true },
  { key: "factions", label: "Factions and key people", hint: "Who matters, what they want, how the party knows them.", share: true },
  { key: "rules", label: "Table rules and safety tools", hint: "House rules, content boundaries, how breaks and veils work.", share: true },
  { key: "notes", label: "Other notes", hint: "Anything else about the game.", share: true },
  { key: "secrets", label: "Secrets and plans (DM only)", hint: "Twists, villain plans, things the players shouldn't see.", share: false },
];

export const SESSION_FIELDS = [
  { key: "recap", label: "Recap", hint: "A short summary of what happened.", share: true },
  { key: "accomplished", label: "What they accomplished", hint: "Quests, fights won, problems solved.", share: true },
  { key: "learned", label: "What they learned", hint: "Clues, lore, secrets uncovered.", share: true },
  { key: "earned", label: "What they earned", hint: "XP, gold, items, favors, reputation.", share: true },
  { key: "npcs", label: "People and places", hint: "Who they met and where they went.", share: true },
  { key: "threads", label: "Open threads and next steps", hint: "What is unresolved, and where they are headed.", share: true },
  { key: "dmnotes", label: "DM notes (private)", hint: "Prep, reminders, things to follow up on.", share: false },
];

const blankField = () => ({ text: "", shared: false });

/* A session plan: prep for the DM's eyes only. It is never part of what players can see. */
export const blankPlan = () => ({ goal: "", strongStart: "", notes: "", beats: [], secrets: [], places: [], npcs: [], dialogue: [], enemies: [], rewards: [] });
export const blankStats = () => ({ id: Math.random().toString(36).slice(2, 9), name: "", kind: "", ac: "", hp: 0, hpNote: "", speed: "30 ft.",
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, saves: "", skills: "", resist: "", senses: "", languages: "", cr: "",
  traits: "", actions: "", extra: "", count: 1 });
export const planCounts = (plan) => ({ beats: plan.beats.length, beatsDone: plan.beats.filter((b) => b.done).length });
export const planHasContent = (p) => !!(p.goal.trim() || p.strongStart.trim() || p.notes.trim() || p.beats.length || p.secrets.length || p.places.length || p.npcs.length || p.dialogue.length || p.enemies.length || p.rewards.length);
export const blankSession = (number = 1) => ({
  id: Math.random().toString(36).slice(2, 9),
  number,
  title: "",
  date: new Date().toISOString().slice(0, 10),
  fields: Object.fromEntries(SESSION_FIELDS.map((f) => [f.key, blankField()])),
  plan: blankPlan(),
});

export const blankDoc = () => ({
  rev: 0,
  campaign: { name: "", fields: Object.fromEntries(CAMPAIGN_FIELDS.map((f) => [f.key, blankField()])) },
  sessions: [],
});

/* Make sure every field exists, so the editor never meets an undefined. */
export function normalizeDoc(doc) {
  const d = doc && typeof doc === "object" ? doc : blankDoc();
  d.campaign ||= { name: "", fields: {} };
  d.campaign.name ||= "";
  d.campaign.fields ||= {};
  for (const f of CAMPAIGN_FIELDS) d.campaign.fields[f.key] ||= blankField();
  d.sessions = Array.isArray(d.sessions) ? d.sessions : [];
  for (const s of d.sessions) {
    s.fields ||= {};
    for (const f of SESSION_FIELDS) s.fields[f.key] ||= blankField();
    // sessions saved before plans existed get an empty plan
    const base = blankPlan();
    s.plan = s.plan && typeof s.plan === "object" ? s.plan : {};
    for (const k of Object.keys(base)) if (typeof base[k] === "string" ? typeof s.plan[k] !== "string" : !Array.isArray(s.plan[k])) s.plan[k] = base[k];
    for (const e of s.plan.enemies) { e.abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...(e.abilities || {}) }; e.count ||= 1; }
  }
  return d;
}

/* What players are allowed to see: shared, non-empty, shareable fields only. */
export function sharedView(doc) {
  const fields = {};
  for (const f of CAMPAIGN_FIELDS) {
    const v = doc.campaign.fields[f.key];
    if (f.share && v?.shared && v.text.trim()) fields[f.key] = v.text;
  }
  const sessions = doc.sessions.map((s) => {
    const sf = {};
    for (const f of SESSION_FIELDS) {
      const v = s.fields[f.key];
      if (f.share && v?.shared && v.text.trim()) sf[f.key] = v.text;
    }
    return Object.keys(sf).length ? { id: s.id, number: s.number, title: s.title, date: s.date, fields: sf } : null;
  }).filter(Boolean);
  return { campaign: { name: doc.campaign.name, fields }, sessions };
}

export const prettyDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
};

/* Turn text into document blocks: blank lines separate paragraphs, "- " lines become bullets. */
function textBlocks(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^[-*•]\s+(.*)$/);
    return m ? { type: "bullet", text: m[1] } : { type: "p", text: l };
  });
}

const BEAT_LABEL = { scene: "Scene", combat: "Combat", social: "Social", explore: "Exploration", puzzle: "Puzzle or trap", reveal: "Reveal" };
const abilityMod = (n) => { const m = Math.floor(((Number(n) || 10) - 10) / 2); return (m >= 0 ? "+" : "−") + Math.abs(m); };

/* A session plan as document blocks, for the full DM report. */
function planBlocks(plan) {
  const out = [{ type: "h3", text: "Session plan" }];
  const labelled = (label, text) => { if (text.trim()) out.push({ type: "strong", text: label }, ...textBlocks(text)); };
  const line = (label, text) => { if (String(text).trim()) out.push({ type: "p", text: `${label}: ${String(text).trim()}` }); };
  labelled("Goal", plan.goal);
  labelled("Strong start", plan.strongStart);
  if (plan.beats.length) {
    out.push({ type: "strong", text: "Beats" });
    for (const b of plan.beats) out.push({ type: "bullet", text: `${b.done ? "☑" : "☐"} ${BEAT_LABEL[b.kind] || "Scene"}: ${b.text.trim()}${b.note.trim() ? ` (${b.note.trim().replace(/\s+/g, " ")})` : ""}` });
  }
  if (plan.secrets.length) {
    out.push({ type: "strong", text: "Secrets and clues" });
    for (const x of plan.secrets) out.push({ type: "bullet", text: `${x.done ? "☑" : "☐"} ${x.text.trim()}` });
  }
  if (plan.places.length) {
    out.push({ type: "strong", text: "Locations" });
    for (const p of plan.places) out.push({ type: "bullet", text: `${p.name.trim() || "Unnamed place"}${p.notes.trim() ? `: ${p.notes.trim().replace(/\s+/g, " ")}` : ""}` });
  }
  if (plan.npcs.length) {
    out.push({ type: "strong", text: "NPCs" });
    for (const n of plan.npcs) {
      out.push({ type: "strong", text: `${n.name.trim() || "Unnamed NPC"}${n.role.trim() ? ` — ${n.role.trim()}` : ""}` });
      line("Wants", n.wants); line("Secret", n.secret); line("Voice", n.voice); line("Notes", n.notes);
    }
  }
  if (plan.dialogue.length) {
    out.push({ type: "strong", text: "Dialogue and read-aloud text" });
    for (const d of plan.dialogue) {
      const who = d.who.trim();
      const head = d.kind === "read" ? "Read aloud" : d.kind === "option" ? "Player option" : d.kind === "say" ? (who || "NPC") : who || "Note";
      out.push({ type: "bullet", text: `${head}: ${d.text.trim().replace(/\s+/g, " ")}` });
    }
  }
  if (plan.enemies.length) {
    out.push({ type: "strong", text: "Enemies and stat blocks" });
    for (const e of plan.enemies) {
      out.push({ type: "strong", text: `${e.name.trim() || "Unnamed creature"}${e.kind.trim() ? `, ${e.kind.trim()}` : ""}${e.cr.trim() ? ` (CR ${e.cr.trim()})` : ""}` });
      out.push({ type: "p", text: `AC ${e.ac || "?"} · HP ${e.hp || "?"}${e.hpNote.trim() ? ` (${e.hpNote.trim()})` : ""} · Speed ${e.speed || "?"}` });
      out.push({ type: "p", text: ["str", "dex", "con", "int", "wis", "cha"].map((k) => `${k.toUpperCase()} ${e.abilities[k]} (${abilityMod(e.abilities[k])})`).join("   ") });
      line("Saving throws", e.saves); line("Skills", e.skills); line("Resistances and immunities", e.resist); line("Senses", e.senses); line("Languages", e.languages);
      labelled("Traits", e.traits); labelled("Actions", e.actions); labelled("Reactions and legendary actions", e.extra);
    }
  }
  if (plan.rewards.length) {
    out.push({ type: "strong", text: "Rewards" });
    for (const x of plan.rewards) out.push({ type: "bullet", text: `${x.done ? "☑" : "☐"} ${x.text.trim()}` });
  }
  labelled("Contingencies and notes", plan.notes);
  return out;
}

/* Build the blocks for the Word report.
   mode "full": everything, including DM-only sections.  mode "players": shared details only. */
export function buildReport(doc, { mode = "full", sessionIds = null, includeCampaign = true, includePlan = true } = {}) {
  const full = mode === "full";
  const blocks = [];
  const view = sharedView(doc);
  const name = doc.campaign.name.trim() || "Campaign report";
  blocks.push({ type: "title", text: name });
  blocks.push({ type: "meta", text: `${full ? "DM report" : "Player recap"} · ${prettyDate(new Date().toISOString().slice(0, 10))}` });

  if (includeCampaign) {
    const sections = CAMPAIGN_FIELDS
      .map((f) => ({ f, text: full ? doc.campaign.fields[f.key].text : view.campaign.fields[f.key] || "" }))
      .filter((x) => x.text.trim());
    if (sections.length) {
      blocks.push({ type: "h1", text: "Campaign details" });
      for (const { f, text } of sections) {
        blocks.push({ type: "h2", text: f.label.replace(" (DM only)", "") + (full && !f.share ? " (DM only)" : "") });
        blocks.push(...textBlocks(text));
      }
    }
  }

  const pool = full ? doc.sessions : view.sessions;
  const picked = pool
    .filter((s) => !sessionIds || sessionIds.includes(s.id))
    .sort((a, b) => a.number - b.number);
  if (picked.length) {
    blocks.push({ type: "h1", text: "Session log", pageBreak: includeCampaign && blocks.length > 2 });
    picked.forEach((s) => {
      const heading = `Session ${s.number}${s.title ? ": " + s.title : ""}`;
      blocks.push({ type: "h2", text: heading });
      if (s.date) blocks.push({ type: "meta", text: prettyDate(s.date) });
      if (full && includePlan && s.plan && planHasContent(s.plan)) blocks.push(...planBlocks(s.plan));   // prep first; it's never in a player recap
      for (const f of SESSION_FIELDS) {
        const text = full ? s.fields[f.key].text : s.fields[f.key] || "";
        if (!text.trim()) continue;
        blocks.push({ type: "h3", text: f.label.replace(" (private)", "") + (full && !f.share ? " (private)" : "") });
        blocks.push(...textBlocks(text));
      }
    });
  }
  if (blocks.length <= 2) blocks.push({ type: "p", text: "Nothing to include yet." });
  return blocks;
}
