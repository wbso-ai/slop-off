---
name: slop-off
description: >-
  Apply Slop Off browser edit reports in Codex via the slop-off MCP server.
---

# Apply browser edits

Process reports from the `slop-off` MCP server and apply them to the current project's source.

## Modes

- Default or `once`: call `wait_for_report` with `timeout_seconds: 120`, process one report, then stop.
- `latest`: call `get_latest_report`, process that report without waiting, then stop.
- `list`: call `list_reports` and show the queue without applying edits.
- `clear`: call `clear_reports`, report how many pending reports were cleared, then stop.

## Apply edits

The report contains per-URL sections with Before/After HTML pairs and/or Element/Instruction pairs, each with a CSS selector as a hint.

1. For each edit, find the source file that renders that page or HTML. Search for distinctive text from the Before block first, then use the URL and selector as context.
2. Replace the Before content with the After content. Preserve existing formatting, indentation, and templating; translate HTML changes into the source language when the project uses JSX, templates, or components instead of plain HTML.
3. Treat placeholder, href, label, and other attribute changes as attribute edits. Change only the relevant attribute unless the report asks for broader work.
4. For Element/Instruction pairs, find the element from the selector and snippet, then carry out the instruction on that element in the source.
5. If an edit cannot be found, report the closest match or the reason it was not applicable. Do not silently skip or guess.

## After applying

Run the quickest relevant project check available, such as a targeted test, typecheck, or lint command. Summarize changed files, applied edits, and any not-applicable edits in 1-3 lines.
