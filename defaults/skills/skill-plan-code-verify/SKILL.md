---
name: plan-code-verify
description: Run a disciplined plan → code → verify workflow, switching to the best-fitting LLM profile for each phase and handing off through a plan file. Use when the user asks you to plan before building, wants a plan/code/verify (or plan/implement/review) cycle, or asks that the best model be used for each step.
---

# Plan → Code → Verify

<context>
Three phases, one chat. Each phase runs on the LLM profile that fits it best: deep reasoning to plan, a balanced coder to build, a *different* model to review. You switch profiles yourself with `set_llm_config` — the run never stops.

The phases hand off through a **plan file** on disk, not through your memory of the conversation. That is deliberate: the chat may be compacted between phases, and each profile switch changes the context window you are working with. The file is the contract.
</context>

<when_to_use>
Use this workflow when the user asks for any of:
- "plan it first, then build it"
- "plan / code / verify", "plan, implement, review"
- "use the best model for each step"
- a change big enough that they want to approve the approach before you write code

Do **not** use it for small iterative edits ("make the button blue", "fix the layout"). The overhead is not worth it — just make the change.
</when_to_use>

<phase_0_survey>
Do this once, on whatever model the chat is already running.

1. Call `list_llm_profiles`.
2. **Record `currentProfileId`** — the profile this chat started on. You switch back to it at the very end.
3. Pick three profiles using `<profile_rubric>` below. They may overlap if the fleet is small.
4. Say nothing about this step to the user yet; it folds into the announcement in phase 1.

**If fewer than two profiles have `switchable: true`** (including a deployment where every entry reports `switchable: false` because the LLM is configured server-side): keep all three phases, the plan file and the sign-off gate, skip the switching entirely, and tell the user once — "Only one model is available here, so all three phases run on it." Do not repeat it.
</phase_0_survey>

<profile_rubric>
`list_llm_profiles` gives you, per profile: `strengths` (the admin's own note), and `capabilities` with `input`, `reasoning`, `reasoningEfforts`, `contextWindow`, `maxOutputTokens`, `costPerMTokUsd`, `costTier`, `metadataSource`.

| Phase | Prefer | Reasoning effort |
|---|---|---|
| **PLAN** | a `strengths` note about reasoning, architecture or hard problems; the largest `contextWindow`; `costTier` `premium` is fine here | the **highest** entry in that profile's `reasoningEfforts` |
| **CODE** | `reasoning: true`, large `maxOutputTokens` (you are writing a lot), `costTier` `standard` / `budget` / `subscription` | `medium` — `high` only for intricate work |
| **VERIFY** | a **different profile from CODE** whenever one exists. An independent model catches what the author's own blind spots hid | `high`, or the highest available |

**The admin's `strengths` note wins** over these numeric heuristics whenever it speaks to the phase. It was written by someone who knows this fleet; the numbers are only a fallback.
</profile_rubric>

<hard_constraints>
These are not suggestions. Violating them wastes a turn or silently produces wrong behaviour.

1. **Skip profiles with `switchable: false`.** They sign in with a session-bound OAuth credential that cannot be swapped into a running chat; the reason is in `notSwitchableReason`. Choosing one only produces an error.

2. **Only pass a `reasoningEffort` that appears in that profile's `capabilities.reasoningEfforts`.** Anything higher is silently clamped — you will think you raised the effort when you did not.

3. **`metadataSource: "fallback"` means the numbers are estimates.** That model id is not in the bundled catalog, so `contextWindow` and `maxOutputTokens` are provider-shaped defaults. Do not build a large-context strategy on them.

4. **Vision is fixed for the whole chat, and switching cannot change it.** The `screenshot` tool decided whether it can return images when this chat was created, based on the model in use *at that moment*. So:
   - If the work may need `screenshot`, never switch to a profile whose `capabilities.input` lacks `"image"` — the tool will still capture and hand an image to a model that cannot read it.
   - If `screenshot` already tells you the current model is text-only, a profile switch will **not** fix it. Tell the user to change the model profile in Settings and start a new chat.

5. **Announce every switch in the same message as the `set_llm_config` call** — which profile and effort you are moving to, and why. The `reason` you pass is user-facing.

6. **Switching does not stop you.** After the tool returns, keep working. Do not end your turn or ask the user to confirm the switch.

7. **Switch back at the end.** After phase 3, return to the profile recorded in phase 0, so the user's next message does not silently run on the review model.
</hard_constraints>

<phase_1_plan>
Switch to the PLAN profile at its top effort, announcing it.

Then:
1. **Explore before planning.** `read`, `grep`, `ls` the parts of the workspace the task touches. Call `list_requirements` if the task involves requirements. Do not plan against assumptions you have not checked.
2. **Generate a random 8-character lowercase hex id** (e.g. `a1b2c3d4`) — same convention as the diagram ids.
3. **`write` the plan to `.vca-plans/plan-<id>.md`** in the format below. `write` creates the directory for you — no `mkdir` needed. `.vca-*` is git-ignored, so plan files never land in the user's commits.
4. **Summarise in one or two sentences** — the id, the step count, the files it touches. Do not paste the plan into the chat.
5. **Gate on `ask_question`** with options like: "Build it" / "Adjust the plan first" / "Show me the full plan".

**Write no project code in this phase.** The plan file is the only thing you create.

Plan file format:

```markdown
---
id: a1b2c3d4
title: Add CSV export to the orders table
status: planned
profiles:
  plan: Opus – hard reasoning
  code: Sonnet – balanced
  verify: Gemini – second opinion
---

## Goal
What the user gets when this is done, in two or three sentences.

## Constraints & assumptions
What you checked, what you are assuming, what would invalidate the plan.

## Steps
- [ ] 1. Add `GET /api/orders.csv` to `server.js` — streams the existing orders array as CSV
- [ ] 2. Add an Export button to `public/components/Orders.jsx` that links to it

## Files
- `server.js` — new route
- `public/components/Orders.jsx` — new button

## Verification
_(filled in by the verify phase)_
```

`status` moves `planned` → `coded` → `verified`.
</phase_1_plan>

<phase_2_code>
Only after the user approves. If they chose "Adjust the plan first", stay on the PLAN profile, revise the file, and gate again.

Switch to the CODE profile, announcing it. Then:

1. **`read` the plan file.** It is the contract. Do not re-derive the approach from what you remember of the planning conversation — that reasoning happened on a different model and may have been compacted away.
2. **Work step by step.** After finishing each step, `edit` the plan file to tick its checkbox. This is what makes the workflow survive a compaction mid-build: a fresh context can `read` the file and see exactly where you are.
3. **If a step turns out to be wrong**, do not silently improvise. Update the step in the plan file to say what you actually did and why, then continue.
4. When every box is ticked, set `status: coded`.
5. The system prompt's diagram-maintenance rule still applies — update the diagrams as the final step of coding, before handing to verify.
</phase_2_code>

<phase_3_verify>
Switch to the VERIFY profile at high effort, announcing it. Use a different profile from CODE whenever the fleet has one.

1. **Re-`read` the plan file first.** Verify against what the plan promised, not against your memory of writing the code.
2. **Check each step actually landed:**
   - `read` / `grep` the files each step claimed to touch — confirm the change is really there and does what the step said.
   - `get_server_log` — look for runtime errors, crashes, 500s the coding phase did not notice.
   - For UI work: `restart_app_process` (Vite-built frontends are not rebuilt automatically), then `screenshot` — and describe what you actually see, subject to constraint 4 above.
3. **Append a `## Verification` section** to the plan file: a verdict per step, anything you found, and — importantly — anything you could **not** verify and why. An unverifiable step is a finding, not something to gloss over.
4. **Set `status: verified`** only when every step checks out. If something failed, leave `status: coded`, record it in the Verification section, and report it plainly.
5. **On a defect:** fix it here only if it is trivial and clearly in scope. Anything larger — say what is wrong and offer to re-enter the CODE phase rather than quietly redesigning.
6. **Switch back to the starting profile** recorded in phase 0.
7. Report to the user in a sentence or two: what was built, what was verified, what was not.
</phase_3_verify>

<worked_example>
```
list_llm_profiles
  → 3 profiles: "Opus – hard reasoning" (premium, efforts medium/high, 200k),
                "Sonnet – balanced" (standard, efforts medium/high/xhigh/max, 200k),
                "ChatGPT sub" (switchable: false — skip)
  → currentProfileId: sonnet

set_llm_config(profile: opus, reasoningEffort: high,
               reason: "planning the CSV export on the strongest reasoning model")
  "Switching to Opus at high effort to plan this out."
  read/grep server.js, public/components/Orders.jsx
  write .vca-plans/plan-a1b2c3d4.md
  "Plan written — 2 steps, touches server.js and Orders.jsx."
  ask_question → user picks "Build it"

set_llm_config(profile: sonnet, reasoningEffort: medium,
               reason: "implementing the approved plan on the balanced coding model")
  "Moving to Sonnet to build it."
  read .vca-plans/plan-a1b2c3d4.md
  ...implement step 1, tick box, implement step 2, tick box, status: coded

set_llm_config(profile: opus, reasoningEffort: high,
               reason: "independent review of the implementation")
  "Switching back to Opus for an independent review."
  read .vca-plans/plan-a1b2c3d4.md, grep the changed files, get_server_log, screenshot
  append ## Verification, status: verified

set_llm_config(profile: sonnet, reason: "restoring this chat's original model")
```
With only two usable profiles the verify phase reuses the PLAN profile — that is fine, as long as it differs from CODE.
</worked_example>
