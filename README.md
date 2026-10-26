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
- Dice rolls are private to the device that rolls them. A player's initiative roll is sent to the DM.
