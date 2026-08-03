---
name: docu-uml
description: Maintain UML diagrams (use-case, deployment, component, activity, ER) after every code change
---

After implementing or modifying any functionality, update all of the following diagram files as your final step. Read each file, update it, and write it back. Create the file if it does not exist.

Diagrams to maintain:
1. Use-Case Diagram (`.icode-usecase.json`)
2. Deployment Diagram (`.icode-deployment.json`)
3. Component Diagram (`.icode-component.json`)
4. Activity Diagrams (`.icode-activity-index.json` + `.icode-activity-{id}.json`) — only for complex multi-step workflows
5. ER Diagrams (`.icode-er-index.json` + `.icode-er-{id}.json`) — only when the app uses structured data storage

<abstraction_discipline>
These rules apply to every diagram type below. They override the per-diagram rules when in conflict.

1. **Each diagram type has one job — don't blur them.** Use-case = user-facing features. Deployment = runtime nodes and topology. Component = internal modules and ports. Activity = step-by-step workflow. ER = persisted data schema. If something fits two diagrams, it belongs in only one — the more specific diagram wins (e.g. an internal service goes in the component diagram, not in deployment; a token-acquisition step goes in an activity diagram, not as a use case).

2. **Stop when the next addition would be implementation noise.** Soft caps per diagram: ~12 use cases, ~10 deployment nodes, ~20 components, ~15 activity nodes per workflow. Going over is a signal to consolidate or move detail to a different diagram, not to keep adding.

3. **Do not invent a use case / component / node for an internal helper that a user, operator, or reviewer would not recognize as a meaningful unit.** Names ending in "selector", "guard", "runner", "client wrapper", "proxy", "controller helper" usually denote internal plumbing. Plumbing belongs in code or in the body of an activity diagram, never in the use-case or deployment top level.

4. **Shape sizes — pick S/M/L per diagram.** Every actor / useCase / node has an optional `"size": "S" | "M" | "L"` field (default `"S"`). Pick **one size for the whole diagram** — the smallest that fits the longest label in that diagram — and set it on every shape. The renderer grows the shape geometry to match. Use the table below to find the smallest size whose char cap covers your longest label. If the longest label still does not fit `L`, shorten it.

   | Shape | S cap | M cap | L cap |
   |---|---|---|---|
   | Use case (ellipse) | 16 chars (1 line) | 36 chars (≈2 lines × 18) | 66 chars (≈3 lines × 22) |
   | Deployment node | 14 (1 line) | 36 (2 × 18) | 66 (3 × 22) |
   | Deployment component | 16 (1 line) | 36 (2 × 18) | 66 (3 × 22) |
   | Component box | 32 (2 × 16) | 36 (2 × 18) | 66 (3 × 22) |
   | Activity action | 18 (1 line) | 44 (2 × 22) | 78 (3 × 26) |
   | Activity decision | 10 | 14 | 18 |
   | Interface (label) | 12 | 18 | 24 |
   | Actor (label) | 20 | 28 | 36 |
   | ER entity name | 24 | 32 | 40 |

   **Hard rule: stay within the cap of your chosen size.** Labels longer than the cap will wrap to extra lines that overflow the shape, and single words longer than the per-line wrap width will hard-break mid-word (ugly). If the shortest reasonable name still exceeds `L`, the concept is too coarse — abbreviate (drop generic suffixes like "verwaltung", "bearbeitung", "konfiguration"; turn German compound nouns into a head noun, e.g. "Personaleinsatzplanung" → "Einsatzplan") or split into two narrower shapes. The diagram-level positioning rules below give explicit coordinates per size — use those, not formulas.
</abstraction_discipline>

<diagram_format_usecase>
Use-Case Diagram (`.icode-usecase.json`) — what the app does (features, actors, interactions).

```json
{
  "actors": [
    { "id": "abc12345", "name": "User", "size": "M", "x": 80, "y": 100 },
    { "id": "bcd23456", "name": "External API", "size": "M", "x": 80, "y": 230 }
  ],
  "useCases": [
    { "id": "def45678", "name": "Login", "size": "M", "x": 350, "y": 100 },
    { "id": "jkl01234", "name": "Authenticate via API", "size": "M", "x": 350, "y": 230 }
  ],
  "connections": [
    { "actorId": "abc12345", "useCaseId": "def45678", "label": "" },
    { "actorId": "bcd23456", "useCaseId": "jkl01234", "label": "" }
  ],
  "relationships": [{ "id": "ghi78901", "fromUseCaseId": "def45678", "toUseCaseId": "jkl01234", "type": "include" }],
  "boundaries": [
    { "id": "b1a2c3d4", "name": "My App", "x": 220, "y": 30, "width": 520, "height": 300 }
  ]
}
```

Rules:
1. Use cases describe **what a human actor can accomplish**, not how the system implements it. Add only fachliche features a user, admin, or operator would name aloud (e.g. "Add reminder", "Search reminders", "Chat about reminders"). Exclude internal steps such as authentication flows, indexing, schema preparation, token acquisition, response rendering, scrolling, caching — those belong in the activity or component diagrams.
2. Add actors for **human roles** (User, Admin, Operator) and for **external systems** the app depends on (databases, APIs, identity providers). External-system actors are *supporting* actors — they assist a use case, they do not initiate one. Convention: arrows go from a human actor to the use case it triggers, and from a use case to the external system that supports it.
3. Add connections between actors and their use cases. Do not connect an external system directly to a use case as if it were the initiator.
4. Use `include` only for a **reusable fachliche sub-function** shared by two or more use cases (e.g. "Place order" and "Reorder past order" both include "Apply discount"). Do **not** use `include` for technical dependencies like database calls, authentication, indexing, or logging — those are component or activity concerns. Use `extend` sparingly, only for genuinely optional variations of a base use case. If you find yourself drawing more than 3–4 include/extend arrows total, you are over-modeling — remove the technical ones.
5. Use `boundaries` to group use cases visually. A single "App" boundary is usually enough; only split into multiple boundaries when there are clearly distinct user-facing surfaces.
6. Preserve existing `x`, `y` positions. New actors: `x: 80`, `y` incrementing by 130. New use cases: lay out in a **2-column grid inside the boundary**. Use these exact coordinates — the M/L variants are wider because the ellipses themselves are wider, and tighter spacing causes overlap:
   - **S**: col 1 `x: 350`, col 2 `x: 550`; rows start `y: 110`, spaced **120 apart**. Boundary `width: 460`.
   - **M**: col 1 `x: 370`, col 2 `x: 630`; rows start `y: 120`, spaced **150 apart**. Boundary `width: 540`.
   - **L**: col 1 `x: 400`, col 2 `x: 720`; rows start `y: 140`, spaced **180 apart**. Boundary `width: 620`.
7. **Always size the boundary to fit all contained use cases.** Height: `S → 80 + ceil(n/2) × 120 + 40`; `M → 100 + ceil(n/2) × 150 + 50`; `L → 120 + ceil(n/2) × 180 + 60`. Examples (S): 8 → 600. Examples (M): 8 → 750. Examples (L): 8 → 900.
8. Generate 8-character hex IDs for all `id` fields.
</diagram_format_usecase>

<diagram_format_deployment>
Deployment Diagram (`.icode-deployment.json`) — deployment architecture.

Same JSON format as use-case. `actors` = external nodes, `useCases` = internal components. Use multiple boundaries to separate deployment tiers.

```json
{
  "actors": [{ "id": "abc12345", "name": "Browser", "x": 80, "y": 100 }],
  "useCases": [
    { "id": "def45678", "name": "Express Server", "x": 350, "y": 110 },
    { "id": "ghi78901", "name": "React Frontend", "x": 850, "y": 110 }
  ],
  "connections": [{ "actorId": "abc12345", "useCaseId": "ghi78901", "label": "HTTPS" }],
  "relationships": [{ "id": "jkl01234", "fromUseCaseId": "ghi78901", "toUseCaseId": "def45678", "type": "dependency" }],
  "boundaries": [
    { "id": "b1server1", "name": "Server Tier", "x": 220, "y": 30, "width": 460, "height": 260 },
    { "id": "b2client1", "name": "Client Tier", "x": 720, "y": 30, "width": 460, "height": 260 }
  ]
}
```

Rules:
1. Deployment diagrams show **runtime nodes and what runs where**, not internal module structure. Add nodes for: client devices/browsers, CDNs, the application runtime (e.g. "Container App", "Express server"), databases, external SaaS APIs, identity providers. Do **not** add internal services like "Reminder API", "Search Sync Service", "OpenAI Chat Proxy", "Token Selector" — those belong in the component diagram. A typical app has 5–10 deployment nodes; if you reach 20+, you are listing modules instead of nodes.
2. The application's own internal services should appear as **at most one node** (e.g. "Application Runtime", "Express server"). The component diagram is where you decompose what runs inside that node.
3. Add connections with protocol labels (e.g. "HTTPS", "REST", "WebSocket", "SQL", "OAuth").
4. Add relationships (`"type": "dependency"`, `"type": "deploy"`, or `"type": "association"`). Reserve `deploy` for "X is deployed onto Y" relationships between a runtime and its host node.
5. Use multiple boundaries to separate deployment tiers (Client Tier, Server Tier, External Services). Place tiers side-by-side with a 40-px gap (e.g. tier 1 at `x: 220` width 460 → tier 2 at `x: 720`).
6. Generate 8-character hex IDs. External actors (left of all tiers): `x: 80`, `y` incrementing by 140 (S), 160 (M), 180 (L). Internal nodes inside a boundary use a 2-column grid relative to `boundary.x`/`boundary.y`. Use these exact offsets — they account for node-box width and leave a ~60-px edge gap:
   - **S**: col 1 `boundary.x + 130`, col 2 `boundary.x + 330`; rows start `boundary.y + 80`, spaced **130 apart**. Tier `width: 460`.
   - **M**: col 1 `boundary.x + 140`, col 2 `boundary.x + 380`; rows start `boundary.y + 95`, spaced **150 apart**. Tier `width: 520`.
   - **L**: col 1 `boundary.x + 160`, col 2 `boundary.x + 450`; rows start `boundary.y + 110`, spaced **180 apart**. Tier `width: 600`.
7. **Size each tier boundary to fit its contents:** Height = `S → 60 + ceil(n/2) × 130 + 40`; `M → 75 + ceil(n/2) × 150 + 50`; `L → 90 + ceil(n/2) × 180 + 60`. Apply to every boundary, not just the first. When placing tiers side-by-side, leave a 40-px gap between them (so tier 2's `x` = tier 1's `x + tier1.width + 40`).
</diagram_format_deployment>

<diagram_format_component>
Component Diagram (`.icode-component.json`) — internal component/module structure.

Same JSON format. `actors` = interfaces, `useCases` = components, `boundaries` = package boundaries.

```json
{
  "actors": [
    { "id": "abc12345", "name": "HTTP API", "x": 80, "y": 100 },
    { "id": "bcd23456", "name": "User Events", "x": 80, "y": 230 }
  ],
  "useCases": [
    { "id": "def45678", "name": "Express Routes", "x": 350, "y": 110 },
    { "id": "efg56789", "name": "Service Layer", "x": 350, "y": 240 },
    { "id": "fgh67890", "name": "App Component", "x": 850, "y": 110 },
    { "id": "ghi12345", "name": "State Manager", "x": 850, "y": 240 }
  ],
  "connections": [
    { "actorId": "abc12345", "useCaseId": "def45678", "label": "handles" },
    { "actorId": "bcd23456", "useCaseId": "fgh67890", "label": "triggers" }
  ],
  "relationships": [
    { "id": "ghi78901", "fromUseCaseId": "def45678", "toUseCaseId": "efg56789", "type": "dependency" },
    { "id": "hij89012", "fromUseCaseId": "fgh67890", "toUseCaseId": "def45678", "type": "dependency" }
  ],
  "boundaries": [
    { "id": "b1back123", "name": "Backend", "x": 220, "y": 30, "width": 460, "height": 340 },
    { "id": "b2front12", "name": "Frontend", "x": 720, "y": 30, "width": 460, "height": 340 }
  ]
}
```

Rules:
1. This is the diagram where internal module decomposition belongs — moved out of the deployment diagram. Add components for backend modules (routes, middleware, services, data access) and frontend modules (React components, state management, utilities). Group by responsibility (routes, services, data access, UI sections), not by file. Aim for ~5–10 components per boundary; merge trivial helpers into their parent component rather than listing each one.
2. If a node already exists as a deployment node (e.g. PostgreSQL, Microsoft Graph, Azure AI Search), reference it via the interface (`actors` slot) — do not redraw it as a component.
3. Add interfaces for API endpoints, event handlers, or external ports the components expose or consume.
4. Add connections with labels (e.g. "provides", "consumes", "renders", "calls").
5. Add relationships (`"type": "dependency"` or `"type": "association"`).
6. Use separate boundaries for Backend and Frontend, side-by-side with a 40-px gap. With size **S** boundaries are 460 wide → Backend at `x: 220`, Frontend at `x: 720`. With **M** boundaries are 520 → Frontend at `x: 780`. With **L** boundaries are 600 → Frontend at `x: 860`.
7. Generate 8-character hex IDs. Interfaces (left column, outside boundaries): `x: 80`, `y` incrementing by 130 (S), 150 (M), 170 (L). Components inside a boundary use a 2-column grid relative to `boundary.x`/`boundary.y` — use these exact offsets:
   - **S**: col 1 `boundary.x + 130`, col 2 `boundary.x + 330`; rows start `boundary.y + 80`, spaced **130 apart**. Boundary `width: 460`.
   - **M**: col 1 `boundary.x + 140`, col 2 `boundary.x + 380`; rows start `boundary.y + 95`, spaced **150 apart**. Boundary `width: 520`.
   - **L**: col 1 `boundary.x + 160`, col 2 `boundary.x + 450`; rows start `boundary.y + 110`, spaced **180 apart**. Boundary `width: 600`.
8. **Size each boundary to fit its components:** Height = `S → 60 + ceil(n/2) × 130 + 40`; `M → 75 + ceil(n/2) × 150 + 50`; `L → 90 + ceil(n/2) × 180 + 60`.
</diagram_format_component>

<diagram_format_activity>
Activity Diagrams (`.icode-activity-index.json` + `.icode-activity-{id}.json`) — complex multi-step workflows.

Create only for workflows with meaningful branching or sequential logic (checkout, registration, data import). Do **not** create one activity diagram per use case — most CRUD operations do not need their own activity diagram. Aim for at most 2–3 activity diagrams per app, covering the genuinely complex flows; combine related steps or drop the trivial ones.

Index: `{ "diagrams": [{ "id": "a1b2c3d4", "name": "Login Flow" }] }`

```json
{
  "id": "a1b2c3d4",
  "name": "Login Flow",
  "nodes": [
    { "id": "n1", "type": "start", "name": "", "x": 300, "y": 30 },
    { "id": "n2", "type": "action", "name": "Enter Credentials (Frontend)", "x": 250, "y": 120 },
    { "id": "n3", "type": "action", "name": "POST /api/login (Backend)", "x": 250, "y": 220 },
    { "id": "n4", "type": "decision", "name": "Valid?", "x": 300, "y": 320 },
    { "id": "n5", "type": "action", "name": "Return JWT (Backend)", "x": 200, "y": 420 },
    { "id": "n6", "type": "action", "name": "Show Dashboard (Frontend)", "x": 200, "y": 520 },
    { "id": "n7", "type": "action", "name": "Return 401 (Backend)", "x": 430, "y": 420 },
    { "id": "n8", "type": "action", "name": "Show Error (Frontend)", "x": 430, "y": 520 },
    { "id": "n9", "type": "end", "name": "", "x": 300, "y": 620 }
  ],
  "transitions": [
    { "id": "t1", "fromNodeId": "n1", "toNodeId": "n2" },
    { "id": "t2", "fromNodeId": "n2", "toNodeId": "n3" },
    { "id": "t3", "fromNodeId": "n3", "toNodeId": "n4" },
    { "id": "t4", "fromNodeId": "n4", "toNodeId": "n5", "label": "yes" },
    { "id": "t5", "fromNodeId": "n4", "toNodeId": "n7", "label": "no" },
    { "id": "t6", "fromNodeId": "n5", "toNodeId": "n6" },
    { "id": "t7", "fromNodeId": "n7", "toNodeId": "n8" },
    { "id": "t8", "fromNodeId": "n6", "toNodeId": "n9" },
    { "id": "t9", "fromNodeId": "n8", "toNodeId": "n2" }
  ]
}
```

Node types: `"start"`, `"end"`, `"action"`, `"decision"`, `"fork"`, `"join"`.

Rules:
1. Label action nodes with `(Frontend)` or `(Backend)` to indicate where each step executes.
2. Use `label` on transitions from decision nodes for guard conditions.
3. **Linear flow** — `x: 300`, `y` incrementing by 100 (S), 130 (M), or 160 (L). Generate 8-character hex IDs.
4. **Parallel branches** after a decision or fork — place each branch in its own column so they don't overlap. Use these column x-coordinates (centred on x=300):
   - **S**: 2 branches → `x: 200, 400`. 3 branches → `x: 140, 300, 460`.
   - **M**: 2 → `x: 160, 440`. 3 → `x: 80, 300, 520`.
   - **L**: 2 → `x: 120, 480`. 3 → `x: 40, 300, 560`.
   Re-converge to `x: 300` at the join/merge node. Keep the same `y` increment as linear flow within each column.
5. **Label length is enforced by the shape's char cap** (see rule 4 of `<abstraction_discipline>`). Action labels longer than the cap will hard-wrap mid-word (which looks ugly) — abbreviate German compound nouns or split a long step into two sequential actions instead. Aim for ≤6 words per label.
</diagram_format_activity>

<diagram_format_er>
ER Diagrams (`.icode-er-index.json` + `.icode-er-{id}.json`) — database entity schemas and relationships.

Create ER diagrams only for **persisted application data**, not for ephemeral request/response shapes, cache structures, or in-memory data. Skip the ER diagram entirely if the app uses no structured storage (e.g., a stateless proxy or API gateway).

One diagram per logical database. Do not split entities of the same database into multiple diagrams unless there are 15+ entities and a natural subdomain boundary; over-fragmenting a small schema across multiple files makes the data model harder to read, not easier. Use separate diagrams only when the app uses multiple distinct databases or data sources.

Index: `{ "diagrams": [{ "id": "a1b2c3d4", "name": "User Database" }] }`

```json
{
  "id": "a1b2c3d4",
  "name": "User Database",
  "entities": [
    { "id": "e1", "name": "User", "attributes": [
      { "name": "id", "type": "int", "pk": true },
      { "name": "email", "type": "string" },
      { "name": "name", "type": "string" }
    ], "x": 100, "y": 100 },
    { "id": "e2", "name": "Order", "attributes": [
      { "name": "id", "type": "int", "pk": true },
      { "name": "userId", "type": "int", "fk": true },
      { "name": "total", "type": "decimal" }
    ], "x": 400, "y": 100 }
  ],
  "relationships": [
    { "id": "r1", "fromEntityId": "e1", "toEntityId": "e2", "fromCardinality": "1", "toCardinality": "0..*", "label": "places" }
  ]
}
```

Rules:
1. Include all entity attributes with types. Mark primary keys (`"pk": true`) and foreign keys (`"fk": true`).
2. Cardinality values: `"1"`, `"0..1"`, `"*"`, `"1.."`, `"0..*"`.
3. Label relationships with verbs (e.g. "places", "belongs to", "contains").
4. New entities: `x` incrementing by 300 (S), 340 (M), 380 (L); `y: 100`. Generate 8-character hex IDs.
5. If the index file does not exist, create it. If adding a new diagram, append to the index.
</diagram_format_er>
