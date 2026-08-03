---
name: modern-react
description: Default frontend architecture for all apps — React 19 + Tailwind CSS v4 + Babel JSX via CDN, no build tools. Frontend lives in the public/ directory and is served by Express.
---

# Modern React Stack (CDN, No Build Tools)

<context>
Use this architecture for every app's frontend.
The frontend lives in the `public/` directory and is served by the Express backend (see `node-backend` skill). For visual styling (colors, fonts, component look), also read and apply the `frontend-design` skill.
</context>

<core_setup>
Every `public/index.html` should include:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App</title>
  <!-- Tailwind CSS v4 -->
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <!-- Required: resolves bare React imports — including `react/jsx-runtime` that Babel's automatic JSX runtime emits. -->
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19",
      "react/": "https://esm.sh/react@19/",
      "react-dom": "https://esm.sh/react-dom@19",
      "react-dom/": "https://esm.sh/react-dom@19/"
    }
  }
  </script>
  <!-- Pin Babel: an upstream default change can flip the JSX preset to the automatic runtime, which emits bare `react/jsx-runtime` imports the browser can't resolve. -->
  <script src="https://unpkg.com/@babel/standalone@7.26.10/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-type="module">
    import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
    import { createRoot } from "react-dom/client";

    function App() {
      return (
        <div className="min-h-screen bg-gray-50">
          <h1 className="text-3xl font-bold text-gray-900 p-8">Hello World</h1>
        </div>
      );
    }

    createRoot(document.getElementById("root")).render(<App />);
  </script>
</body>
</html>
```
</core_setup>

<icons>
lucide-react (primary icon library):

```jsx
import { Heart, Search, Menu, X, ChevronDown, Star, Settings, User } from "https://esm.sh/lucide-react";

// Usage: <Heart className="w-5 h-5 text-red-500" />
```

react-icons (additional icon sets):

```jsx
import { FaGithub, FaTwitter } from "https://esm.sh/react-icons/fa";
import { HiOutlineSparkles } from "https://esm.sh/react-icons/hi2";

// Usage: <FaGithub className="w-5 h-5" />
```

Available react-icons sets: `fa` (Font Awesome), `hi2` (Heroicons v2), `bi` (Bootstrap), `si` (Simple Icons), `md` (Material Design).
</icons>

<component_patterns>
Accessible components — build using native HTML semantics + Tailwind:
1. Use `<button>`, `<dialog>`, `<details>` over custom `<div>` click handlers.
2. Add `aria-*` attributes where needed.
3. Use `<label>` with form controls.
4. Support keyboard navigation (focus visible, tab order).

State management:
1. Use `useState` and `useReducer` for local state.
2. Use `useContext` for shared state across components.
3. For complex state, create a context provider pattern.
</component_patterns>

<api_integration>
All URLs in frontend code must be relative (no leading slash). This applies to fetch calls, script/link/img tags, CSS url() — everything. A leading slash breaks the preview system because the browser resolves absolute paths against the main server, bypassing the preview proxy.

```javascript
// CORRECT — relative URLs
const res = await fetch("api/items");

// WRONG — leading slash breaks preview
const res = await fetch("/api/items");
```

```html
<!-- CORRECT — relative paths for all resources -->
<script type="text/babel" data-type="module" src="./components/App.jsx"></script>
<link rel="stylesheet" href="./styles.css">
<img src="./images/logo.png" alt="Logo">

<!-- WRONG — absolute paths break preview -->
<script src="/components/App.jsx"></script>
<link rel="stylesheet" href="/styles.css">
<img src="/images/logo.png" alt="Logo">
```

Data fetching pattern:

```jsx
function ItemList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("api/items")
      .then(res => res.json())
      .then(data => setItems(data))
      .catch(err => console.error("Failed to load items:", err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Loading...</p>;
  return <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>;
}
```
</api_integration>

<import_maps>
The import map shown in `<core_setup>` is **required**, not optional. Without it the browser cannot resolve `react/jsx-runtime` when Babel emits the automatic JSX runtime — and the runtime default is set by whichever `@babel/standalone` build the CDN serves on a given day, so you cannot rely on classic runtime.

Extend the map when you add packages. The trailing-slash entries (`react/`, `react-dom/`) cover deep imports like `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom/client`:

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@19",
    "react/": "https://esm.sh/react@19/",
    "react-dom": "https://esm.sh/react-dom@19",
    "react-dom/": "https://esm.sh/react-dom@19/",
    "lucide-react": "https://esm.sh/lucide-react",
    "react-icons/fa": "https://esm.sh/react-icons/fa",
    "react-icons/hi2": "https://esm.sh/react-icons/hi2"
  }
}
</script>
```

With the map in place, imports are bare: `import React from "react"`.
</import_maps>

<rules>
1. All frontend files (`index.html`, `.jsx`, CSS, images) go in the `public/` directory. For simple apps, keep everything in `public/index.html`. For complex apps, create separate `.jsx` files loaded as `<script type="text/babel" data-type="module" src="./component.jsx">`.
2. Always use `<script type="text/babel" data-type="module">` for scripts containing JSX. Never use `.createElement()` manually.
3. Keep the React import map AND the **pinned** `@babel/standalone@X.Y.Z` script tag from `<core_setup>` at the top of every `index.html`. Never replace the pinned URL with the unpinned `…/babel.min.js` — a single upstream default change there breaks every existing app simultaneously by emitting bare `react/jsx-runtime` imports the browser can't resolve.
4. Use Tailwind utility classes for layout, spacing, responsive design, and general utilities. Apply the `frontend-design` skill's color palette and component styles — do not use Tailwind's default blue/gray color scheme.
5. Clean component structure with clear separation of concerns.
6. Responsive by default (mobile-first with sm:, md:, lg: breakpoints).
7. Consistent spacing scale (p-4, p-6, p-8, gap-4, gap-6) with generous whitespace between sections.
8. Use semantic HTML elements (`<nav>`, `<main>`, `<section>`, `<header>`, `<footer>`).
</rules>
