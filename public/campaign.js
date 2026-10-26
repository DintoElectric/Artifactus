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
export const blankSession = (number = 1) => ({
  id: Math.random().toString(36).slice(2, 9),
  number,
  title: "",
  date: new Date().toISOString().slice(0, 10),
  fields: Object.fromEntries(SESSION_FIELDS.map((f) => [f.key, blankField()])),
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

/* Build the blocks for the Word report.
   mode "full": everything, including DM-only sections.  mode "players": shared details only. */
export function buildReport(doc, { mode = "full", sessionIds = null, includeCampaign = true } = {}) {
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
