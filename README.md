<p align="center"><img src="assets/icons/skull-dotmatrix.svg" alt="Red skull project icon" width="128" height="128"></p>

# Graveyard Keeper 2 factory planner

**Use it in your browser: <https://graveyard-factory.runoverlabs.dev/>** — nothing to install, no account; it saves in your browser and runs entirely on that page.

A layout editor and automatic planner for the conveyor factory in Graveyard Keeper 2. Draw belts, stations and chests on the factory's real floor, or give the planner the items you want per minute and let it work out the stations, place them and lay the belts.

> **Disclaimer.** This is an unofficial fan-made tool. I own none of the game content it uses and have no relation to, affiliation with, or endorsement from the copyright holders. *Graveyard Keeper 2*, its art (including the images in `assets/`, extracted from the game files), names and game data are © their respective owners: developer **Lazy Bear Games**, publisher **tinyBuild**. All trademarks belong to their owners. The game material is used under a claim of **fair use**: this is a free, non-commercial planning tool for players who own the game, using small portions (sprites, icons, names and recipe data) for the transformative purpose of planning factory layouts, and it is not a substitute for the game or its assets. If you are a rights holder and want anything removed, please open an issue.

## Using the site

Open <https://graveyard-factory.runoverlabs.dev/>.

- **Edit by hand.** Pick a tool on the left (belt, underground, splitter, station, chest and so on, or press its key), click or drag on the floor. `R` rotates, `Del` deletes, Ctrl+Z / Ctrl+Y undo and redo, the wheel zooms and middle-drag pans. The Issues panel lists anything that breaks the game's rules.
- **Let the planner do it.** In the Planner panel on the right, add the final outputs you want per minute (for example "Supply: Preserves II (Onion ★★★)"), press **Generate layout** and watch the search run, then **Apply** to add the result to your layout.
- **Repaired floor sections** (left panel) say which parts of the factory floor you've fixed in the game, so the plan only uses floor you have.
- **Your language.** The interface follows your browser's language and has a selector in the top bar: English, Deutsch, Español, Français, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe and 简体中文. Item, station and extension names are the game's own; the rest of the text was machine-translated, so corrections are welcome as pull requests (see `docs/INTERNALS.md`, "Languages").
- **Share it.** The address bar always holds your factory as `?f=…`, so copying the URL shares it (or press **Copy link**). Opening a shared link shows that factory, and the first edit you make replaces the one saved in your browser. **Export JSON** and **Import JSON** keep layouts as files.

It's an unofficial fan tool; see the disclaimer above.

## Contributing

Pull requests and issues are welcome (the bug icon in the site's top bar opens a new issue from the bug template) at <https://github.com/runoverlabs/graveyard-factory>. How it works inside is in [docs/INTERNALS.md](docs/INTERNALS.md); the ground rules for changes are in [AGENTS.md](AGENTS.md) (written for coding agents, but they apply to everyone).

### Development setup

There's no build step and no runtime dependency: the app is plain ES modules that the browser loads as they are, so it has to be served over HTTP (opening `index.html` from disk won't work). You need Node 22+ for the tests and Python 3 to serve.

```sh
git clone https://github.com/runoverlabs/graveyard-factory.git
cd graveyard-factory
npm start         # python3 -m http.server 8000, then open http://localhost:8000
npm test          # unit tests for the model, game data and planner (Node 22+)
npm run typecheck # JSDoc types, checked by TypeScript (fetched by npx; not a dependency)
```

Both `npm test` and `npm run typecheck` must pass before you send a change.

- **Docker or Podman:** `docker compose up -d` → http://localhost:8080 (nginx, the project folder mounted read-only; stop with `docker compose down`).
- **Dev container:** `.devcontainer/` (for example VS Code "Reopen in Container") has Node 22 and Python 3 on Debian and no Docker inside, so use `npm start` there (port 8000 is forwarded) rather than compose. The project is bind-mounted with `:z` for SELinux hosts.
- **Types:** the code is JavaScript with JSDoc types. Every module starts with `// @ts-check`, and `jsconfig.json` has TypeScript check `src/` in strict mode (except null checks). Shared types live in `src/types.js`. Editors get the types; the browser runs the files as they are.
- **Publishing:** `.github/workflows/pages.yml` tests, type-checks and publishes `index.html`, `styles.css`, `src/` and `assets/` to GitHub Pages (details in [docs/INTERNALS.md](docs/INTERNALS.md#publishing-as-a-static-site-github-pages)).
- **Game files:** art and data come from the game's own files, which aren't in the repo (the install folder `Graveyard Keeper 2/` is gitignored). [docs/INTERNALS.md](docs/INTERNALS.md) says where each fact came from and how to read them.
