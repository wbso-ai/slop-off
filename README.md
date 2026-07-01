<div align="center">
  <img src="icons/icon128.png" width="96" alt="Edit & Capture logo">

  # Edit & Capture

  **Edit any web page in place, then hand the diff straight to your AI assistant.**

  One click makes the page editable. A second click copies a clean
  before/after report of everything you changed — prefixed with a
  configurable prompt — to your clipboard, ready to paste into Claude,
  ChatGPT, Cursor, or any other coding assistant.

  ![Manifest V3](https://img.shields.io/badge/Manifest-V3-195FA4)
  ![No dependencies](https://img.shields.io/badge/dependencies-none-16A37B)
  ![License: MIT](https://img.shields.io/badge/license-MIT-FBB734)
</div>

---

## Why?

Tweaking copy on a website through an AI coding assistant usually goes like
this: describe *where* the text is, describe *what* it should become, wait,
review, repeat. It's slow and error-prone.

Edit & Capture flips that around: **you make the edit directly on the page**,
and the extension produces an exact, machine-applicable changelog. Paste it
into your assistant and it knows precisely which HTML to find and what to
replace it with. No ambiguity, no back-and-forth.

## Features

- ✏️ **One-click edit mode** — the whole page becomes editable via
  `designMode`; a gold outline shows edit mode is on
- ⌨️ **Keyboard shortcut** — toggle edit mode with `Cmd+Shift+E`
  (`Ctrl+Shift+E` on Windows/Linux)
- 📋 **Before/after report on your clipboard** — one section per URL, one
  Before/After pair per changed element, wrapped in code fences
- 🎯 **CSS selector per edit** — every edit includes a selector line so your
  assistant can pinpoint the element even when the same text appears twice
- 🤖 **Configurable AI prompt** — a prompt is prepended to the report so you
  can paste it into an assistant as-is; edit it on the settings page
- 🧭 **Survives navigation and reloads** — edits are synced to the background
  worker; navigate (full loads *and* SPA/pushState) or reload and keep editing
- 📝 **Form fields too** — changes to `<input>`, `<textarea>`, and `<select>`
  values are captured with the value baked into the HTML
- 🔔 **On-page toast** — a confirmation appears when the report is copied
- 💾 **Never loses a report** — if copying fails (e.g. you ended edit mode on
  a `chrome://` page), the report is kept and copied on your next click
- 🪶 **Zero dependencies** — three small vanilla JS files, no build step

## Installation

This extension is not (yet) on the Chrome Web Store. Install it from source:

1. Clone this repository, or download the zip from the latest
   [release](../../releases) and unpack it
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the repository folder
5. *Optional:* click **Details** on the extension and enable
   **"Allow access to file URLs"** to use it on local `file://` pages

## Usage

1. **Click the extension icon** (or press `Cmd+Shift+E` / `Ctrl+Shift+E`).
   The page gets a gold outline, the badge shows **REC**, and all text is now
   directly editable.
2. **Edit the page.** Fix copy, rewrite headings, correct numbers, change
   form field values — anything. Navigating to other pages or reloading is
   fine; edit mode follows you.
3. **Click the icon again.** Edit mode turns off, the report lands on your
   clipboard, and a toast confirms it with the edit count.
4. **Paste it into your AI assistant.** The default prompt tells it to apply
   each edit to the source file.

### Example clipboard output

```
Apply the edits below to the source file referenced by the url.
For each Before/After pair: locate the Before HTML in the file and replace it with the After HTML.
The selector line describes where the element lives in the rendered DOM, as a hint for finding it in the source.
Keep everything else unchanged and preserve the original formatting and indentation.

---

url: file:///Users/you/project/index.html

selector: body > main > div:nth-of-type(1)

Before:

​```
<div class='hero'>Welcome to our site</div>
​```

After:

​```
<div class='hero'>Welcome to WBSO.ai</div>
​```
```

### Settings

Right-click the extension icon → **Options** (or go via
`chrome://extensions` → Details → Extension options). There you can change
the prompt that is prepended to every report, or clear it to copy the bare
report. **Reset to default** restores the built-in prompt.

## How it works

| File | Role |
|---|---|
| `background.js` | Service worker: toggles edit mode, stores edits per tab in `chrome.storage.session`, re-injects the content script after navigation, builds the report and copies it |
| `content.js` | Injected while edit mode is active: enables `designMode`, snapshots each element's `outerHTML` right before its first change (`beforeinput`), and syncs edits to the background (debounced) |
| `options.html` / `options.js` | Settings page for the prompt, stored in `chrome.storage.sync` |

Details worth knowing:

- The *before* snapshot is taken on the `beforeinput` event, so it captures
  the element exactly as it was prior to your first change.
- If a parent element is already tracked, its children are not tracked
  separately — this prevents nested duplicate entries in the report.
- Elements you focus but don't actually change are filtered out.
- Each page visit gets its own report section; edits are upserted per visit,
  so reloading and re-editing the same page works as expected.

### Permissions

| Permission | Why |
|---|---|
| `scripting` + `<all_urls>` | Inject the content script, and re-inject it after navigation (this is what lets edit mode survive page changes) |
| `storage` | Persist your prompt (`sync`) and in-flight edits (`session`) |
| `clipboardWrite` | Copy the report to the clipboard |
| `activeTab` | Baseline access to the tab you clicked on |

Nothing is sent anywhere: the extension has no remote code, no analytics, and
makes no network requests. Your edits never leave your machine — the report
only goes to your clipboard.

## Limitations

- Doesn't work on `chrome://` pages or the Chrome Web Store (the badge shows
  ✗). If you end edit mode on such a page, the report is saved — the badge
  shows 💾 — and your next click on the icon (from any normal page) copies it.
- Heavily dynamic pages (e.g. React apps that re-render) may overwrite your
  edits or produce noisy diffs, since the framework owns the DOM. SPA
  navigations themselves are handled correctly.
- If the async Clipboard API fails (e.g. the document isn't focused), the
  extension falls back to a hidden textarea with `execCommand('copy')`.

## Development

No build step. Edit the files, then hit the reload icon on the extension card
in `chrome://extensions`. The icons are generated programmatically
(pure-Python PNG writer, no dependencies) — see `icons/`.

Contributions are welcome: open an issue or a pull request.

## License

[MIT](LICENSE) © 2026 Jankees van Woezik &lt;jankees@wbso.ai&gt;
