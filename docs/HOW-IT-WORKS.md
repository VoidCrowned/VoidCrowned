# How it works

My profile README is one terminal window built from a stack of SVG strips.
Everything in `README.md`, `assets/` and `worker/src/generated.mjs` is generated.
Don't edit those by hand.

## Change a line

1. Edit `config.json` (texts, links, colours, font, idle lines).
2. Run `npm ci` once, then `node generate.mjs`.
3. Run `node generate.mjs --check`. It prints JSON; `"ok": true` means good.
4. Commit and push. The Action also rebuilds on its own after a push to `config.json`.

Useful extras:

- `node generate.mjs --offline` skips the GitHub API and uses `data/recent.json`.
- `node generate.mjs --offline --preview` also writes `preview/index.html`, a local page with GitHub's dark styling at 830px and 400px.
- In a value, `{text}` highlights that part (used for `@6uhrmittag`).
- Colours: `palette` holds every hex value once, under a name. `theme` says which palette name each part uses. To recolour, change the hex in `palette`; to give a part another colour, change the name in `theme`.
- Font: `"font"` picks one entry from `fonts` (`gohu` or `jetbrains`).
- A row with a `link` becomes its own clickable strip. Rows without one are merged into the strip above or below.

## Why strips

GitHub strips styles and scripts from READMEs, and links inside an SVG shown through `<img>` don't work.
So each clickable row is its own SVG inside an `<a>`. The images sit in one `<p>` with no whitespace between them and `align="left"`, which makes them float and stack without gaps.
The strips are 846 units wide, which is the README column on a desktop profile, so GohuFont (a pixel font, native at 14px) sits on whole pixels there. At other widths it is scaled and a little softer.
`fonts/GohuFontUni14-Latin.ttf` is a cut-down copy of the GohuFont uni-14 Nerd Font file (Latin, punctuation, box drawing), so the repo doesn't carry 2.5 MB of icons.
Each SVG carries its own subsetted font (only the glyphs it uses). Stars and the `✦` / `♪` icons are drawn shapes, so they don't depend on the font.
Star positions come from a seeded random generator, so a strip only changes when its content changes.

## Recent activity

`lib/recent.mjs` reads my public events: pushes link to the head commit, merged pull requests link to the PR. It keeps the newest entry per repo and shows three.
The events API only reaches back about 90 days, so the last known list lives in `data/recent.json` and stays on screen until something newer arrives.
Times are coarse on purpose (`today`, `yesterday`, `this week`, `2w ago`): the text changes at most once a day, so the hourly Action doesn't commit every hour.

## The Action

`.github/workflows/update.yml` runs hourly, on manual dispatch, and on pushes to the config or the script. It commits only when files changed.
After 45 days without any commit it pushes an empty one, because GitHub switches scheduled workflows off after 60 quiet days.

## Now playing (Cloudflare Worker)

`worker/` answers with a live SVG strip. It asks [Lanyard](https://github.com/Phineas/lanyard) for my Discord presence and shows the Spotify track, or a random idle line from `config.json`. No Spotify app needed.

Deploy:

1. `cd worker`
2. `npx wrangler login` (opens the browser)
3. `npx wrangler deploy` and copy the `https://voidcrowned-now.<something>.workers.dev` URL it prints
4. Put that URL into `nowPlaying.workerUrl` in `config.json`
5. `cd .. && node generate.mjs`, commit, push

While `workerUrl` is empty, the README shows a static placeholder strip instead.
After changing colours, font or idle lines, run `node generate.mjs` and deploy the Worker again: it reads them from `worker/src/generated.mjs`.

Alternatives I didn't build: Last.fm's recent-tracks API, or the Spotify Web API with a refresh token.
