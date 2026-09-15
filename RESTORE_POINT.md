# Restore Point — known-good baseline

**Captured:** 2026-06-24, before a Lumen-assisted code review.
**Baseline commit:** `e2d4d8f` — *"Add usable chat input in fullscreen (transparent, idle-fading)"*
**Git tag:** `baseline-pre-review` (annotated, local).

This is the exact state the live site (https://nmurcin.github.io/watch-together/)
was deployed from at the start of the review. Use this file to get back to it if
anything we change needs to be undone.

---

## Fastest way to revert everything

```bash
# Throw away ALL uncommitted changes and snap back to the baseline:
git reset --hard baseline-pre-review
```

If changes were already committed on top and you want them gone from the branch
tip (but kept in history/reflog so nothing is truly lost):

```bash
git reset --hard baseline-pre-review      # moves branch tip back to the baseline
# (the abandoned commits remain reachable via `git reflog` for ~90 days)
```

To revert just **one file** to its baseline contents:

```bash
git checkout baseline-pre-review -- js/ui.js     # example: restore ui.js only
```

To peek at the baseline without moving anything:

```bash
git stash                       # park current edits if any
git checkout baseline-pre-review   # detached HEAD at the baseline
# …look around…
git checkout main               # back to the branch tip
git stash pop                   # restore parked edits
```

---

## File manifest at the baseline (`e2d4d8f`)

These are the tracked files and their git blob hashes. If a file's hash later
differs from what's listed here, that file changed relative to the baseline.

| File | Bytes | Blob hash |
|---|---:|---|
| `.gitignore` | 267 | `8dbdb899c3435616e5fac2014ce7a5f9bf2a1dfa` |
| `LICENSE` | 1073 | `f015abcddeef4e49fbac654d607ac59aa5152548` |
| `README.md` | 21403 | `d3079db55b58b8e6c33d3b96cd577067c2bc6985` |
| `css/app.css` | 14329 | `7da8ae899d54b20d73829af9272abe899adefe38` |
| `index.html` | 14097 | `0bfdd1e123090ae051ff6546f23328d2fd8ff1b3` |
| `js/chat.js` | 8872 | `2950c6478613e474b0d0479049647244735a9aac` |
| `js/config.js` | 6711 | `90924848afcea8c79293652c59684a899e3b6785` |
| `js/media.js` | 6615 | `84e0f92966a4db0cc236acbd1cff151ffe102bcb` |
| `js/pip.js` | 8809 | `4a79216ac9cc648ae57e276525ffcdc0317f7dd9` |
| `js/rtc.js` | 17446 | `c05aa79ad64f90a6d2491afa18b9ea1e130daecc` |
| `js/signaling.js` | 6865 | `2ff9c7a2fe47fa90ee1eab0810e0eff246307871` |
| `js/ui.js` | 36567 | `a307a606e08cec60b9a1c3657c42525d8bd63015` |
| `server/index.js` | 6306 | `9e36fac86274ec317d52712979bead818d8e96ce` |
| `server/package.json` | 409 | `158f5df4b774a136b84e380ec4ac828842c7d362` |
| `server/rooms.js` | 5396 | `cd0cc638d31ab866c86fddb8801947d9d974fcba` |

## Deployment coordinates (unchanged by a revert — recorded for reference)

- **Front-end:** GitHub Pages, `main` / root → https://nmurcin.github.io/watch-together/
- **Signaling:** Render free tier `watch-together-signal`
  (`wss://watch-together-signal.onrender.com`), Root Directory = `server`.

> A `git reset` only touches the code. It does not change GitHub Pages or Render
> settings. Re-deploy happens automatically on the next push to `main`.
