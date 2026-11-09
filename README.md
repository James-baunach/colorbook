# Colorbook

Turn family photos into black-and-white coloring pages and print them as a coloring book.
It's free and private: photos stay in your browser and are never uploaded anywhere.

**Live site:** https://james-baunach.github.io/colorbook/

## Features

- **Photo → line art** in the browser. Sliders control detail, simplify, line thickness and speck cleanup, and there are Toddler / Kids / Detailed presets.
- **Background control** (Keep / Simplify / People only), using a free AI model that runs on your device to find people and pets.
- **Crop & rotate**, with "Fill page" shapes that match the printable area.
- **Touch-up brush**: a pen to close gaps and an eraser for stray marks, with undo. Touch-ups are kept when you change the style.
- **Collage pages**: put 2–4 pictures on one page ("Add next page here" / "Split apart").
- **Print or download a PDF** in two formats:
  - **Full pages**: 8.5 × 11, one per sheet
  - **Booklet**: two 5.5 × 8.5 pages per sheet, in fold-and-staple order. Print double-sided and flip on the short edge.
- An optional cover page you can color, captions, sideways turning for wide pictures, and blank backs for markers.
- **Backup & restore**: save a book to a `.colorbook` file and open it on any device.
- Installs as an app (PWA) and works offline after the first visit.

## Run locally

```bash
python -m http.server 5178
```

Then open http://localhost:5178. It must be served over http. Opening `index.html` directly won't work.

## Tips for the best pages

- Close-ups work best. Crop in so faces fill the frame.
- Busy backgrounds (grass, trees) get messy. Try **Background → Simplify** or **People only**.
- iPhone HEIC photos open in Safari. In Chrome on Windows, export them as JPEG first.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | UI, storage (IndexedDB), crop, touch-up, backup |
| `lineart-worker.js` | Photo → line art (Difference-of-Gaussians edges, adaptive threshold, edge linking, speck removal) |
| `segment.js` | People/pet detection (MediaPipe DeepLab v3, runs in the browser) |
| `compose.js` | Page layout, collages, cover, booklet ordering, built-in PDF writer |
| `sw.js`, `manifest.json`, icons | Installable app + offline support |
