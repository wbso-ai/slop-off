---
name: slop-off
description: >
  Process Slop Off browser reports via the slop-off MCP server and
  apply the edits to the current project's source. By default keeps
  looping over reports until the user stops. Use for
  "/slop-off", "apply my edit report", "wait for my browser edits",
  or after the user has made edits in the browser with the
  Slop Off extension.
---

# Apply browser edits

Process reports from the `slop-off` MCP server and apply them to the
source. Everything happens in the MAIN thread — no subagents — so every
report gives an immediate "✅ …" line and nothing sits between the queue
and the work.

## Mode

- **Default (loop)**: say once "Waiting for browser edits — say 'stop'
  when you're done", then loop:
  1. Call `wait_for_report` with timeout_seconds: 60 and `origin` set
     to this project's dev server (e.g. `http://localhost:3012`; find
     the port your project's server listens on, or the pane's URL in
     pane mode). Several sessions share one queue; with `origin` you get
     only your app's reports and never take another session's. Empty?
     Call it again, silently — empty waits are normal. After ~10 consecutive
     empty minutes, mention in one line that you're still waiting (don't
     ask, don't stop); repeat that at most once an hour.
  2. Report received → apply it per "Apply edits" below, then follow
     "Per processed report".
  3. Loop again immediately — more edits may already be queued.
  Stop only when the user says "stop" (or "done").
- Argument `once`: process exactly one report and stop.
- Argument `latest`: call `get_latest_report` (don't wait), process,
  stop.
- Argument `list`: call `list_reports`, show the queue, ask which one.
- Argument `clear`: call `clear_reports` and report in a single line how
  many reports were cleared. Process nothing, then stop.
- Argument `pane [url]`: the same loop, but the user edits in YOUR
  built-in browser pane, where the extension can't be installed. See
  "Pane mode".

## Pane mode

The bridge serves the whole extension as one page script at
`http://localhost:8931/inject.js` (chrome.* is emulated in-page by
`shim.js`). Inject it with the browser pane's JavaScript tool:

```js
if (!window.__slopOffShim) await new Promise((ok, ko) => { const s = document.createElement('script'); s.src = 'http://localhost:8931/inject.js'; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });
```

- Start: open the url (if given) in the pane once, inject, and turn
  edit mode on with `window.__slopOffToggle()` only if
  `document.designMode` isn't `"on"` yet (toggling it off sends a report). The user toggles it
  with ⌘⇧E afterwards; ⌘↩ sends pending edits right away.
- A full reload drops the script; edits and edit mode survive in
  sessionStorage. So after each empty wait re-run the inject snippet (a
  no-op when it's still there) — it resumes edit mode by itself. You
  reload after applying anyway, so this only catches the user's own
  refreshes; the normal 60s wait is fine.
- After applying a report and calling `notify_browser`: reload the
  pane yourself (`location.reload()`) and inject again, so the user
  sees the change without refreshing. Don't navigate elsewhere.

## Apply edits

The report contains per-URL sections with Before/After HTML pairs and/or
Element/Instruction pairs, each with a CSS selector as a hint.

1. For each edit find the source file that renders that page/HTML: search for
   distinctive text from the Before block (literal strings first,
   then fuzzy). The URL says which route/page; the selector where in the DOM.
2. Replace the Before content with the After content. Preserve existing
   formatting, indentation and templating (translate HTML changes into the
   template/JSX/component if the source isn't plain HTML).
3. Not found? Report it explicitly with the closest match — never
   silently guess or skip. Then just continue the loop.
4. Placeholder, href and other attribute changes are attribute edits;
   change only that attribute.
5. Element/Instruction pairs are annotations: find the element (selector +
   Element snippet) and carry out the instruction on that element in the source.
   These are free-form tasks ("make this shorter", "different color") — carry
   them out to the best of your judgment and report what you did.

## Per processed report

- Run a quick check if the project has one (typecheck/lint; no
  full build per report in loop mode).
- ALWAYS call the slop-off MCP tool `notify_browser` with a concrete 1-2
  line summary of what changed (e.g. "Hero heading and CTA text updated in
  index.html") — also on failure, never with an empty message. The
  extension shows it as a toast on the page, and the call marks the report
  as done in the browser HUD: skip it and the report stays stuck on
  "applying" for the user.
- Report to the user in a single line: "✅ N change(s) applied — file1,
  file2 · M still queued" (N and M come from the report header; when M is
  0 say "· queue empty, waiting"). Only if something failed a second
  line: "⚠️ not applicable: …". No further explanation.
- Go straight back to waiting.
