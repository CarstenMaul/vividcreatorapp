# VCA Design Tokens — Full Reference

This file contains the complete design token tables. Read this when you need exact values for grayscale, nature palette, transparency, spacing, or responsive typography.

---

## Grayscale (cl01–cl16)

| Token | Hex | Usage |
|-------|-----|-------|
| `--cl01` | `#ffffff` | White, page backgrounds |
| `--cl02` | `#fcfcfc` | Off-white, subtle backgrounds |
| `--cl03` | `#f7f7f7` | Light grey backgrounds |
| `--cl04` | `#f5f5f5` | Alternate section backgrounds |
| `--cl05` | `#f1f1f1` | Card backgrounds, dividers |
| `--cl06` | `#e6e6e6` | Borders, separators |
| `--cl07` | `#e3e3e3` | Light borders |
| `--cl08` | `#d9d9d9` | Input borders, disabled states |
| `--cl09` | `#cccccc` | Disabled text, muted elements |
| `--cl10` | `#b4b4b4` | Placeholder text |
| `--cl11` | `#999999` | Secondary/muted text |
| `--cl12` | `#707070` | Helper text, captions |
| `--cl13` | `#666666` | Subtle body text |
| `--cl14` | `#5c5c5c` | Subdued text |
| `--cl15` | `#3d3d3d` | Dark text, headings on light bg |
| `--cl16` | `#000000` | Black, primary body text |

## Blue Accents

| Token | Hex | Usage |
|-------|-----|-------|
| `--cl17` | `#376eb4` | Links, interactive blue |
| `--cl18` | `#0a5a96` | Primary blue (same as brand-primary) |
| `--cl19` | `#004673` | Dark blue (same as brand-primary-dark) |

## Status / Feedback Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--cl20` | `#008800` | Success, positive feedback |
| `--cl21` | `#f07800` | Warning, caution |
| `--cl22` | `#ce0000` | Error, danger, destructive actions |
| `--cl23` | `#377b78` | Teal accent, informational |

## Nature / Material Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--storm` | `#566777` | Dark blue-grey, muted UI elements |
| `--wave` | `#7d8fae` | Medium blue-grey, secondary elements |
| `--sky` | `#c1cfe0` | Light blue, backgrounds, highlights |
| `--norway` | `#9abd90` | Green accent, sustainability themes |
| `--cliff` | `#4d4e53` | Dark grey, footer, subtle dark bg |
| `--stone` | `#b3b7bc` | Grey, neutral borders and dividers |
| `--porcelain` | `#f1f2f2` | Very light grey, section backgrounds |
| `--earth-clay` | `#735e4e` | Warm brown, premium/earthy elements |
| `--earth-sand` | `#cfae86` | Sand/beige, warm accents |

## Transparency Utilities

| Token | Value | Usage |
|-------|-------|-------|
| `--white-40` | `rgba(255,255,255,0.4)` | Overlay on images |
| `--white-70` | `rgba(255,255,255,0.7)` | Light overlay |
| `--white-80` | `rgba(255,255,255,0.8)` | Card overlay on hero |
| `--white-90` | `rgba(255,255,255,0.9)` | Near-opaque overlay |
| `--black-08` | `rgba(0,0,0,0.08)` | Subtle shadow/border |
| `--black-26` | `rgba(0,0,0,0.26)` | Disabled overlay |
| `--black-70` | `rgba(0,0,0,0.7)` | Text on light images |
| `--black-80` | `rgba(0,0,0,0.8)` | Dark overlay |
| `--color-backdrop` | `rgba(0,0,0,0.6)` | Modal backdrop |

## Full Spacing Scale

| Token | Value | Pixels (base 16px) |
|-------|-------|---------------------|
| `--spacing-0` | `0` | 0px |
| `--spacing-1` | `0.25rem` | 4px |
| `--spacing-2` | `0.5rem` | 8px |
| `--spacing-3` | `1rem` | 16px |
| `--spacing-4` | `1.5rem` | 24px |
| `--spacing-5` | `2rem` | 32px |
| `--spacing-6` | `4rem` | 64px |
| `--spacing-7` | `8rem` | 128px |

### Named Spacing Aliases
| Token | Value |
|-------|-------|
| `--spacing-s` | 1.5rem (24px) |
| `--spacing-m` | 1.875rem (30px) |
| `--spacing-l` | 2.25rem (36px) |
| `--spacing-xl` | 2.5rem (40px) |

### Section Spacing (GDDS)
- Accordion: top `1.5rem`, bottom `2rem`
- Tabs: top `1.5rem`, bottom `1.5rem`
- Nordics (regional variant): mobile `4rem 0`, desktop `5rem 0`

## Responsive H1 Sizes (GDDS)

| Breakpoint | Font Size | Line Height |
|-----------|-----------|-------------|
| S (mobile) | 1.75rem (28px) | 2.25rem (36px) |
| M (tablet) | 2.25rem (36px) | 2.75rem (44px) |
| L (desktop) | 2.625rem (42px) | 3.25rem (52px) |
| XL (wide) | 2.875rem (46px) | 3.75rem (60px) |
