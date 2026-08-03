---
name: frontend-design
description: Apply VCA corporate design system to web apps by default (forms, tools, dashboards, internal apps). Tightens microcopy, removes redundant descriptions, and hides infrastructure from end-user UI, while keeping VCA colors, typography, and components. Use the marketing-page section only when the request is explicitly a landing or content page.
---

# VCA Frontend Design Skill

<context>
Apply these rules whenever generating CSS, HTML, or frontend component code. All apps should use the VCA corporate design system.

**Default mode is Web app**, not marketing page. The vast majority of generated UIs are working apps (forms, dashboards, CRUD tools, internal utilities). Apply marketing-page patterns (full-bleed hero, headline + supporting sentence, dominant image) ONLY when the request is explicitly a landing page, marketing site, product page, brochure, or campaign. See `<mode_selection>` and `<marketing_pages_secondary>`.

If the user explicitly requests a deviation (e.g., different colors, dark theme, alternate layout), follow their instruction but note where it differs from the VCA design system. If a request conflicts with this design system and the intent is ambiguous, ask for clarification rather than guessing. If proceeding with an assumption, state it clearly.

For full design token reference (all grayscale values, spacing scale, transparency utilities, nature palette), read `vca-design-tokens-reference.md` in this skill directory. For app-specific component patterns (modal, toast, sidebar, empty / loading / error states, icon button, dense table, validation copy), read `vca-app-patterns-reference.md`.
</context>

<mode_selection>
Pick the mode before generating any markup.

**Web app (default).** Use this mode for anything described as an app, tool, dashboard, form, CRUD, internal tool, generator, list, editor, viewer, calculator, admin panel, configurator, or similar — i.e., almost everything. In app mode, follow `<microcopy_app_mode>`, `<hide_infrastructure>`, and `<density_and_hierarchy>`. Do NOT add hero headers, eyebrow tags, or descriptive subtitles under section titles.

**Marketing page.** Use this mode ONLY when the request explicitly says landing page, marketing site, product page, brochure, or campaign. In marketing mode, the rules in `<marketing_pages_secondary>` apply (hero, supporting sentence, dominant image, etc.).

If unsure, choose Web app.
</mode_selection>

<design_foundation>
The VCA design system aesthetic is clean, professional, and functional. The visual identity (Open Sans, navy `#004673`, accent `#577397`, 6px radii, `#e6e6e6` page background, no shadows) applies to every output. The *layout and copy density*, however, depend on the mode chosen in `<mode_selection>` — apps are compact and action-led; marketing pages are spacious and narrative.

Core principles:
1. Clean and professional — no visual clutter, generous whitespace.
2. Light grey page background (`#e6e6e6` or `#eeeeee`) with white content areas.
3. Muted blue accents (`#577397`) for interactive elements.
4. Dark navy (`#004673`) for headers and navigation.
5. Soft rounding (`border-radius: 6px`) on interactive elements and cards.
6. No heavy shadows — use white-on-grey contrast to create depth.
7. Open Sans typography with clear hierarchy.

Adapt the layout to suit the app type — a game doesn't need a dashboard grid, and a form doesn't need a card layout. But always use the VCA color palette, typography, and component styles.
</design_foundation>

<typography>
```css
font-family: "Open Sans", "Helvetica Neue", "Lucida Grande", Helvetica, Arial, sans-serif;
```

| Element | Size | Weight | Line-Height |
|---------|------|--------|-------------|
| Page title / H1 | 1.5rem (24px) | 600 | 2rem |
| Section heading / H2 | 1.125rem (18px) | 600 | 1.5rem |
| Card title / H3 | 1rem (16px) | 600 | 1.375rem |
| Body text | 15px | 400 | 1.5 |
| Small / caption | 13px | 400 | 1.4 |
| Label / meta | 12px | 600 | 1.3 |

Text color: `rgb(23, 23, 25)` for body, `#666666` for secondary, `#999999` for muted.

Headings are sentence case (not uppercase). Keep them concise and functional.
</typography>

<core_colors>
| Token | Value | Usage |
|-------|-------|-------|
| `--vca-nav-bg` | `#004673` | Navigation bar, primary dark background |
| `--vca-nav-text` | `#ffffff` | Text on dark backgrounds |
| `--vca-accent` | `#577397` | Primary buttons, active states, links |
| `--vca-accent-hover` | `#455f7d` | Button/link hover state |
| `--vca-green` | `#9bc444` | Success, positive indicators |
| `--vca-page-bg` | `#e6e6e6` | Page background |
| `--vca-card-bg` | `#ffffff` | Card/panel/content area background |
| `--vca-card-border` | `#d9d9d9` | Subtle borders (optional) |
| `--vca-text` | `rgb(23, 23, 25)` | Primary text |
| `--vca-text-secondary` | `#666666` | Secondary text |
| `--vca-text-muted` | `#999999` | Muted/placeholder text |
| `--vca-divider` | `#e6e6e6` | Dividers, separators |
| `--vca-dark-tile` | `#3d3d3d` | Dark backgrounds for tiles/footers |
| `--vca-error` | `#ce0000` | Error states |
| `--vca-warning` | `#f07800` | Warning states |
| `--vca-info` | `#377b78` | Info/teal accent |
</core_colors>

<component_styles>
Header / Navigation Bar:
```css
header, .app-header {
  background: #004673;
  color: #ffffff;
  height: 52px;
  display: flex;
  align-items: center;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 100;
  font-size: 14px;
  font-weight: 600;
}
```

Buttons:
```css
/* Primary */
.btn, button[type="submit"] {
  background: #577397;
  color: #ffffff;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
button:hover { background: #455f7d; }

/* Secondary */
.btn-secondary {
  background: transparent;
  color: #577397;
  border: 1px solid #577397;
  border-radius: 6px;
  padding: 8px 16px;
}
.btn-secondary:hover { background: rgba(87, 115, 151, 0.08); }
```

Cards / Content Panels:
```css
.card {
  background: #ffffff;
  border-radius: 6px;
  padding: 20px;
  border: 1px solid transparent; /* optional: #d9d9d9 */
}
```
No box shadows by default — use white-on-grey contrast. `border-radius: 6px`. Optional thin border `#d9d9d9` for extra definition.

Form Inputs:
```css
input, select, textarea {
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  color: rgb(23, 23, 25);
  background: #ffffff;
}
input:focus, select:focus, textarea:focus {
  border-color: #577397;
  outline: none;
  box-shadow: 0 0 0 2px rgba(87, 115, 151, 0.15);
}
```

Tables:
```css
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th {
  text-align: left;
  padding: 10px 12px;
  font-weight: 600;
  color: #666666;
  border-bottom: 2px solid #e6e6e6;
  font-size: 13px;
}
td {
  padding: 10px 12px;
  border-bottom: 1px solid #f1f1f1;
}
tr:hover td { background: #f7f7f7; }
```

Status Badges:
Small rounded pills — green (`#9bc444`), orange (`#f07800`), red (`#ce0000`) with white text, `border-radius: 12px`, `padding: 2px 10px`, `font-size: 12px`. Use status badges only to convey state to the user (e.g., "Open", "Done", "Failed"). Do NOT use them as decoration or to label backend technology (see `<hide_infrastructure>`).
</component_styles>

<microcopy_app_mode>
These rules apply in Web app mode. They are the single biggest difference between an app that looks like an app and an app that looks like a brochure. Apply them strictly.

1. **No descriptive subtitles under section / card titles** when the controls below already make the purpose obvious. A card titled "Add reminder" with `Title`, `Notes`, and `Due date` fields needs no helper sentence like *"Create a reminder with optional notes and a due date."* The form *is* the description.

2. **No marketing eyebrows above titles.** Do not place tag-style labels like `MINIMAL APP`, `INTERNAL TOOL`, `DASHBOARD`, or `BETA` above a page title in app mode. App pages start with the title.

3. **No hero-style page headers in apps.** The page title is one line, sentence case, no supporting sentence by default. A short context line is allowed only when it carries information the rest of the UI cannot — e.g., the active dataset name, the current scope, the user's role. Place such context inline near the relevant control when possible, not as a hero subtitle under the title.

4. **Action-led titles over noun-led titles.** Prefer `Add reminder`, `Edit profile`, `Search` over `Reminder creation form`, `Profile editing area`, `Search interface`.

5. **Help text only when something is non-obvious.** If a field needs explanation, put a single short hint *under that specific input* (or as placeholder text, or as an inline icon-tooltip). Do NOT add a paragraph of explanation under the section heading. One sentence maximum.

6. **Empty states are the right place for explanatory prose** — not section headers. When a list, table, or result panel has nothing to show, show an empty state (one short title, one short helper sentence, one primary action). See `vca-app-patterns-reference.md`.

7. **Result/output panels do not get descriptive subtitles either.** A "Search results" panel does not need *"Review semantic matches, captions, and reranked reminder suggestions."* — the results themselves are self-evident. Show only a result count or active filter chips if they add information.
</microcopy_app_mode>

<hide_infrastructure>
The end-user UI must not surface backend, infrastructure, or auth detail. The model often treats these as "proof that it works" decoration; in app mode they are noise that confuses real users.

Do NOT show in the user-facing UI:
- Service or resource names (e.g., `xmwe-aizs-search-…`, `reminders-semantic`, `xmwegaicrmcp01.azurecr.io`)
- App, build, or instance identifiers (e.g., `icode_app_86602b62_dev`)
- Auth mechanism names (e.g., "Microsoft Entra ID token via DefaultAzureCredential", "Managed Identity")
- Connection strings, hostnames, or endpoint URLs
- Backend technology badges or chips (e.g., "PostgreSQL + semantic search", "Azure semantic", "Cosmos DB", "OpenAI")
- Sync, health, cache, or last-refresh timestamps presented as standalone status cards

Where these belong instead:
- An **admin / debug panel** behind a settings, "About", or `?debug=1` route.
- A **non-prod environment banner** shown only when not in production (e.g., a thin top stripe in dev / staging).
- Or simply **removed** — most of this information was never meant for the end user.

When the app genuinely needs to surface a backend signal to the user, express it in user terms. *"Search may be incomplete — refreshing now"* is acceptable; *"Semantic search is connected to reminders-semantic. Last sync: Apr 27, 2026, 08:52 AM"* is not.
</hide_infrastructure>

<density_and_hierarchy>
App density is tighter than marketing density. The same tokens, applied differently.

1. **Card padding:** 16–20px in apps (24–32px is for marketing pages).
2. **Vertical rhythm inside a form:** ~6–8px between label and its control, ~16px between fields, ~24px between field groups. Do not stretch this out for visual balance — a tight form is easier to scan.
3. **One header layer per card.** Pick exactly one of: title only; title + thin metadata row; title + one short context line. Do NOT stack title + descriptive subtitle + secondary metadata strip + form.
4. **One primary action per card / section / page.** Additional actions are tertiary or ghost buttons. Two competing primary buttons on the same card is a smell.
5. **Status pills, count chips, and metadata rows are allowed**, but they must convey live information. A static "Azure semantic" pill or a "PostgreSQL + semantic search" pill in the header is decoration — remove it.
6. **Cards should earn their place.** A KPI strip with `ALL 2 / OPEN 1 / DONE 1` is fine when the user actually filters by it; if it just exists to fill space, drop it or merge it into the list header.
</density_and_hierarchy>

<layout_guidelines>
1. Page background: Always `#e6e6e6` or `#eeeeee`.
2. Content areas: White (`#ffffff`) with `border-radius: 6px`.
3. Max content width: ~1200px centered, with 16-24px padding.
4. Responsive: Stack elements vertically on narrow screens.
5. Spacing: 8px for tight, 16px for normal, 24px for comfortable, 32px+ between sections.
6. Icons: Use simple line icons (Lucide, Heroicons, or similar), 20-24px.

Layout by app type (Web app mode):
- Dashboards: card grid with a single-line header. No hero, no subtitle.
- Forms / tools: centered content panel on grey background. Title only above the form.
- Games / interactive: full-screen canvas with VCA-styled UI overlays.
- Data visualization: white chart panels on grey background. Title + (optional) one-line context, no marketing copy.
- Landing pages: see `<marketing_pages_secondary>` — do NOT apply that section unless the request is explicitly a landing or marketing page.

Motion and animation:
1. Use subtle, purposeful transitions only — max 2-3 per page.
2. Prefer CSS transitions (e.g., `transition: 0.2s ease`) over JS-driven animation.
3. No decorative animations, parallax effects, or bouncing elements.
4. Acceptable uses: hover state transitions, page-section fade-ins, modal open/close.
</layout_guidelines>

<do_and_dont>
Do:
1. Use `Open Sans` or system sans-serif consistently.
2. Grey `#e6e6e6` page background with white content areas.
3. `border-radius: 6px` on cards, buttons, inputs.
4. Dark navy `#004673` for headers/nav.
5. Muted blue `#577397` for interactive elements.
6. Sentence case for headings.
7. Adapt layout to suit the app type.

Do not:
1. Use sharp corners (`border-radius: 0`) on UI elements.
2. Add heavy box shadows — rely on white-on-grey contrast.
3. Use bright/saturated blues — keep the muted `#577397` accent.
4. Use uppercase headings with letter-spacing.
5. Use decorative gradients or ornamental borders.
6. Force a dashboard layout on non-dashboard apps.
7. Add decorative pill clusters, stat strips, or icon rows that create visual clutter.
8. Place floating badges or promotional stickers over hero/media areas.
9. **(App mode) Add a descriptive sentence under a section / card / panel title** when the controls or content below already make the purpose obvious.
10. **(App mode) Add a marketing eyebrow tag** (e.g., `MINIMAL APP`, `INTERNAL TOOL`) above an app's page title.
11. **(App mode) Give a CRUD app a hero header with a supporting sentence.** App page headers are one line.
12. **(App mode) Surface infrastructure, connection, auth, or backend-tech detail in the user-facing UI.** See `<hide_infrastructure>`.
13. **(App mode) Use status pills as decoration** to label backend technology (e.g., a static "Azure semantic" or "PostgreSQL" pill in the header).
</do_and_dont>

<verification_checklist>
When generating frontend code, confirm:
1. Open Sans font import or `font-family` declaration is present.
2. CSS custom properties for core colors are defined (at minimum `--vca-nav-bg`, `--vca-accent`, `--vca-page-bg`, `--vca-card-bg`, `--vca-text`).
3. Page background is set to `#e6e6e6` or `#eeeeee`.
4. `border-radius: 6px` is applied to interactive elements and cards.
5. Responsive behavior is implemented (stack on narrow screens).

App-mode self-audit (skip only if you are explicitly in marketing mode):
6. The page header is a single line — no eyebrow tag, no hero subtitle.
7. No card / section / panel has a descriptive sentence under its title unless that sentence carries information the controls below do not.
8. No infrastructure identifiers, connection strings, hostnames, auth mechanism names, or backend-technology badges appear anywhere in the user-facing UI (see `<hide_infrastructure>`).
9. Each card / section has at most one primary action.
10. Empty / loading / error states are handled (see `vca-app-patterns-reference.md`) — explanatory prose lives there, not under section headers.
</verification_checklist>

<marketing_pages_secondary>
Apply this section ONLY when the request is explicitly a landing page, marketing site, product page, brochure, or campaign. Do NOT apply it to apps. If you are unsure, you are in app mode — see `<microcopy_app_mode>`.

In marketing mode:
1. **Hero:** full-bleed hero with brand name as hero-level signal, one headline, one supporting sentence, one CTA group, and one dominant image in the first viewport. No floating badges or overlays on hero media.
2. **Section content budget:** each section serves one purpose with one headline and usually one supporting sentence. Avoid competing text blocks, stat strips, or icon rows within a single section.
3. **Density is loose**, not tight: card padding 24–32px, generous vertical rhythm between sections (48–96px), large H1 sizes per `vca-design-tokens-reference.md` responsive scale.
4. **Below the hero:** content sections with VCA colors. Use the nature/material palette (`--storm`, `--wave`, `--norway`, etc., per the tokens reference) for thematic accents only, not as primary UI color.
5. The microcopy and infrastructure rules from app mode still apply where relevant (no exposed connection strings, no marketing eyebrows mid-page that look like UI tags, etc.).
</marketing_pages_secondary>
