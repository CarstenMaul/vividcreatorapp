// Mermaid is ~3 MB; importing dynamically lands it in its own chunk so the
// initial bundle stays small. Same initialize options as the inline script
// the CDN-loaded version used in index.html.
let mermaidPromise = null;

export function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        flowchart: { htmlLabels: false },
      });
      if (typeof window !== "undefined") window.mermaid = mermaid;
      return mermaid;
    });
  }
  return mermaidPromise;
}
