<div align="center">
  <img src="icons/icon128.png" width="96" alt="Slop Off logo">

  # Slop Off

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

Slop Off flips that around: **you make the edit directly on the page**,
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
  values are captured with the value baked into the HTML (incl. checkbox and
  radio state)
- 🖱 **Forms are editable too** — button labels and `<label>` text edit like
  any text (⌘/Ctrl-click a button to actually press it); typing in an empty
  field with a placeholder edits the placeholder itself; selects, checkboxes,
  details, and media controls stay interactive (⌥-click a `<summary>` to edit
  its text)
- 🔁 **Edits re-apply on return** — revisit a page you edited during the
  session and your changes are applied to it again and stay editable
- 🔗 **Safe links** — link clicks never navigate while editing; hovering a
  link shows an inline URL editor plus a ↗ button (or ⌘/Ctrl-click) to
  deliberately follow the link while the edit session continues
- ↩️ **Undo per edit** — a floating chip shows the live edit count; open it
  to undo edits on this page (↩︎) or drop edits from other pages (✕) without
  losing the rest — ending edit mode copies the report right away
- 👁 **Original / Diff / New views** — toggle the page between its original
  state, an in-page word diff (red strikethrough / green), and your edited
  version; Original and Diff behave like a normal read-only page, New
  returns to editing
- 🗂 **Report history** — the last 20 reports are kept on the settings page;
  view, copy, delete, or combine several into one multi-page report
- 🔔 **On-page toast** — a confirmation appears when the report is copied
- 💾 **Never loses a report** — if copying fails (e.g. you ended edit mode on
  a `chrome://` page), the report is kept and copied on your next click
- 🤝 **MCP bridge** — POST reports to the bundled `mcp/server.js` and your
  coding agent picks them up via `wait_for_report`, queued and in order
- 🪶 **Zero dependencies** — small vanilla JS files, no build step

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

### Straight into your coding agent (MCP)

Instead of pasting from the clipboard, reports can flow directly into
Claude Code (or any MCP client) via the bundled bridge in `mcp/server.js` —
a single dependency-free Node script that receives reports from the
extension over HTTP and serves them to the agent as MCP tools.

#### 1. Register the MCP server

No clone needed — the bridge is published to npm and runs via `npx`:

```sh
claude mcp add --scope user slop-off -- npx -y slop-off
```

`--scope user` makes the tools available in every project. Verify with
`claude mcp list`; remove again with `claude mcp remove slop-off`.
The bridge listens on port `8931` (override with the `SLOP_OFF_PORT`
env var — then also adjust the webhook URL below).

> Prefer running from source? Point it at the checked-out script instead:
> `claude mcp add --scope user slop-off -- node "$(pwd)/mcp/server.js"`.

#### 2. Point the extension at it

Nothing to do — the extension defaults its **Webhook URL** to
`http://localhost:8931`, exactly where the bridge listens. Every report is
POSTed there next to the clipboard, and the on-page toast confirms it:
*"sent to agent"*. When no Claude Code session (and thus no bridge) is
running, the POST simply fails and the report falls back to the clipboard —
no warning, no noise. Clear the field in the options to disable POSTing, or
change it if you overrode `SLOP_OFF_PORT`.

#### 3. Install the `/slop-off` skill

The skill ships in this repo at `.claude/skills/slop-off/SKILL.md`, so
inside this repo the slash command works as-is. To use it from any project,
install it user-wide with the [`skills`](https://skills.sh) CLI:

```sh
npx skills add wbso-ai/slop-off
```

That fetches the skill straight from GitHub and installs it into
`~/.claude/skills/` (pick **Claude Code** and the global scope when prompted;
or non-interactively: `npx skills add wbso-ai/slop-off -g -a claude-code -y`).
`skills` supports [70+ other agents](https://skills.sh) too — swap the
`-a` flag for Cursor, Codex, etc.

#### 4. Use it

In a Claude Code session in the project whose site you're editing:

- `/slop-off` — processes reports in a loop: edit in the browser, end
  the session (toolbar icon / ⌘⇧E), watch the agent apply it, edit again —
  until you say *stop*
- `/slop-off once` — wait for and apply a single report
- `/slop-off latest` — apply the most recent report, without waiting
- `/slop-off list` — show the queue

Reports queue up in order (`~/.slop-off/queue.json`, last 50), so
several edit sessions in a row are all delivered — `wait_for_report`
returns immediately while there's a backlog. Without the skill the raw MCP
tools (`wait_for_report`, `get_latest_report`, `list_reports`) work too:
*"wait for my edit report and apply it"*.

## How it works

| File | Role |
|---|---|
| `background.js` | Service worker: toggles edit mode, stores edits per tab in `chrome.storage.session`, re-injects the content script after navigation, builds the report and copies it |
| `content.js` | Injected while edit mode is active: enables `designMode`, snapshots each element's `outerHTML` right before its first change (`beforeinput`), and syncs edits to the background (debounced) |
| `options.html` / `options.js` | Settings page: prompt, webhook URL, report history — stored in `chrome.storage.sync` / `.local` |
| `mcp/server.js` | Optional MCP bridge: HTTP endpoint for the webhook + `wait_for_report` / `get_latest_report` / `list_reports` tools over stdio |
| `.claude/skills/slop-off/` | Claude Code skill: `/slop-off` processes queued reports in a loop |

Details worth knowing:

- The *before* snapshot is taken on the `beforeinput` event, so it captures
  the element exactly as it was prior to your first change.
- If a parent element is already tracked, its children are not tracked
  separately — this prevents nested duplicate entries in the report.
- Elements you focus but don't actually change are filtered out.
- Report sections are keyed by URL (ignoring the `#hash`): one section per
  page, no matter how often you visit it; revisiting re-applies your edits.

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
