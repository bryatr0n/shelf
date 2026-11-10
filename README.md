# Shelf — Reading Tracker

A minimal, installable reading tracker (PWA). Plain HTML/CSS/JS, no build step.

## Run locally

```
python -m http.server 5173
```

Then open http://localhost:5173.

## Files

- `index.html`: markup and dialogs
- `styles.css`: styles (light and dark mode follow the system)
- `app.js`: library, search, editing, import/export
- `sw.js`: offline support
- `manifest.webmanifest`, `icons/`: install metadata

## Book data

Search queries **Google Books** and **Open Library** in parallel and merges the results.
Google gives page counts and descriptions. Open Library gives the original publication year and covers.
A free Google Books API key can be added in the ⋯ menu. Without one, Google's shared quota sometimes runs out, and Open Library carries the search.

## Data

Books are stored in the browser's `localStorage` on each device. Use ⋯ → Export/Import to back up your library or move it to another device.
