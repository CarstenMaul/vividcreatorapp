# VCA App Patterns Reference

Companion to `SKILL.md` and `vca-design-tokens-reference.md`. Covers the component patterns the main skill omits — the patterns that distinguish a working app from a marketing page. Use these in Web app mode (the default).

All token names below refer to either the core tokens in `SKILL.md` (`--vca-*`) or the extended tokens in `vca-design-tokens-reference.md` (`--cl*`, `--spacing-*`, etc.). Where a value is hard-coded, that value comes from the existing system.

---

## Modal / dialog

Used for focused tasks that require taking the user out of the main flow (confirm a destructive action, edit an item, complete a short form).

- Backdrop: `rgba(0, 0, 0, 0.6)` (matches `--cl-modal-backdrop` in tokens reference).
- Container: white (`--vca-card-bg`), `border-radius: 6px`, max-width 480px for confirmations / 640px for forms, padding 24px.
- Header: title only (sentence case, H3 size — 16px / weight 600). No descriptive subtitle by default.
- Body: one short paragraph max if explanation is needed; otherwise jump straight to the form / content.
- Footer: right-aligned action row, primary action on the right, secondary / cancel to its left. One primary action only.
- Close affordance: `Esc` key + visible close (icon button, top-right). Trap focus inside the modal while open; restore focus to the trigger on close.
- Do not nest modals. Do not auto-open modals on page load.

## Toast / inline alert

Use a **toast** for transient feedback after an action ("Reminder saved"). Use an **inline alert** for state that persists until the user resolves it ("Your session expired").

- Variants reuse status tokens: success `--vca-green`, warning `--vca-warning`, error `--vca-error`, info `--vca-info`.
- Toast: bottom-right or top-right, `border-radius: 6px`, padding 12px 16px, white text on the status color, auto-dismiss after 4–6s (longer for errors), dismissible by click. Stack vertically with 8px gap.
- Inline alert: full-width inside its container, `border-radius: 6px`, light-tint background (status color at ~10% opacity) with a 1px left border in the full status color, dark text. Optional dismiss button.
- Copy is short, concrete, no apology. "Reminder saved." not "Great news! Your reminder has been successfully saved to the database."

## Sidebar / app shell

For apps with more than ~3 top-level destinations.

- Width: 240px expanded, 56px collapsed (icon-only). Collapse state persists per user.
- Background: white (`--vca-card-bg`) or very light grey, with a 1px right border in `--vca-divider`. The dark navy `--vca-nav-bg` is reserved for the top header bar.
- Active item: left border 3px in `--vca-accent` + background `rgba(87, 115, 151, 0.08)`. Text in `--vca-text`.
- Hover item: background `rgba(87, 115, 151, 0.04)`.
- Item height: 36px, padding 8px 12px, icon 18–20px + label.
- Group headings: 12px / weight 600 / `--vca-text-muted` / uppercase only here (the one exception to the no-uppercase rule, used as a quiet section label).

## Empty state

Shown when a list, table, or result panel has no content yet. This is the *correct* place for explanatory prose — not under section headers.

- Vertical center inside the empty container, max-width ~360px.
- Optional icon (24–32px, `--vca-text-muted`).
- Title: one line, sentence case, H3 size.
- Helper sentence: one short sentence telling the user what to do or what will appear here.
- One primary action (button) when there is a clear next step ("Add your first reminder"). Skip the button when the empty state is informational only.
- Do not stack multiple paragraphs, multiple buttons, or illustrations larger than ~120px.

## Loading state

Prefer skeletons over spinners for content; use spinners only for in-flight actions.

- **Skeleton:** light grey blocks (`--cl05` / `#dcdcdc`) at the rough shape of the upcoming content, with a subtle shimmer (CSS gradient, 1.5s loop). One skeleton per card, not per text line. Do not skeleton the entire page.
- **Action spinner:** 14–16px circle, replaces the button label or sits to its left. Disable the button while in flight. Keep button width stable to avoid layout shift.
- **Page-level spinner:** allowed only for the very first paint when no skeleton makes sense. Centered, single 24px spinner, no text.
- Do not show a spinner for operations expected to complete in under ~150ms — they finish before the spinner becomes useful and only add flicker.

## Error state

- **Inline field error:** below the input, 12px font, color `--vca-error`. Input border switches to `--vca-error`. Copy is concrete: "Required", "Use a valid email", "Title must be 100 characters or fewer". No apology, no exclamation marks.
- **Section-level error:** an inline alert (see above) at the top of the affected card / section, error variant.
- **Page-level error:** a centered empty-state-style block with title ("Something went wrong loading reminders"), one short helper sentence, and a "Retry" primary action. Avoid stack traces in the user UI — log them to console / telemetry instead.

## Icon button

For toolbar actions, row actions, and close buttons.

- Square, 32px × 32px, `border-radius: 6px`, transparent background, icon centered (18–20px).
- Hover: background `rgba(0, 0, 0, 0.06)`. Active: background `rgba(0, 0, 0, 0.10)`.
- Always include an `aria-label` or visible tooltip — icon-only is invisible to screen readers and to anyone who doesn't recognize the icon.
- Use line-style icons (Lucide, Heroicons). Do not mix line and filled icons in the same toolbar.

## Dense table

For lists of records (most apps need this).

- Row height 36–40px (compact) or 44–48px (comfortable). Pick one per app and keep it consistent.
- Header: `--vca-text-secondary`, weight 600, 13px, with a 2px bottom border in `--vca-divider`. No background fill.
- Row separator: 1px bottom border in `#f1f1f1` (already in `SKILL.md`). Zebra striping is OFF by default — turn it on only when the table is very wide and rows are hard to follow.
- Row hover: background `#f7f7f7`. Selected row: background `rgba(87, 115, 151, 0.08)` + 2px left border in `--vca-accent`.
- Numeric columns right-aligned; date columns use a single consistent format per app.
- Row actions (edit, delete) live in a trailing column as icon buttons, revealed on row hover (or always-on for touch).
- Empty table: render the empty state pattern above inside the table body, spanning all columns.

## Form validation copy

Short, concrete, no apology. Tell the user what to do, not how the system feels about it.

| Bad | Good |
|---|---|
| "Oops, something went wrong with this field." | "Required" |
| "We couldn't process your input." | "Use a valid email address" |
| "Please make sure your password is strong enough." | "Use 8+ characters with one number" |
| "This field is mandatory and cannot be left empty." | "Required" |

- Validate on blur for individual fields; validate the whole form on submit.
- Do not block typing inside an invalid field — let the user finish, then show the error.
- Surface server-side errors in the same place and style as client-side errors.

## Settings / "About" panel (where infrastructure detail belongs)

Per `<hide_infrastructure>` in `SKILL.md`, infrastructure detail must not appear in the main UI. When it does need to be inspectable, put it here.

- Reachable from a gear / "Settings" link, an "About" link in the footer, or a `?debug=1` query param.
- Group as a plain definition list: `App version`, `Backend`, `Auth`, `Last sync`, etc., label on the left, value on the right in monospace if it's an identifier.
- This panel is also the right place for "Copy diagnostics" buttons that bundle these values for support.
