# DM Table

Battle map, fog of war, initiative, dice and drag-and-drop inventory for running a tabletop game.
Players follow along on their own phones; everything syncs through one Netlify Function + Netlify Blobs.

## Deploy
1. Put these files in a GitHub repo (keep the folder layout). To update an existing deploy, replace the files and commit.
2. In Netlify: Add new site, Import from Git, pick the repo. Build settings are read from `netlify.toml`.
3. Open the site, choose "New table", set a DM PIN. Share the table code or the "Copy player link" button.

Existing tables keep working after an update.

## Layout
- `public/` the web app (index, dm, play pages; common.js has the map view; dice.js the roller)
- `netlify/functions/api.mjs` the API (state, map, fog mask, token images, initiative, DM PIN check)

## Notes
- Fog of war is drawn in the browser. The full map image is still sent to player devices, so a determined player could find it.
- Every player roll is sent to the DM's roll feed. The DM chooses whether players can see the feed, and whether the DM's own rolls are shared.
- DM accounts: DMs create an account (name and password) on the front page, then see their own list of campaigns (`dm-home.html`). Each campaign is a separate table with its own code, players, maps and notes, and DMs can't open each other's. Passwords are stored as salted hashes. Older tables with a code and PIN still work, and can be added to an account from the campaigns page.
- Player logins: on the Party tab, "Player login" gives a character a PIN (stored only as a hash). Players pick their character and enter the PIN; the sheet, notes, spells, initiative and roll names then belong to that login. Characters with no PIN stay open to anyone with the table code. Setting a new PIN signs out old devices.
- Character sheet: players fill in identity, abilities, saves, skills, combat numbers, attacks, features, backstory and coins. Modifiers, proficiency, saves, skills, initiative, passive Perception and spell DC are worked out automatically. Players send HP changes to the DM, whose screen applies them.
- Player sheets (spell slots, known spells, notes) are saved on the server per character. The DM can edit slots and spells and read the notes.
- Spell library: the DM imports a CSV, TSV or JSON list (Party tab, "Spell library"). Players search it and add spells to their sheets. To ship a default list with the app, add `public/spells.json` (an array of objects with name, level, school, time, range, comp, dur, classes, desc).
- Item lists and HP for player characters are still visible to every player at the table.
- Perspective grid: for maps seen at an angle or fading into a horizon. Choose Grid > Perspective on the Map tab, drag the four blue corners onto the floor of the map, and set how many squares fit across and deep. Squares shrink toward the far side, tokens and pings shrink with them, and snapping follows the grid. It is saved per location.
- Pings and movement: players can ping a spot on the map (everyone sees it for a few seconds). They can also ask to move their character: on their turn in combat, or any time when the DM turns on Free explore. Spots must be revealed (not under fog) and inside any grid shapes. Requests go to the DM's Move requests list and only happen when approved (or when Auto-approve is on).
- Locations tab (DM): save several maps as locations. Each remembers its map image, grid (size, position, dimming, shape), fog and where every token stood. Switch from the Location dropdown on the Map tab or the Locations tab; choose which tokens come along. An older single map can be saved as a location with one click.
- Campaign tab (DM): game details (overview, premise, themes, setting, factions, table rules, secrets) and a session log (recap, accomplished, learned, earned, people and places, open threads, private notes). Each section can be shared with players, who see it under Campaign. Export a Word (.docx) report: a full DM version or a player recap of shared items only. Secrets and DM notes can never be shared.
- Objectives are DM-managed; each one is hidden or shown to players.
- Grid tools: dim the grid, slide it under the map, and outline shapes so the grid stops at the edges of irregular maps.
