# Shelf — project notes for Claude

A personal, minimal reading tracker that replaces a paid app. It is a PWA used on an iPhone (home-screen app) plus Windows and Mac laptops.
Keep it free to run, minimal in UI, and dependency-free.

## Workflow

- **Pull first:** the owner works from more than one computer. Run `git pull` at the start of every session, and commit + push at the end.
- **Deploy = push to `main`.** GitHub Pages serves the repo root at https://bryatr0n.github.io/shelf/ (repo `bryatr0n/shelf`, public).
  To confirm a deploy: `gh api repos/bryatr0n/shelf/pages/builds/latest --jq .status` → `built`.
  On Windows, `gh` lives at `C:\Program Files\GitHub CLI\gh.exe` and is not on the Bash PATH.
- **Local preview:** `python -m http.server 5173` (Windows) or `python3 -m http.server 5173` (Mac), then open http://localhost:5173.
  `.claude/launch.json` is gitignored, so recreate it per machine if you want the preview tool.
- Installed apps pick up a push the next time they open. The service worker fetches app files network-first with `cache: 'no-cache'`.

## Files

- `index.html`: all markup, including dialogs (search, add/edit book, quick progress update, stats, menu)
- `app.js`: library, search, the editor, quick page updates, reading sessions and stats, import/export
- `sync.js`: Supabase sync. Plain `fetch` against the Auth + REST APIs, with no client library.
- `config.js`: Supabase URL and publishable key. These are public by design; row-level security (RLS) protects the data.
- `sw.js`: offline cache. **Bump `CACHE` and update `SHELL` when adding or renaming app files.**
- `supabase/setup.sql`: the table, RLS policy, and the trigger that enforces last-write-wins and stamps `modified_at`
- `styles.css`: light/dark tokens on `:root`. `--chart` colors were validated with the dataviz palette script.

No build step and no npm. Keep it vanilla HTML/CSS/JS.

## Data model

Books are stored in `localStorage['shelf.books.v1']` as an array. Each book has:

- **Details:** `id`, `title`, `subtitle`, `authors` (comma string), `series`, `year`, `pages`, `publisher`, `isbn`, `genres`, `cover` (URL), `description`
- **Tracking:**
  - `status`: `want` (shown as **TBR**) | `reading` | `finished` | `dnf`
  - `progress`, `startedAt`, `finishedAt` (YYYY-MM-DD), `rating` (0–5), `notes`
- **Timestamps:** `addedAt`, `updatedAt` (ISO)
- `sessions: [{ at, d, from, to }]`: reading sessions. Each page update logs one. A second update within 15 minutes adjusts the last session instead (typo fixes). Page changes made in the editor only log when the book was already `reading`.

Search runs Google Books and Open Library in parallel and merges the results by title + author. Open Library supplies the original publication year and covers.
Google's keyless quota often returns 429, and the app falls back to Open Library. An optional Google Books API key can be set in the ⋯ menu.

## Sync (Supabase)

- Local-first:
  - Edits call `Sync.changed(id)` or `Sync.removed(id)`, which queue them in `shelf.sync.dirty` / `shelf.sync.deleted`.
  - Queued changes are pushed by upsert. Changes are pulled using the server's `modified_at` cursor (`shelf.sync.since`).
  - The newest `updatedAt` wins.
- The session token is in `localStorage['shelf.session']`.
- Supabase settings: email/password auth, **Confirm email off**, **new sign-ups disabled** (the owner's account already exists).
- Free projects pause after about a week with no activity. Restore in the Supabase dashboard if sync stops.

## Testing — read before seeding sample data

**The localhost preview may be signed in to the owner's real account.** Any edit triggers a sync within about 1.5s.
Test books once leaked into the real library this way and had to be deleted.

Before testing with sample data:
1. Check `localStorage.getItem('shelf.session')`.
2. If it's set, mock `window.fetch` for `*.supabase.co`, or move the session key aside and restore it afterwards.
3. Back up `shelf.books.v1` and restore it after the test.

Verify UI at phone width (375px) as well as desktop.

## iOS / PWA gotchas (already fixed — don't regress)

- The iOS keyboard covers the bottom of the screen without moving fixed elements. Small sheets (`.sheet.small`) therefore drop down from the **top** on phones.
- Tapping the dialog backdrop while typing only dismisses the keyboard; a second tap closes the dialog. This is tracked on `pointerdown`.
- `[hidden]` needs `display: none !important`, because classes that set `display` override the attribute.
- Cards are `div[role=button]`. Their focus ring is hidden after pointer use (`html.pointer`) and drawn inset for keyboard use.
- A modal `<dialog>` with `height: auto` stretches to full height. Use `fit-content`.

## Owner preferences

- Minimal UI. Open on the **Reading** tab every launch. Tab order is TBR · Reading · Finished · DNF.
- Book details must stay editable (page counts from APIs are often wrong).
