# Curious Atlas: the version you can host yourself

This folder is a complete, public copy of Curious Atlas that runs on any static web host. No server, database or account is needed.

## What's included

| File | What it is |
| --- | --- |
| `index.html` | The page |
| `atlas.js` | The app: globe, Explore, Quiz, Daily, Passport |
| `vendor.js` | The map-drawing libraries (parts of d3 and topojson), trimmed to what the app uses |
| `facts.js` | 1,981 facts about 248 places (at least 7 each) in 21 topics, each linked to the exact Wikipedia version it came from |
| `countries-info.js`, `countries-extra.js` | Flags, capitals, area, continent, population; currencies and official languages |
| `countries-50m.json`, `countries-110m.json` | Country borders (Natural Earth): the standard map and a lighter one used while the globe spins |
| `detail-<continent>.json` | The detailed map for deep zoom (small islands), one file per continent, loaded only for the part of the world someone zooms in on |
| `hydro.json` | Rivers and lakes |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and the app icon for "Add to Home Screen" |

Upload **everything in this folder, including the `icons` folder**, and keep the layout as it is.

## What works in this version

- **Explore:** the globe with deep zoom to small islands, facts and country cards
- **Quiz:** Easy (4 choices), Medium (6 choices), Hard and Expert (type the name), plus **Survival** (endless, three lives, a shrinking clock); flag, shape, capital and other special rounds; a short tutorial for first-time players
- **Scoring extras:** streaks with a combo meter, Fever after five perfect answers, bets, a mystery multiplier on the final question, golden landmarks to tap on the globe, a bonus round, free spins and prize chests
- **Power-ups:** Freeze, Lens, 50/50, Shield, Compass, Double up, Second chance and Extra life, earned by playing, plus a free Second chance every day and a 7-day login calendar
- **Daily:** the same 5 questions for everyone each day, with all the extras above, streaks and a share card
- **High scores and Passport:** personal top-10 lists for each level, stamps, continent sets, achievements and stats
- **Skins:** 16 looks for the globe and page, unlocked by playing

Each visitor's passport, streaks and scores are saved in their own browser.

## What's left out

Party games, challenge links, global high scores, the shared jackpot and the daily leaderboard rely on the shared database that only exists on claude.ai, so this version hides them. Keep using your claude.ai page for games with invited friends.

## Put it online (pick one)

### Netlify Drop (easiest, about a minute)
1. Go to **app.netlify.com/drop**.
2. Drag the whole `curious-atlas-site` folder onto the page.
3. Netlify gives you a live address like `something-random.netlify.app`. Sign up for a free account to keep it and to rename it.

### GitHub Pages (free, good if you'll update it)
1. Create a free account at **github.com** and make a new **public** repository, for example `curious-atlas`.
2. On the repository page, choose **Add file → Upload files**, drag in everything from this folder (including the `icons` folder) and click **Commit changes**.
3. Open **Settings → Pages**. Under **Branch**, choose `main` and `/ (root)`, then **Save**.
4. After a minute or two the site is live at `https://YOUR-USERNAME.github.io/curious-atlas/`.

### Cloudflare Pages
1. In the Cloudflare dashboard, open **Workers & Pages → Create → Pages → Upload assets**.
2. Name the project, upload the folder and deploy. It goes live at `your-project.pages.dev`.

All three give you free HTTPS and let you connect your own domain name later.

## Try it on your computer first (optional)

Opening `index.html` by double-clicking won't work, because browsers block it from loading the map file. Run a small local server instead. In a terminal, from inside this folder:

```
python3 -m http.server 8000
```

Then open **http://localhost:8000** in your browser.

## Updating it later

Replace the changed files on your host. On GitHub, upload them again; on Netlify, drag the folder again. The site needs nothing else. It loads only its fonts from Google Fonts; everything else is in this folder, and after the first visit it works offline.

## Credits

Facts link to the English Wikipedia articles they were checked against. Borders: Natural Earth via world-atlas. Flags, capitals, areas and continents: the world-countries dataset (mledoze/countries). Population: World Bank, 2023.

## Extras built in

- **Works offline and installs like an app.** After the first visit, the site keeps working without a connection, and phones and browsers offer "Add to Home Screen" / "Install". When you upload a new version, visitors get it on their next visit.
- **Skins.** Visitors pick a look from the Skin button above the globe, and their choice is remembered.
- **Progress backup.** In Passport, visitors can copy a progress code and restore it on another device or browser.
- **Optional visitor counter.** To count visits without cookies or tracking, make a free account at goatcounter.com, then put your site code in `config.json` as `"goatcounterCode": "yourcode"` and rebuild. Leave it empty to turn counting off (the default).
