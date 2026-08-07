import React, { createContext, useContext, useReducer, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Collapsible from "@radix-ui/react-collapsible";
import { loadMermaid } from "./mermaid-loader.js";
import {
  History, GitBranch, Plus, X, Send, Square,
  Zap, Settings, Trash2, ChevronDown, ChevronRight,
  Sun, Moon, FolderOpen, MessageSquare, User, Bot, Wrench, ChevronLeft,
  Brain, CircleCheck, CircleX, Terminal, Save, Key,
  FolderPlus, ArrowDownToLine, ArrowUpFromLine, Link,
  Pencil, BookOpen, RotateCcw, AlertTriangle, Globe, Loader, ExternalLink,
  Camera, Circle, Minus, MousePointer, Type, Undo2, Image as ImageIcon, Paperclip, FileText, Info, Eye, RefreshCw,
  Maximize2, Minimize2, Link2, Link2Off, Users, UserX, Hexagon, Box, Package, Download, Crosshair,
  HelpCircle, PenLine, Check, BoxSelect, Table, Code, FileCode, LayoutGrid, Mic, MicOff,
  ZoomIn, ZoomOut, LogOut, Lightbulb, Sparkles, MoreVertical, Copy, Lock,
  Search, ShieldCheck, ArrowRightLeft, Tag, Coins, Flame, Upload, HardDrive
} from "lucide-react";

// ─── Utilities ───────────────────────────────────────────────
const SPINNER_VERBS_FALLBACK = ["Thinking...", "Reasoning...", "Analyzing...", "Pondering..."];

function useSpinnerVerb(active, verbs) {
  const [display, setDisplay] = useState("");
  const phaseRef = useRef("idle"); // idle | typing | pause | erasing
  const verbRef = useRef("");
  const idxRef = useRef(0);
  const timerRef = useRef(null);
  const verbsRef = useRef(verbs || SPINNER_VERBS_FALLBACK);
  verbsRef.current = verbs && verbs.length > 0 ? verbs : SPINNER_VERBS_FALLBACK;

  useEffect(() => {
    if (!active) {
      clearTimeout(timerRef.current);
      phaseRef.current = "idle";
      setDisplay("");
      return;
    }

    function pickVerb() {
      const list = verbsRef.current;
      const verb = list[Math.floor(Math.random() * list.length)];
      verbRef.current = verb;
      idxRef.current = 0;
      phaseRef.current = "typing";
      tick();
    }

    function tick() {
      const phase = phaseRef.current;
      const verb = verbRef.current;

      if (phase === "typing") {
        idxRef.current++;
        setDisplay(verb.slice(0, idxRef.current));
        if (idxRef.current >= verb.length) {
          phaseRef.current = "pause";
          timerRef.current = setTimeout(tick, 1200);
        } else {
          timerRef.current = setTimeout(tick, 35 + Math.random() * 25);
        }
      } else if (phase === "pause") {
        phaseRef.current = "erasing";
        tick();
      } else if (phase === "erasing") {
        idxRef.current--;
        setDisplay(verb.slice(0, idxRef.current));
        if (idxRef.current <= 0) {
          phaseRef.current = "typing";
          timerRef.current = setTimeout(pickVerb, 200);
        } else {
          timerRef.current = setTimeout(tick, 20 + Math.random() * 15);
        }
      }
    }

    pickVerb();
    return () => clearTimeout(timerRef.current);
  }, [active]);

  return display;
}

function getToolArgsStr(args) {
  if (!args || typeof args !== "object") return "";
  if (args.command) return args.command;
  if (args.path) return args.path;
  if (args.file_path) return args.file_path;
  if (args.pattern) return args.pattern;
  return JSON.stringify(args).slice(0, 120);
}

// Vision providers reject images that push a content field past ~10 MB
// (OpenAI Responses) or ~5 MB (Anthropic). Downscale and re-encode as JPEG
// so the base64 payload stays well under those limits.
function compressImageDataUrl(dataUrl, opts = {}) {
  const maxDim = opts.maxDim ?? 2048;
  const targetBytes = opts.targetBytes ?? 5 * 1024 * 1024;
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const longest = Math.max(img.width, img.height);
      const originalBytes = dataUrl.length;
      if (longest <= maxDim && originalBytes <= targetBytes) {
        resolve({ dataUrl, originalBytes, compressedBytes: originalBytes, resized: false });
        return;
      }
      const attempts = [
        { dim: maxDim, q: 0.85 },
        { dim: maxDim, q: 0.7 },
        { dim: maxDim, q: 0.55 },
        { dim: Math.floor(maxDim / 2), q: 0.7 },
      ];
      let last = null;
      for (const { dim, q } of attempts) {
        const scale = Math.min(dim / longest, 1);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        // White background so PNG transparency doesn't render as black under JPEG.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const out = canvas.toDataURL("image/jpeg", q);
        last = out;
        if (out.length <= targetBytes) {
          resolve({ dataUrl: out, originalBytes, compressedBytes: out.length, resized: true });
          return;
        }
      }
      const finalUrl = last || dataUrl;
      resolve({ dataUrl: finalUrl, originalBytes, compressedBytes: finalUrl.length, resized: true });
    };
    img.onerror = () => {
      resolve({ dataUrl, originalBytes: dataUrl.length, compressedBytes: dataUrl.length, resized: false });
    };
    img.src = dataUrl;
  });
}

// ─── App icon helpers ────────────────────────────────────────
// Master app-icon size. A square PNG at this size is stored per project — large
// enough for electron-builder to derive Windows .ico / macOS .icns and for a web
// favicon (browsers downscale). 1024 is the ideal max for .icns.
const ICON_SIZE = 1024;

// Normalize any image data URL to a square ICON_SIZE² PNG: the whole source is
// fit inside ("contain") on a transparent background so non-square uploads are
// never cropped. Generated icons are already square, so this only re-encodes.
function normalizeIconDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
      const scale = Math.min(ICON_SIZE / img.width, ICON_SIZE / img.height) || 1;
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, Math.round((ICON_SIZE - w) / 2), Math.round((ICON_SIZE - h) / 2), w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = dataUrl;
  });
}

// A blank white square used as the base when generating an icon from a text
// prompt with no existing icon (the image proxy requires a base image).
function blankIconDataUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
  return canvas.toDataURL("image/png");
}

// Gallery-row icon: the project's custom icon when set (falling back to the
// folder glyph on load failure), else the default folder.
function RowIcon({ projectId, hasIcon }) {
  const [failed, setFailed] = useState(false);
  if (hasIcon && !failed) {
    return (
      <img
        className="row-icon-img"
        src={`/api/projects/${encodeURIComponent(projectId)}/icon`}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return <FolderOpen size={16} />;
}

// ─── Use-Case Mermaid generator & parser ─────────────────────
function findContainingBoundary(uc, boundaries) {
  let best = null, bestArea = Infinity;
  for (const b of boundaries) {
    if (uc.x != null && uc.y != null && uc.x >= b.x && uc.x <= b.x + b.width && uc.y >= b.y && uc.y <= b.y + b.height) {
      const area = b.width * b.height;
      if (area < bestArea) { best = b; bestArea = area; }
    }
  }
  return best;
}

function generateUseCaseMermaid(data) {
  if (!data || (data.actors.length === 0 && data.useCases.length === 0)) return "";
  const sanitize = (s) => s.replace(/[()[\]|{}]/g, " ").replace(/\s+/g, " ").trim();
  const lines = ["graph LR"];
  const boundaries = data.boundaries || [];
  if (boundaries.length > 0) {
    const grouped = new Map();
    const uncontained = [];
    for (const uc of data.useCases) {
      const b = findContainingBoundary(uc, boundaries);
      if (b) {
        if (!grouped.has(b.id)) grouped.set(b.id, []);
        grouped.get(b.id).push(uc);
      } else {
        uncontained.push(uc);
      }
    }
    for (const b of boundaries) {
      lines.push(`  subgraph b_${b.id}["${sanitize(b.name)}"]`);
      for (const uc of (grouped.get(b.id) || [])) lines.push(`    uc_${uc.id}[${sanitize(uc.name)}]`);
      lines.push("  end");
    }
    for (const uc of uncontained) lines.push(`  uc_${uc.id}[${sanitize(uc.name)}]`);
  } else {
    for (const uc of data.useCases) lines.push(`  uc_${uc.id}[${sanitize(uc.name)}]`);
  }
  for (const a of data.actors) lines.push(`  actor_${a.id}([${sanitize(a.name)}])`);
  for (const c of data.connections) {
    const label = c.label ? ` -->|${sanitize(c.label)}|` : " -->";
    lines.push(`  actor_${c.actorId}${label} uc_${c.useCaseId}`);
  }
  if (data.relationships) {
    for (const r of data.relationships) {
      if (r.type === "association") {
        lines.push(`  uc_${r.fromUseCaseId} --> uc_${r.toUseCaseId}`);
      } else {
        lines.push(`  uc_${r.fromUseCaseId} -.->|<<${r.type}>>| uc_${r.toUseCaseId}`);
      }
    }
  }
  return lines.join("\n");
}

function parseMermaidToUseCaseData(mermaid) {
  const actors = [], useCases = [], connections = [], relationships = [], boundaries = [];
  const boundaryUcMap = new Map();
  let currentBoundaryId = null;
  const lines = mermaid.split("\n").map(l => l.trim());
  for (const line of lines) {
    const bm = line.match(/^subgraph\s+(?:b_)?(\w+)\["(.+?)"\]/);
    if (bm) {
      const id = bm[1] === "boundary" ? crypto.randomUUID().slice(0, 8) : bm[1];
      boundaries.push({ id, name: bm[2], x: 0, y: 0, width: 500, height: 400 });
      currentBoundaryId = id;
      boundaryUcMap.set(id, []);
      continue;
    }
    if (line === "end") { currentBoundaryId = null; continue; }
    const am = line.match(/^actor_(\w+)\(\[(.+?)\]\)/);
    if (am) { actors.push({ id: am[1], name: am[2] }); continue; }
    const um = line.match(/^uc_(\w+)\[(.+?)\]/);
    if (um) {
      useCases.push({ id: um[1], name: um[2] });
      if (currentBoundaryId) boundaryUcMap.get(currentBoundaryId).push(um[1]);
      continue;
    }
    const cm = line.match(/^actor_(\w+)\s+-->(?:\|(.+?)\|)?\s*uc_(\w+)/);
    if (cm) { connections.push({ actorId: cm[1], useCaseId: cm[3], label: cm[2] || "" }); continue; }
    const rm = line.match(/^uc_(\w+)\s+-\.->(?:\|<<(extend|include)>>\|)?\s*uc_(\w+)/);
    if (rm) { relationships.push({ id: crypto.randomUUID().slice(0, 8), fromUseCaseId: rm[1], toUseCaseId: rm[3], type: rm[2] || "extend" }); continue; }
    const uam = line.match(/^uc_(\w+)\s+-->\s*uc_(\w+)/);
    if (uam) { relationships.push({ id: crypto.randomUUID().slice(0, 8), fromUseCaseId: uam[1], toUseCaseId: uam[2], type: "association" }); continue; }
  }
  actors.forEach((a, i) => { a.x = 80; a.y = i * 120 + 100; });
  boundaries.forEach((b, i) => {
    b.x = 200 + i * 550; b.y = 50;
    (boundaryUcMap.get(b.id) || []).forEach((ucId, j) => {
      const uc = useCases.find(u => u.id === ucId);
      if (uc) { uc.x = b.x + 60 + (j % 2) * 180; uc.y = b.y + 60 + Math.floor(j / 2) * 100; }
    });
  });
  const containedIds = new Set([...boundaryUcMap.values()].flat());
  const defaultX = boundaries.length > 0 ? 200 + boundaries.length * 550 : 280;
  useCases.filter(uc => !containedIds.has(uc.id)).forEach((uc, i) => {
    if (uc.x == null || uc.x === 0) { uc.x = defaultX + (i % 2) * 180; uc.y = 80 + Math.floor(i / 2) * 100; }
  });
  return { actors, useCases, connections, relationships: relationships.length > 0 ? relationships : undefined, boundaries };
}

// ─── Activity Diagram Mermaid generator ──────────────────────
function generateActivityMermaid(data) {
  if (!data || !data.nodes || !data.nodes.length) return "";
  const sanitize = (s) => (s || "").replace(/[^a-zA-Z0-9_ ]/g, "").trim();
  const lines = ["stateDiagram-v2"];
  for (const node of data.nodes) {
    const sid = `s_${node.id}`;
    if (node.type === "action") lines.push(`  state "${sanitize(node.name)}" as ${sid}`);
    else if (node.type === "decision") lines.push(`  state ${sid} <<choice>>`);
    else if (node.type === "fork") lines.push(`  state ${sid} <<fork>>`);
    else if (node.type === "join") lines.push(`  state ${sid} <<join>>`);
  }
  for (const t of data.transitions) {
    const fromNode = data.nodes.find(n => n.id === t.fromNodeId);
    const toNode = data.nodes.find(n => n.id === t.toNodeId);
    if (!fromNode || !toNode) continue;
    const from = fromNode.type === "start" ? "[*]" : `s_${fromNode.id}`;
    const to = toNode.type === "end" ? "[*]" : `s_${toNode.id}`;
    lines.push(t.label ? `  ${from} --> ${to}: ${sanitize(t.label)}` : `  ${from} --> ${to}`);
  }
  return lines.join("\n");
}

function generateERMermaid(data) {
  if (!data || !data.entities || !data.entities.length) return "";
  const sanitize = (s) => (s || "").replace(/[^a-zA-Z0-9_]/g, "").trim();
  const lines = ["erDiagram"];
  for (const entity of data.entities) {
    const eName = sanitize(entity.name) || "Entity";
    lines.push(`  ${eName} {`);
    for (const attr of (entity.attributes || [])) {
      const aType = sanitize(attr.type) || "string";
      const aName = sanitize(attr.name) || "field";
      const markers = [];
      if (attr.pk) markers.push("PK");
      if (attr.fk) markers.push("FK");
      lines.push(`    ${aType} ${aName}${markers.length ? " " + markers.join(",") : ""}`);
    }
    lines.push("  }");
  }
  const cardToMermaid = (card, side) => {
    switch (card) {
      case "1": return "||";
      case "0..1": return side === "left" ? "|o" : "o|";
      case "1..*": return side === "left" ? "}|" : "|{";
      case "0..*": case "*": return side === "left" ? "}o" : "o{";
      default: return "||";
    }
  };
  for (const rel of (data.relationships || [])) {
    const fromEntity = data.entities.find(e => e.id === rel.fromEntityId);
    const toEntity = data.entities.find(e => e.id === rel.toEntityId);
    if (!fromEntity || !toEntity) continue;
    const fromName = sanitize(fromEntity.name) || "Entity";
    const toName = sanitize(toEntity.name) || "Entity";
    const fromCard = cardToMermaid(rel.fromCardinality, "left");
    const toCard = cardToMermaid(rel.toCardinality, "right");
    const label = rel.label ? `"${rel.label}"` : '""';
    lines.push(`  ${fromName} ${fromCard}--${toCard} ${toName} : ${label}`);
  }
  return lines.join("\n");
}

// ─── Marked config ───────────────────────────────────────────
marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
});

// ─── Silent re-auth ──────────────────────────────────────────
// Renews the Entra session in-place via a hidden iframe pointing at
// /auth/silent-login (which uses prompt=none). Resolves true if Entra still
// had an SSO session and the cookie was refreshed; false if the user must
// sign in interactively. Single-flight: parallel callers share one iframe.
let silentReauthPromise = null;
function silentReauth() {
  if (silentReauthPromise) return silentReauthPromise;
  silentReauthPromise = new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = "/auth/silent-login";

    let settled = false;
    const cleanup = (ok) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      try { iframe.remove(); } catch { /* ignore */ }
      silentReauthPromise = null;
      resolve(ok);
    };
    const onMessage = (ev) => {
      if (ev.origin !== window.location.origin) return;
      if (!ev.data || ev.data.type !== "vca-silent-auth") return;
      cleanup(ev.data.ok === true);
    };
    window.addEventListener("message", onMessage);
    // Hard timeout: 10s without a postMessage means Entra hung (consent UI
    // refused to render in iframe, network blip, etc.) — treat as failure.
    const timer = setTimeout(() => cleanup(false), 10_000);

    document.body.appendChild(iframe);
  });
  return silentReauthPromise;
}

// Lets the app shell mount a soft modal that listens for the
// "vca-session-expired" CustomEvent and prompts the user to reconnect.
function notifySessionExpired() {
  window.dispatchEvent(new CustomEvent("vca-session-expired"));
}

async function refreshAuthSession() {
  const res = await fetch("/auth/refresh", { cache: "no-store" });
  return res.ok;
}

// Resolves to true when an "vca-session-restored" event fires within
// timeoutMs, false otherwise. api() uses this to replay a 401-ed request
// after the SessionExpiredDialog popup-login flow succeeds.
function waitForSessionRestored(timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let timer;
    const onRestored = () => {
      clearTimeout(timer);
      window.removeEventListener("vca-session-restored", onRestored);
      resolve(true);
    };
    window.addEventListener("vca-session-restored", onRestored);
    timer = setTimeout(() => {
      window.removeEventListener("vca-session-restored", onRestored);
      resolve(false);
    }, timeoutMs);
  });
}

// Soft modal that shows when an API call returned 401 and silent re-auth
// failed (Entra has no SSO session left). Reconnect opens the interactive
// OAuth flow in a popup; on success the popup posts back via
// /auth/silent-result, the modal closes, and the SPA keeps its state.
function SessionExpiredDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reconnectRef = useRef(null);
  // Tracks whether the modal is already open so a second
  // "vca-session-expired" event (e.g. from parallel api() calls all hitting
  // 401) doesn't re-launch the popup. Set synchronously in onExpired and in
  // the popup success handler so back-to-back events can't race.
  const openRef = useRef(false);

  const onReconnect = useCallback(async () => {
    setBusy(true);
    setError("");
    // When OAuth isn't configured, the Entra popup-login endpoint 404s and
    // the popup flow is useless. A full reload sends the user to the
    // LoginScreen, where they can re-enter their local credentials.
    try {
      const opts = await fetch("/auth/login-options").then((r) => r.json()).catch(() => null);
      if (!opts?.oauth) {
        window.location.reload();
        return;
      }
    } catch { /* fall through to popup */ }
    const popup = window.open("/auth/popup-login", "vca-reconnect", "width=520,height=720");
    if (!popup) {
      setBusy(false);
      setError("Popup blocked — allow popups for this site, or reload the page.");
      return;
    }
    const onMessage = (ev) => {
      if (ev.origin !== window.location.origin) return;
      if (!ev.data || ev.data.type !== "vca-silent-auth") return;
      window.removeEventListener("message", onMessage);
      setBusy(false);
      if (ev.data.ok) {
        setOpen(false);
        openRef.current = false;
        // Notify api() retry waiters and useSSE so the existing EventSource
        // re-establishes with the fresh session_id cookie.
        window.dispatchEvent(new CustomEvent("vca-session-restored"));
      } else {
        setError(`Sign-in failed${ev.data.reason ? ` (${ev.data.reason})` : ""}. Try again.`);
      }
    };
    window.addEventListener("message", onMessage);
    // If the popup is closed without finishing (user cancelled), recover
    // gracefully.
    const poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        window.removeEventListener("message", onMessage);
        setBusy(false);
      }
    }, 500);
  }, []);

  reconnectRef.current = onReconnect;

  useEffect(() => {
    const onExpired = () => {
      setError("");
      // Silent reauth has already failed by the time we get this event. Show
      // a stable reconnect prompt; the popup is opened from the user's click
      // so browser popup blockers do not turn recovery into a dead end.
      if (!openRef.current) {
        openRef.current = true;
        setOpen(true);
      }
    };
    window.addEventListener("vca-session-expired", onExpired);
    return () => window.removeEventListener("vca-session-expired", onExpired);
  }, []);

  return (
    <AlertDialog.Root open={open} onOpenChange={() => { /* user can't dismiss without reconnecting */ }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="alert-overlay" />
        <AlertDialog.Content className="alert-content">
          <AlertDialog.Title className="alert-title">
            <AlertTriangle size={18} style={{ color: "var(--accent)" }} />
            Session expired
          </AlertDialog.Title>
          <AlertDialog.Description className="alert-description">
            {busy
              ? "Renewing your sign-in… complete the popup to continue. Your work stays in this tab."
              : "Your sign-in needs to be renewed. Reconnect to continue — your work stays in this tab."}
          </AlertDialog.Description>
          {error ? <div style={{ color: "var(--error)", fontSize: 13, marginTop: 8 }}>{error}</div> : null}
          <div className="modal-actions">
            <button className="btn-primary" onClick={onReconnect} disabled={busy}>
              {busy ? "Reconnecting…" : "Reconnect"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// ─── API helper ──────────────────────────────────────────────
async function api(path, options = {}) {
  const doFetch = () => fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  let res = await doFetch();
  if (res.status === 401) {
    // 401 from our session middleware means the vca session is gone or its
    // refresh-token call to Entra failed. Try silent re-auth (hidden iframe,
    // prompt=none) once; if Entra still has the user's SSO session, we get a
    // fresh cookie and the original request succeeds on retry. Endpoints
    // that legitimately return 401 for non-session reasons (e.g. an invalid
    // third-party PAT) MUST use a different status or include a `code`.
    const peekedBody = await res.clone().json().catch(() => ({}));
    if (!peekedBody?.code) {
      let ok = await refreshAuthSession().catch(() => false);
      if (!ok) ok = await silentReauth();
      if (ok) {
        res = await doFetch();
      } else {
        // Silent reauth failed (Entra SSO is gone). Surface the popup-login
        // modal and wait for the user to complete it, then replay the
        // original request once. The previous behaviour dropped this request
        // and forced the user to resubmit by hand.
        notifySessionExpired();
        const restored = await waitForSessionRestored(60_000);
        if (restored) {
          res = await doFetch();
        }
      }
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(body?.error || "Request failed");
    err.status = res.status;
    err.code = body?.code;
    err.body = body;
    // Side-channel: a 409 PROJECT_LOCK_NOT_HELD means someone (typically the
    // owner) just took over the server lock. Surface it as an app-wide event
    // so the bumped overlay shows up even if this specific caller has no
    // handler. The SSE lock_taken_over event normally arrives first; this is
    // belt-and-suspenders for the race-window case.
    if (res.status === 409 && body?.code === "PROJECT_LOCK_NOT_HELD") {
      try {
        window.dispatchEvent(new CustomEvent("vca-project-lock-bumped", {
          detail: { holder: body?.holder || null },
        }));
      } catch { /* best-effort */ }
    }
    throw err;
  }
  return res.json();
}

// Client-side file download for content that can't ride a GET URL (e.g. the
// encrypted config export, whose password travels in a POST body).
function downloadTextFile(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJsonFile(filename, obj) {
  downloadTextFile(filename, JSON.stringify(obj, null, 2), "application/json");
}

// ─── useLocalStorage ─────────────────────────────────────────
function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored !== null ? stored : initialValue;
  });
  const set = useCallback((v) => {
    setValue(v);
    if (v === null || v === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  }, [key]);
  return [value, set];
}

// ─── AppContext + Reducer ────────────────────────────────────
const AppContext = createContext(null);

const initialState = {
  projects: [],
  messages: [],
  isStreaming: false,
  sidebarOpen: true,
  rightSidebarOpen: false,
  currentProjectId: null,
  currentProjectName: "",
  chats: [],            // ChatMetadata[] for the currently selected project
  currentChatId: null,
  // Project-level prompt gate: which chat (if any) is currently running an
  // agent task in the active project. While set to a different chat than
  // currentChatId, the send button is disabled — the backend will 409 anyway.
  projectActiveChatId: null,
  // Project lock (single-tab-per-project, BroadcastChannel-based):
  // - "idle"               : no project / not yet attempting
  // - "acquiring"          : sent whois, waiting briefly for an iam reply
  // - "holding"            : we own the project in this tab
  // - "prompt-conflict"    : another tab holds it; conflict modal is shown
  // - "taken-over"         : another tab took the project from us; overlay shown
  // Server lock (cross-user, single-writer on shared projects):
  // - "server-in-use"      : another USER holds the server lock; modal shown
  // - "server-taken-over"  : another user took our server lock; overlay shown
  projectLockState: "idle",
  projectLockProjectId: null,
  pendingProjectSelection: null,   // { id, name } awaiting Open here / Cancel
  previousProjectSelection: null,  // { id, name } to revert to on Cancel
  serverLockHolder: null,          // { userId, displayName, email, acquiredAt }
  serverLockProjectName: "",       // name of project that's locked
};

const EMPTY_PREVIEW_STATE = {
  projectKey: null,
  status: "stopped",
  running: false,
  port: null,
  pid: null,
  instanceId: null,
  hasProcess: false,
  lastError: null,
  lastUsedAt: null,
};

// True while an agent turn is in flight anywhere in the OPEN project. Every path
// that leaves a project gates on this: closing/switching/deleting releases the
// server lock without aborting the agent, so the turn would keep writing files
// into a workspace another user can now grab.
//
// projectActiveChatId is the authoritative half — the server holds the project
// prompt slot for the whole of sendPrompt (compaction, retries, and the post-turn
// auto-commit / diagram sync / preview restart), and it is broadcast to every chat
// tab, so it also covers turns running in a background chat where isStreaming is
// false. isStreaming is kept as the faster-arriving signal; it over-reports rather
// than under-reports, since agent_end is skipped during compaction/retry.
//
// Scoped on currentProjectId deliberately: without it a stale flag left over from
// a takeover would read busy with no project open and lock the user out of the
// gallery. CLEAR_PROJECT also resets both flags for the same reason.
function isAgentBusy(state) {
  return !!state?.currentProjectId && (!!state.isStreaming || !!state.projectActiveChatId);
}

// Check if a tool call targets an internal .vca-* file (diagrams, metadata)
function isSkillInvocation(tc) {
  const p = tc.args?.file_path || tc.args?.path || "";
  return /[/\\]\.vca-skills[/\\]/.test(p);
}
function getSkillName(tc) {
  const p = tc.args?.file_path || tc.args?.path || "";
  const m = p.match(/[/\\]\.vca-skills[/\\]([^/\\]+)/);
  return m ? m[1] : null;
}
function isInternalToolCall(tc) {
  if (isSkillInvocation(tc)) return false;
  const p = tc.args?.file_path || tc.args?.path || "";
  return /\/.vca-|\\.vca-/.test(p);
}

const MERMAID_KEYWORDS = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|sankey-beta|xychart-beta|block-beta|architecture-beta|C4Context|C4Container|C4Component|C4Deployment|C4Dynamic)\b/;

function isMermaidSource(s) {
  if (!s) return false;
  const first = s.trimStart().split("\n", 1)[0].trim();
  return MERMAID_KEYWORDS.test(first);
}

// Split markdown source into ordered text/mermaid chunks so mermaid blocks
// can render as React components and survive parent re-renders.
function splitMarkdownByMermaid(s) {
  if (!s) return [{ type: "text", text: "" }];
  const parts = [];
  const fenceRe = /(^|\n)```([^\n]*)\n([\s\S]*?)\n```(?=\n|$)/g;
  let lastIndex = 0;
  let m;
  while ((m = fenceRe.exec(s)) !== null) {
    const lang = (m[2] || "").trim().toLowerCase();
    const code = m[3];
    const isMermaid = lang === "mermaid" || (lang === "" && isMermaidSource(code));
    if (!isMermaid) continue;
    const fenceStart = m.index + (m[1] ? m[1].length : 0);
    if (fenceStart > lastIndex) {
      parts.push({ type: "text", text: s.slice(lastIndex, fenceStart) });
    }
    parts.push({ type: "mermaid", src: code });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < s.length) {
    parts.push({ type: "text", text: s.slice(lastIndex) });
  }
  if (parts.length === 0) parts.push({ type: "text", text: s });
  return parts;
}

// Format a message timestamp (ISO string or epoch ms) as local "yyyy-mm-dd hh:mm",
// e.g. "2026-05-27 14:30". Returns "" for missing/invalid input so callers can
// gracefully omit the datetime on pre-existing messages that lack one.
function formatMessageDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stripChatArtifacts(s) {
  if (!s) return s;
  return s
    .replace(/\[[^\]]*Diagram\]\s*```[^\n]*\n[\s\S]*?```\s*/g, "")
    .replace(/\[Respond in [^\]]+\]\s*/g, "")
    .replace(/^\[stderr\].*$/gm, "")
    .replace(/^\[stdout\].*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

// Parse persisted messages, filtering out internal diagram tool calls
function parsePersistedMessages(messages) {
  const parsed = [];
  const hiddenToolIds = new Set();
  const questionToolIds = new Set();
  // An agent round is many LLM inferences — each tool-calling step is its own
  // assistant message with its own cost, and textless steps aren't rendered.
  // Roll those costs up into the next visible assistant message so the shown
  // cost is the whole round's, and the per-message deltas sum to the total.
  let roundCost = 0;
  let roundModel = null;
  let roundReasoning = null;
  for (const msg of messages) {
    if (msg.role === "user") {
      roundCost = 0;
      roundModel = null;
      roundReasoning = null;
      parsed.push({ type: "user", text: stripChatArtifacts(msg.displayText ?? msg.content), ts: msg.ts, author: msg.author });
    } else if (msg.role === "assistant") {
      const { text, thinking, toolCalls } = msg.content;
      if (typeof msg.costUsd === "number" && Number.isFinite(msg.costUsd)) roundCost += msg.costUsd;
      if (msg.model) roundModel = msg.model;
      if (msg.reasoning) roundReasoning = msg.reasoning;
      if (thinking) parsed.push({ type: "thinking", text: thinking });
      if (toolCalls) {
        for (const tc of toolCalls) {
          if (tc.name === "ask_question") {
            questionToolIds.add(tc.id);
            parsed.push({
              type: "question", toolCallId: tc.id,
              question: tc.args?.question || "", options: tc.args?.options || [],
              answered: true, selectedAnswer: null,
            });
          } else if (isInternalToolCall(tc)) {
            hiddenToolIds.add(tc.id);
          } else {
            const skill = isSkillInvocation(tc) ? getSkillName(tc) : null;
            parsed.push({ type: "tool", toolCallId: tc.id, toolName: tc.name, args: tc.args, status: "completed", isSkill: !!skill, skillName: skill });
          }
        }
      }
      if (text) {
        parsed.push({ type: "assistant", text: stripChatArtifacts(text), streaming: false, ts: msg.ts, costUsd: roundCost, model: msg.model || roundModel, reasoning: msg.reasoning || roundReasoning });
        roundCost = 0;
      }
    } else if (msg.role === "compaction") {
      // Persisted marker for a context compaction — same block the live
      // compaction_end SSE event renders, so it survives reloads.
      parsed.push({ type: "compaction", error: null });
    } else if (msg.role === "toolResult" && msg.content) {
      if (hiddenToolIds.has(msg.content.toolCallId)) continue;
      // Extract answer for ask_question tool results
      if (questionToolIds.has(msg.content.toolCallId) && msg.content.resultText) {
        const answer = msg.content.resultText.replace(/^User answered:\s*/, "");
        const idx = parsed.findIndex(m => m.type === "question" && m.toolCallId === msg.content.toolCallId);
        if (idx >= 0) parsed[idx].selectedAnswer = answer;
        continue;
      }
      if (msg.content.isError) {
        const idx = parsed.findIndex(m => m.type === "tool" && m.toolCallId === msg.content.toolCallId);
        if (idx >= 0) parsed[idx].status = "error";
      }
    }
  }
  return parsed;
}

// Insert a message before the streaming assistant (if any), so it stays last
function insertBeforeStreaming(messages, newMsg) {
  const lastIdx = messages.length - 1;
  if (lastIdx >= 0 && messages[lastIdx].type === "assistant" && messages[lastIdx].streaming) {
    return [...messages.slice(0, lastIdx), newMsg, messages[lastIdx]];
  }
  return [...messages, newMsg];
}

function reducer(state, action) {
  switch (action.type) {
    case "SET_PROJECTS":
      return { ...state, projects: action.projects };
    case "SET_MESSAGES": {
      // On a reconnect-time history load (keepStreamingTail), the live stream may
      // have already appended an in-flight streaming assistant placeholder (plus
      // an optional thinking block) that the committed history doesn't contain
      // yet — the SDK keeps the mid-stream message out of session.messages until
      // it ends. Carry that tail over so a race between this load and the
      // stream_resume replay can't drop the live message. No-op when nothing is
      // streaming, since no such tail exists.
      if (action.keepStreamingTail) {
        const prev = state.messages;
        const tail = [];
        for (let i = prev.length - 1; i >= 0; i--) {
          const m = prev[i];
          if (m.type === "assistant" && m.streaming) { tail.unshift(m); continue; }
          if (tail.length && m.type === "thinking") { tail.unshift(m); continue; }
          break;
        }
        return { ...state, messages: [...action.messages, ...tail] };
      }
      return { ...state, messages: action.messages };
    }
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "UPDATE_LAST_ASSISTANT": {
      const msgs = [...state.messages];
      const idx = msgs.findLastIndex(m => m.type === "assistant");
      if (idx >= 0) {
        const updated = { ...msgs[idx], ...action.updates };
        // Move streaming assistant message to the end so it's always last
        if (updated.streaming) {
          msgs.splice(idx, 1);
          msgs.push(updated);
        } else {
          msgs[idx] = updated;
        }
      }
      return { ...state, messages: msgs };
    }
    case "RESUME_ASSISTANT": {
      // Rebuild the in-flight streaming placeholder after a reconnect. If one
      // already exists (transient EventSource reconnect), update it in place so
      // we never create a duplicate assistant bubble; otherwise append a fresh
      // streaming message holding the partial text replayed by the server.
      const msgs = [...state.messages];
      const lastIdx = msgs.length - 1;
      if (lastIdx >= 0 && msgs[lastIdx].type === "assistant" && msgs[lastIdx].streaming) {
        msgs[lastIdx] = { ...msgs[lastIdx], text: action.text, streaming: true };
        return { ...state, messages: msgs };
      }
      return { ...state, messages: [...msgs, { type: "assistant", text: action.text, streaming: true, ts: action.ts }] };
    }
    case "ADD_THINKING":
      return { ...state, messages: insertBeforeStreaming(state.messages, { type: "thinking", text: action.text }) };
    case "UPDATE_LAST_THINKING": {
      const msgs = [...state.messages];
      const idx = msgs.findLastIndex(m => m.type === "thinking");
      if (idx >= 0) msgs[idx] = { ...msgs[idx], text: action.text };
      return { ...state, messages: msgs };
    }
    case "ADD_TOOL_CALL":
      return { ...state, messages: insertBeforeStreaming(state.messages, { type: "tool", ...action.tool }) };
    case "UPDATE_TOOL": {
      const msgs = state.messages.map(m =>
        m.type === "tool" && m.toolCallId === action.toolCallId
          ? { ...m, ...action.updates }
          : m
      );
      return { ...state, messages: msgs };
    }
    case "APPEND_TOOL_OUTPUT": {
      const msgs = state.messages.map(m =>
        m.type === "tool" && m.toolCallId === action.toolCallId
          ? { ...m, output: (m.output || "") + (action.chunk || "") }
          : m
      );
      return { ...state, messages: msgs };
    }
    case "ANSWER_QUESTION": {
      const msgs = state.messages.map(m =>
        m.type === "question" && m.toolCallId === action.toolCallId
          ? { ...m, answered: true, selectedAnswer: action.answer }
          : m
      );
      return { ...state, messages: msgs };
    }
    case "SET_STREAMING":
      return { ...state, isStreaming: action.isStreaming };
    case "SET_PROJECT_ACTIVE_CHAT":
      return { ...state, projectActiveChatId: action.chatId };
    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "SET_SIDEBAR":
      return { ...state, sidebarOpen: action.open };
    case "TOGGLE_RIGHT_SIDEBAR":
      return { ...state, rightSidebarOpen: !state.rightSidebarOpen };
    case "SET_RIGHT_SIDEBAR":
      return { ...state, rightSidebarOpen: action.open };
    case "SELECT_PROJECT": {
      const prev = state.currentProjectId
        ? { id: state.currentProjectId, name: state.currentProjectName }
        : null;
      return {
        ...state,
        currentProjectId: action.id,
        currentProjectName: action.name,
        messages: [],
        chats: [],
        currentChatId: null,
        projectActiveChatId: null,
        previousProjectSelection: prev,
        projectLockState: "holding",
        projectLockProjectId: action.id,
        pendingProjectSelection: null,
      };
    }
    case "LOCK_PROMPT_CONFLICT":
      return {
        ...state,
        projectLockState: "prompt-conflict",
        pendingProjectSelection: { id: action.id, name: action.name },
      };
    case "LOCK_DISMISS_CONFLICT":
      // Cancel was clicked — fall back to whatever active project we already
      // had (possibly null), keep the lock state matching reality.
      return {
        ...state,
        pendingProjectSelection: null,
        projectLockState: state.currentProjectId ? "holding" : "idle",
        projectLockProjectId: state.currentProjectId,
      };
    case "LOCK_TAKEN_OVER":
      // Another tab claimed the project we were holding. Keep the project
      // selected (so the UI keeps its shape) but render the overlay.
      return {
        ...state,
        projectLockState: "taken-over",
        projectLockProjectId: action.projectId,
      };
    case "LOCK_RECLAIM":
      return {
        ...state,
        projectLockState: "holding",
        projectLockProjectId: state.currentProjectId,
      };
    case "SERVER_LOCK_HELD":
      // Another user holds the server-side lock on the project we tried to
      // open. Don't dispatch SELECT_PROJECT — the project view never loads.
      return {
        ...state,
        projectLockState: "server-in-use",
        serverLockHolder: action.holder,
        serverLockProjectName: action.projectName || "",
        pendingProjectSelection: { id: action.projectId, name: action.projectName || "" },
      };
    case "SERVER_LOCK_OK":
      // Acquired or taken-over the lock; clear the modal state.
      return {
        ...state,
        projectLockState: state.currentProjectId ? "holding" : state.projectLockState,
        serverLockHolder: null,
        serverLockProjectName: "",
        pendingProjectSelection: null,
      };
    case "SERVER_LOCK_BUMPED":
      // Another user (the owner) took our active lock. Keep the project
      // visible but render the overlay so further writes are blocked.
      return {
        ...state,
        projectLockState: "server-taken-over",
        serverLockHolder: action.newHolder || null,
      };
    case "SERVER_LOCK_CANCEL":
      // Cancel was clicked in the "in use" modal. Drop back to idle / gallery.
      return {
        ...state,
        projectLockState: state.currentProjectId ? "holding" : "idle",
        serverLockHolder: null,
        serverLockProjectName: "",
        pendingProjectSelection: null,
      };
    case "REMOVE_PROJECT": {
      const next = { ...state, projects: state.projects.filter(p => p.id !== action.id) };
      if (state.currentProjectId === action.id) {
        next.currentProjectId = null;
        next.currentProjectName = "";
        next.messages = [];
        next.chats = [];
        next.currentChatId = null;
        next.projectLockState = "idle";
        next.projectLockProjectId = null;
        next.pendingProjectSelection = null;
        next.previousProjectSelection = null;
      }
      return next;
    }
    case "RENAME_PROJECT": {
      const next = { ...state, projects: state.projects.map(p => p.id === action.id ? { ...p, name: action.name } : p) };
      if (state.currentProjectId === action.id) next.currentProjectName = action.name;
      return next;
    }
    case "CLEAR_PROJECT":
      // Reset the busy flags too: nothing else clears them once the project is
      // gone (a takeover can land mid-turn), and a stale one would make
      // isAgentBusy read true forever and block opening any project.
      return { ...state, currentProjectId: null, currentProjectName: "", messages: [], chats: [], currentChatId: null, isStreaming: false, projectActiveChatId: null, projectLockState: "idle", projectLockProjectId: null, pendingProjectSelection: null, previousProjectSelection: null };
    case "SET_CHATS":
      return { ...state, chats: action.chats };
    case "ADD_CHAT":
      return { ...state, chats: [...state.chats, action.chat] };
    case "UPDATE_CHAT":
      return { ...state, chats: state.chats.map(c => c.id === action.chat.id ? { ...c, ...action.chat } : c) };
    case "REMOVE_CHAT":
      return { ...state, chats: state.chats.filter(c => c.id !== action.chatId) };
    case "SELECT_CHAT":
      return { ...state, currentChatId: action.chatId, messages: [] };
    default:
      return state;
  }
}

// Classify a server-log line into a CSS severity class. Requested stops
// ("Process stopped", stdout) and clean process exits (code=0, stderr) are
// informational, not failures.
function classifyServerLogLine(stream, line) {
  if (/process stopped \(code=/i.test(line)) return "info";
  if (stream !== "stderr") return null;
  if (/process exited \(code=0[,)]/i.test(line)) return "info";
  if (/warning/i.test(line)) return "warning";
  return "stderr";
}

function formatLogTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

// Historical log lines stored as `[ISO] [stream] rest`. Returns null on lines
// that pre-date the timestamp prefix so they still render unformatted.
function parseHistoricalLogLine(raw) {
  const m = raw.match(/^\[([^\]]+)\] (\[(?:stdout|stderr)\] .*)$/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  if (Number.isNaN(t)) return null;
  return { ts: t, line: m[2] };
}

// ─── useProjectLock hook ─────────────────────────────────────
// Single-tab-per-project lock via BroadcastChannel. Same browser only.
// Wire protocol — every message has { type, projectId, tabId }:
//   whois            "Anyone holding P? Please reply."
//   iam              "I hold P, since=<ts>." (reply to whois)
//   claim            "I just took P."
//   force-takeover   "User asked to take P from you — release it."
//   release          "I'm leaving P."
function useProjectLock(tabId, dispatch) {
  const bcRef = useRef(null);
  const heldProjectIdRef = useRef(null);
  const heldSinceRef = useRef(0);
  const pendingAcquireRef = useRef(null); // { projectId, resolve, timer }

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("vca-project-lock");
    bcRef.current = bc;

    bc.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.tabId === tabId) return;
      switch (msg.type) {
        case "whois":
          if (heldProjectIdRef.current === msg.projectId) {
            try { bc.postMessage({ type: "iam", projectId: msg.projectId, tabId, since: heldSinceRef.current }); } catch {}
          }
          break;
        case "iam": {
          const pending = pendingAcquireRef.current;
          if (pending && pending.projectId === msg.projectId) {
            clearTimeout(pending.timer);
            pendingAcquireRef.current = null;
            pending.resolve({ conflict: true, holderTabId: msg.tabId });
          }
          break;
        }
        case "claim":
          // Race tiebreak: another tab claimed the same project we hold.
          // Last-claim-wins; if tied on timestamp, larger tabId wins.
          if (heldProjectIdRef.current === msg.projectId) {
            const theirsLater = msg.since > heldSinceRef.current
              || (msg.since === heldSinceRef.current && msg.tabId > tabId);
            if (theirsLater) {
              heldProjectIdRef.current = null;
              dispatch({ type: "LOCK_TAKEN_OVER", projectId: msg.projectId });
            }
          }
          break;
        case "force-takeover":
          if (heldProjectIdRef.current === msg.projectId) {
            heldProjectIdRef.current = null;
            dispatch({ type: "LOCK_TAKEN_OVER", projectId: msg.projectId });
          }
          break;
        // "release" is informational; we don't auto-reclaim. The user can
        // click "Retake control" from the taken-over overlay.
      }
    };

    return () => {
      try { bc.close(); } catch {}
      bcRef.current = null;
    };
  }, [tabId, dispatch]);

  // Release on tab unload so a sibling tab opening the same project after
  // close doesn't see a phantom holder. pagehide is more reliable than
  // beforeunload (works in bfcache + mobile Safari).
  useEffect(() => {
    const onUnload = () => {
      const held = heldProjectIdRef.current;
      const bc = bcRef.current;
      if (held && bc) {
        try { bc.postMessage({ type: "release", projectId: held, tabId }); } catch {}
      }
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [tabId]);

  const requestAcquire = useCallback((projectId) => {
    return new Promise((resolve) => {
      const bc = bcRef.current;
      // No BroadcastChannel support → fail open (single-tab world acts as
      // before; conflicts can't be detected anyway).
      if (!bc) {
        heldProjectIdRef.current = projectId;
        heldSinceRef.current = Date.now();
        resolve({ acquired: true });
        return;
      }
      // Cancel any in-flight acquire for a different project.
      if (pendingAcquireRef.current) {
        clearTimeout(pendingAcquireRef.current.timer);
        pendingAcquireRef.current.resolve({ acquired: false, cancelled: true });
        pendingAcquireRef.current = null;
      }
      const timer = setTimeout(() => {
        pendingAcquireRef.current = null;
        heldProjectIdRef.current = projectId;
        heldSinceRef.current = Date.now();
        try { bc.postMessage({ type: "claim", projectId, tabId, since: heldSinceRef.current }); } catch {}
        resolve({ acquired: true });
      }, 200);
      pendingAcquireRef.current = { projectId, resolve, timer };
      try { bc.postMessage({ type: "whois", projectId, tabId }); } catch {}
    });
  }, [tabId]);

  const forceTakeover = useCallback((projectId) => {
    const bc = bcRef.current;
    if (bc) {
      try { bc.postMessage({ type: "force-takeover", projectId, tabId }); } catch {}
    }
    heldProjectIdRef.current = projectId;
    heldSinceRef.current = Date.now();
    if (bc) {
      try { bc.postMessage({ type: "claim", projectId, tabId, since: heldSinceRef.current }); } catch {}
    }
  }, [tabId]);

  const releaseLock = useCallback((projectId) => {
    const bc = bcRef.current;
    if (heldProjectIdRef.current === projectId) {
      heldProjectIdRef.current = null;
      heldSinceRef.current = 0;
    }
    if (bc) {
      try { bc.postMessage({ type: "release", projectId, tabId }); } catch {}
    }
  }, [tabId]);

  return { requestAcquire, forceTakeover, releaseLock };
}

// ─── useSSE hook ─────────────────────────────────────────────
function useSSE(projectId, chatId, userId, sessionEpoch, dispatch, refreshPreview, setUseCaseMermaid, setUseCasePulse, setDeploymentMermaid, setDeploymentPulse, setComponentMermaid, setComponentPulse, setActivityPulse, setERPulse, setContextUsage, setTokenStats, setServerLogLines, setServerLogPulse, setProjectSteps, setProjectLogs, applyPreviewState, setProjectCost, agentScreenshotRef, setSessionConfig) {
  const eventSourceRef = useRef(null);
  const messageStartTimeRef = useRef(null);
  const outputCharsRef = useRef(0);
  const tokenStatsIntervalRef = useRef(null);
  const textRef = useRef("");
  const thinkingTextRef = useRef("");
  const rafRef = useRef(null);
  const hasThinkingRef = useRef(false);
  const runCostRef = useRef(0); // accumulates per-inference cost across one agent round
  const isCompactingRef = useRef(false);
  const isRetryingRef = useRef(false);

  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (!projectId || !chatId || !userId) return;

    const es = new EventSource(`/api/projects/${projectId}/events?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(chatId)}`);
    eventSourceRef.current = es;

    function startLiveTokenStats() {
      stopLiveTokenStats();
      tokenStatsIntervalRef.current = setInterval(() => {
        if (!messageStartTimeRef.current) return;
        const durationMs = Date.now() - messageStartTimeRef.current;
        const durationSec = Math.max(durationMs / 1000, 0.1);
        const estimatedTokens = Math.round(outputCharsRef.current / 4);
        setTokenStats({
          inputTokens: null,
          outputTokens: estimatedTokens,
          durationMs,
          inputPerSec: null,
          outputPerSec: Math.round(estimatedTokens / durationSec),
          live: true,
        });
      }, 500);
    }

    function stopLiveTokenStats() {
      if (tokenStatsIntervalRef.current) {
        clearInterval(tokenStatsIntervalRef.current);
        tokenStatsIntervalRef.current = null;
      }
    }

    es.addEventListener("open", () => {
      api(`/projects/${projectId}/status?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(chatId)}`)
        .then(({ isStreaming, projectActiveChatId, thinkingLevel, activeProfileId, provider, modelId }) => {
          dispatch({ type: "SET_STREAMING", isStreaming });
          dispatch({ type: "SET_PROJECT_ACTIVE_CHAT", chatId: projectActiveChatId ?? null });
          // Sync the sidebar controls to this chat's live session config (which
          // the agent may have changed via set_llm_config). null fields fall
          // back to the global defaults in the dropdowns.
          setSessionConfig({
            thinkingLevel: thinkingLevel ?? null,
            activeProfileId: activeProfileId ?? null,
            provider: provider ?? null,
            modelId: modelId ?? null,
          });
        })
        .catch(() => {});
    });

    // The agent switched this chat's LLM profile and/or reasoning effort mid-run
    // (set_llm_config). Update the sidebar controls live so they reflect the
    // config the session is actually running now.
    es.addEventListener("llm_config_changed", (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      setSessionConfig((prev) => ({ ...(prev || {}), ...data }));
    });

    // Sent only to a client that connects while a turn is mid-stream (page
    // reload during an agent run). Rebuilds the live placeholder from the
    // server's partial message and seeds the accumulator refs so the deltas
    // that follow append to — rather than overwrite — the restored text.
    es.addEventListener("stream_resume", (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      const text = data.text || "";
      const thinking = data.thinking || "";
      if (!text && !thinking) return;
      textRef.current = text;
      thinkingTextRef.current = thinking;
      outputCharsRef.current = text.length + thinking.length;
      if (data.startTime) {
        messageStartTimeRef.current = data.startTime;
        startLiveTokenStats();
      }
      if (thinking) {
        if (!hasThinkingRef.current) {
          hasThinkingRef.current = true;
          dispatch({ type: "ADD_THINKING", text: thinking });
        } else {
          dispatch({ type: "UPDATE_LAST_THINKING", text: thinking });
        }
      }
      dispatch({ type: "RESUME_ASSISTANT", text, ts: new Date().toISOString() });
    });

    es.addEventListener("message_start", (e) => {
      textRef.current = "";
      thinkingTextRef.current = "";
      hasThinkingRef.current = false;
      try {
        const data = JSON.parse(e.data);
        if (data.startTime) {
          messageStartTimeRef.current = data.startTime;
          outputCharsRef.current = 0;
          startLiveTokenStats();
        }
      } catch {}
      dispatch({ type: "ADD_MESSAGE", message: { type: "assistant", text: "", streaming: true, ts: new Date().toISOString() } });
    });

    es.addEventListener("text_delta", (e) => {
      const { delta } = JSON.parse(e.data);
      textRef.current += delta;
      outputCharsRef.current += delta.length;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        dispatch({ type: "UPDATE_LAST_ASSISTANT", updates: { text: textRef.current } });
      });
    });

    es.addEventListener("thinking_delta", (e) => {
      const { delta } = JSON.parse(e.data);
      thinkingTextRef.current += delta;
      outputCharsRef.current += delta.length;
      if (!hasThinkingRef.current) {
        hasThinkingRef.current = true;
        dispatch({ type: "ADD_THINKING", text: thinkingTextRef.current });
      } else {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          dispatch({ type: "UPDATE_LAST_THINKING", text: thinkingTextRef.current });
        });
      }
    });

    es.addEventListener("message_end", (e) => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      let data = null;
      try { data = JSON.parse(e.data); } catch {}
      const stepCost = data?.usage?.costUsd;
      if (typeof stepCost === "number" && Number.isFinite(stepCost)) runCostRef.current += stepCost;
      // A textless step is a tool-calling inference — not rendered on its own,
      // so keep its cost in the accumulator and attach the running round total
      // to the next assistant message that actually shows text.
      const stepHasText = !!textRef.current;
      dispatch({ type: "UPDATE_LAST_ASSISTANT", updates: {
        text: textRef.current,
        streaming: false,
        ...(stepHasText ? { costUsd: runCostRef.current, model: data?.model, reasoning: data?.reasoning } : {}),
      } });
      if (stepHasText) runCostRef.current = 0;
      hasThinkingRef.current = false;
      stopLiveTokenStats();
      if (data?.usage && messageStartTimeRef.current) {
        const durationMs = (data.endTime || Date.now()) - messageStartTimeRef.current;
        const durationSec = Math.max(durationMs / 1000, 0.1);
        setTokenStats({
          inputTokens: data.usage.input,
          outputTokens: data.usage.output,
          durationMs,
          inputPerSec: Math.round(data.usage.input / durationSec),
          outputPerSec: Math.round(data.usage.output / durationSec),
          live: false,
        });
      }
    });

    es.addEventListener("tool_start", (e) => {
      const { toolCallId, toolName, args } = JSON.parse(e.data);
      if (toolName === "ask_question") {
        dispatch({ type: "ADD_MESSAGE", message: {
          type: "question", toolCallId,
          question: args.question, options: args.options,
          answered: false, selectedAnswer: null,
        }});
        return;
      }
      if (isInternalToolCall({ args })) return;
      const skill = isSkillInvocation({ args }) ? getSkillName({ args }) : null;
      dispatch({ type: "ADD_TOOL_CALL", tool: { toolCallId, toolName, args, status: "running", isSkill: !!skill, skillName: skill } });
    });

    es.addEventListener("tool_update", (e) => {
      const { toolCallId, partialResult } = JSON.parse(e.data);
      const chunk = typeof partialResult === "string"
        ? partialResult
        : (partialResult?.output || partialResult?.stdout || JSON.stringify(partialResult));
      if (chunk) dispatch({ type: "APPEND_TOOL_OUTPUT", toolCallId, chunk });
    });

    es.addEventListener("tool_end", (e) => {
      const { toolCallId, toolName, isError, result } = JSON.parse(e.data);
      if (toolName === "ask_question") return; // question completion is handled by user interaction
      const finalOutput = typeof result === "string" ? result : (result?.output || result?.stdout || null);
      dispatch({
        type: "UPDATE_TOOL",
        toolCallId,
        updates: {
          status: isError ? "error" : "completed",
          ...(finalOutput != null ? { output: finalOutput } : {}),
        },
      });
    });

    es.addEventListener("agent_start", () => {
      stopLiveTokenStats();
      setTokenStats(null);
      messageStartTimeRef.current = null;
      outputCharsRef.current = 0;
      runCostRef.current = 0;
      dispatch({ type: "SET_STREAMING", isStreaming: true });
    });

    es.addEventListener("agent_end", () => {
      // During compaction or retry, the agent restarts — don't finalize streaming
      if (isCompactingRef.current || isRetryingRef.current) return;
      dispatch({ type: "SET_STREAMING", isStreaming: false });
      // Preview refresh is handled by "files_changed" event sent after process restart completes
    });

    // Project-level prompt gate. These broadcast to every chat in the project
    // (including viewing-only chats), so each tab can disable its send button
    // while another chat is running an agent task.
    es.addEventListener("project_lock_acquired", (e) => {
      try {
        const { chatId: holderChatId } = JSON.parse(e.data);
        dispatch({ type: "SET_PROJECT_ACTIVE_CHAT", chatId: holderChatId ?? null });
      } catch {}
    });

    es.addEventListener("project_lock_released", () => {
      dispatch({ type: "SET_PROJECT_ACTIVE_CHAT", chatId: null });
    });

    es.addEventListener("lock_taken_over", (e) => {
      // Cross-user takeover: the project owner forcibly grabbed our server
      // lock. Flip into the bumped overlay so further writes are blocked.
      try {
        const { newHolder } = JSON.parse(e.data);
        dispatch({ type: "SERVER_LOCK_BUMPED", newHolder });
      } catch {
        dispatch({ type: "SERVER_LOCK_BUMPED", newHolder: null });
      }
    });

    es.addEventListener("preview_state", (e) => {
      try {
        applyPreviewState(JSON.parse(e.data));
      } catch {}
    });

    es.addEventListener("files_changed", () => {
      refreshPreview();
    });

    // The agent's screenshot tool asks this browser to
    // capture the preview iframe and POST the image back to resolve the
    // blocked tool call.
    es.addEventListener("screenshot_request", async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      const post = (body) => api(`/projects/${projectId}/screenshot-result`, {
        method: "POST",
        body: JSON.stringify({ userId, chatId, toolCallId: data.toolCallId, ...body }),
      }).catch(() => {}); // with several tabs open the losing POSTs get a 500 — ignore
      const capture = agentScreenshotRef?.current;
      if (!capture) {
        await post({ ok: false, error: "The preview pane is not available in this browser view" });
        return;
      }
      try {
        const { dataUrl, width, height } = await capture();
        await post({ ok: true, dataUrl, width, height });
      } catch (err) {
        await post({ ok: false, error: err?.message || "capture failed" });
      }
    });

    es.addEventListener("compaction_start", () => {
      isCompactingRef.current = true;
    });

    es.addEventListener("compaction_end", (e) => {
      isCompactingRef.current = false;
      try {
        const { error } = JSON.parse(e.data);
        dispatch({ type: "ADD_MESSAGE", message: { type: "compaction", error: error || null } });
      } catch {}
    });

    // A compaction attempt failed but the server is retrying it — keep the
    // "compacting" state so the input stays gated and no error is shown yet.
    es.addEventListener("compaction_retry", () => {
      isCompactingRef.current = true;
    });

    es.addEventListener("retry_start", () => {
      isRetryingRef.current = true;
    });

    es.addEventListener("retry_end", (e) => {
      isRetryingRef.current = false;
      try {
        const { success } = JSON.parse(e.data);
        if (!success) {
          dispatch({ type: "SET_STREAMING", isStreaming: false });
        }
      } catch {}
    });

    es.addEventListener("context_usage", (e) => {
      try {
        const data = JSON.parse(e.data);
        setContextUsage(data);
      } catch {}
    });

    // Lifetime project spend: seeded on connect, updated after each
    // assistant message (project-wide broadcast).
    es.addEventListener("project_cost", (e) => {
      try {
        setProjectCost(JSON.parse(e.data));
      } catch {}
    });

    es.addEventListener("usecase_updated", (e) => {
      try {
        const { mermaid } = JSON.parse(e.data);
        if (mermaid) {
          setUseCaseMermaid(mermaid);
          setUseCasePulse(true);
        }
      } catch {}
    });

    es.addEventListener("deployment_updated", (e) => {
      try {
        const { mermaid } = JSON.parse(e.data);
        if (mermaid) {
          setDeploymentMermaid(mermaid);
          setDeploymentPulse(true);
        }
      } catch {}
    });

    es.addEventListener("component_updated", (e) => {
      try {
        const { mermaid } = JSON.parse(e.data);
        if (mermaid) {
          setComponentMermaid(mermaid);
          setComponentPulse(true);
        }
      } catch {}
    });

    es.addEventListener("activity_updated", (e) => {
      try {
        setActivityPulse(true);
      } catch {}
    });

    es.addEventListener("er_updated", (e) => {
      try {
        setERPulse(true);
      } catch {}
    });

    es.addEventListener("project_step", (e) => {
      try {
        const { step, status, error } = JSON.parse(e.data);
        setProjectSteps(prev => ({ ...prev, [step]: { status, error } }));
      } catch {}
    });

    es.addEventListener("project_log", (e) => {
      try {
        const { step, line } = JSON.parse(e.data);
        setProjectLogs(prev => ({ ...prev, [step]: [...(prev[step] || []), line] }));
      } catch {}
    });

    es.addEventListener("server_log", (e) => {
      try {
        const { line, stream } = JSON.parse(e.data);
        setServerLogLines(prev => {
          const next = [...prev, { line, stream, ts: Date.now() }];
          return next.length > 200 ? next.slice(-200) : next;
        });
        const sev = classifyServerLogLine(stream, line);
        if (sev === "stderr") {
          setServerLogPulse("error");
        } else if (sev === "warning") {
          setServerLogPulse(prev => prev === "error" ? prev : "warn");
        }
      } catch {}
    });

    es.addEventListener("chat_renamed", (e) => {
      try {
        const { chatId: renamedId, name } = JSON.parse(e.data);
        if (renamedId && name) {
          dispatch({ type: "UPDATE_CHAT", chat: { id: renamedId, name } });
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("chat_created", (e) => {
      // Server-spawned chat (template setup/predeploy/postdeploy hooks, or
      // an agent's start_new_chat call). Insert the tab and optionally
      // switch focus so the user sees the streaming agent right away.
      try {
        const { chat, autoSwitch } = JSON.parse(e.data);
        if (!chat?.id) return;
        dispatch({ type: "ADD_CHAT", chat });
        if (autoSwitch) {
          dispatch({ type: "SELECT_CHAT", chatId: chat.id });
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("error", (e) => {
      try {
        const { message, status, code } = JSON.parse(e.data);
        if (code === "CONTEXT_COMPACTED") {
          // Compaction succeeded; the pi SDK just couldn't auto-continue the
          // turn. Show a calm, non-error notice (not the red LLM error style)
          // and keep the input usable — no resend prompt.
          dispatch({ type: "ADD_MESSAGE", message: { type: "assistant", text: message, streaming: false, isError: false } });
          dispatch({ type: "SET_STREAMING", isStreaming: false });
          return;
        }
        if (code === "CODEX_AUTH_REQUIRED") {
          // The ChatGPT (Codex) sign-in is expired/revoked — the VCA session
          // itself is fine, so the reconnect dialog would mislead. The server
          // message says exactly what to do (Settings → sign in with ChatGPT).
          dispatch({ type: "ADD_MESSAGE", message: { type: "assistant", text: message, streaming: false, isError: true } });
          dispatch({ type: "SET_STREAMING", isStreaming: false });
          return;
        }
        if (code === "LLM_AUTH_ERROR") {
          // Provider-side auth/entitlement failure (bad key, wrong endpoint, or the
          // model isn't available for this subscription). The VCA session itself is
          // fine, so the reconnect modal would mislead — show an actionable bubble.
          dispatch({ type: "ADD_MESSAGE", message: { type: "assistant", text: message, streaming: false, isError: true } });
          dispatch({ type: "SET_STREAMING", isStreaming: false });
          return;
        }
        const errorText = status && status !== "unknown"
          ? `LLM error (${status}): ${message}`
          : `LLM error: ${message}`;
        dispatch({ type: "ADD_MESSAGE", message: { type: "assistant", text: errorText, streaming: false, isError: true } });
        dispatch({ type: "SET_STREAMING", isStreaming: false });
      } catch {
        if (es.readyState === EventSource.CLOSED) {
          dispatch({ type: "SET_STREAMING", isStreaming: false });
        }
      }
    });

    return () => {
      es.close();
      stopLiveTokenStats();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      isCompactingRef.current = false;
      isRetryingRef.current = false;
    };
  }, [projectId, chatId, userId, sessionEpoch, applyPreviewState, refreshPreview]);
}

// ─── Tooltip wrapper ─────────────────────────────────────────
/**
 * Renders children either as a modal Dialog (default) or as an inline panel
 * (when `embedded`). Lets Settings dialogs double as embedded settings tabs
 * without duplicating their bodies.
 */
function DialogOrPanel({ embedded, open, onOpenChange, title, titleIcon, maxWidth = 720, sticky = false, children }) {
  if (embedded) {
    return (
      <div className="settings-embedded-panel">
        <div className="settings-section-title">{titleIcon} {title}</div>
        {children}
      </div>
    );
  }
  const contentClass = `modal-content${sticky ? " modal-sticky" : ""} wide`;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={contentClass} style={{ maxWidth }}>
          <Dialog.Title className="modal-title">{titleIcon} {title}</Dialog.Title>
          {children}
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary"><X size={14} /> Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Tip({ label, children, side = "bottom", avoidCollisions = true }) {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} className="tooltip-content" sideOffset={5} avoidCollisions={avoidCollisions}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// ─── Onboarding ──────────────────────────────────────────────
function useOnboarding() {
  const [step, setStep] = useState(() => {
    const done = localStorage.getItem("vca-onboarding-done");
    return done ? null : "open-sidebar";
  });
  const advance = useCallback((completedStep) => {
    setStep(prev => {
      if (prev === "open-sidebar" && completedStep === "open-sidebar") return "create-project";
      if (prev === "create-project" && completedStep === "create-project") return "send-prompt";
      if (prev === "send-prompt" && completedStep === "send-prompt") {
        localStorage.setItem("vca-onboarding-done", "1");
        return null;
      }
      return prev;
    });
  }, []);
  const dismiss = useCallback(() => {
    localStorage.setItem("vca-onboarding-done", "1");
    setStep(null);
  }, []);
  return { onboardingStep: step, advanceOnboarding: advance, dismissOnboarding: dismiss };
}

function OnboardingTooltip({ targetRef, text, side = "right", onDismiss }) {
  const [pos, setPos] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const update = () => {
      if (!targetRef?.current) return;
      const r = targetRef.current.getBoundingClientRect();
      setPos({ top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [targetRef]);

  // Guide bubbles must not linger: hide after 10 s, or as soon as the user
  // clicks the element the bubble points at. Only this bubble is hidden —
  // the onboarding step itself stays active (clicking the target runs its
  // own handlers, which advance the tour where applicable), so the discard
  // button remains the only way to opt out of the whole tour.
  useEffect(() => {
    const el = targetRef?.current;
    const hide = () => setHidden(true);
    const timer = setTimeout(hide, 10_000);
    el?.addEventListener("click", hide, true);
    return () => {
      clearTimeout(timer);
      el?.removeEventListener("click", hide, true);
    };
  }, [targetRef]);

  if (!pos || hidden) return null;

  const style = {};
  if (side === "right") {
    style.top = pos.top + pos.height / 2;
    style.left = pos.right + 12;
    style.transform = "translateY(-50%)";
  } else if (side === "bottom") {
    style.top = pos.bottom + 12;
    style.left = pos.left + pos.width / 2;
    style.transform = "translateX(-50%)";
  } else if (side === "top") {
    style.top = pos.top - 12;
    style.left = pos.left + pos.width / 2;
    style.transform = "translate(-50%, -100%)";
  }

  return (
    <div className="onboarding-tooltip" style={style} data-side={side}>
      <div className="onboarding-arrow" />
      <span>{text}</span>
      <button className="onboarding-dismiss" onClick={onDismiss}><X size={12} /></button>
    </div>
  );
}

// ─── Preview Pane ────────────────────────────────────────────

function SidebarToggle() {
  const { state, dispatch, onboardingStep, advanceOnboarding, dismissOnboarding, sidebarHandlePulse, t } = useContext(AppContext);
  const btnRef = useRef(null);
  const pulseClass = sidebarHandlePulse === "error" ? " pulse-error" : "";

  return (
    <>
      <Tip label={state.sidebarOpen ? t("sidebar.closeSidebar") : t("sidebar.openSidebar")} side="right">
        <button
          ref={btnRef}
          className={`sidebar-toggle-btn${state.sidebarOpen ? " open" : ""}${pulseClass}`}
          onClick={() => {
            dispatch({ type: "TOGGLE_SIDEBAR" });
            if (!state.sidebarOpen) advanceOnboarding("open-sidebar");
          }}
        >
          {state.sidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>
      </Tip>
      {onboardingStep === "open-sidebar" && !state.sidebarOpen && (
        <OnboardingTooltip targetRef={btnRef} text={t("onboarding.openSidebar")} side="right" onDismiss={dismissOnboarding} />
      )}
    </>
  );
}

function PreviewPane() {
  const { iframeRef, state, dispatch, userId, imageConfigured, addScreenshotAttachment, refreshPreview, t, captureScreenshotRef, agentScreenshotRef, architectMode, setArchitectMode, useCasePulse, setUseCasePulse, deploymentPulse, setDeploymentPulse, componentPulse, setComponentPulse, activityPulse, setActivityPulse, erPulse, setERPulse } = useContext(AppContext);
  const [annotating, setAnnotating] = useState(false);
  const [overlayMode, setOverlayMode] = useState(null); // null | 'editing' | 'done'
  const wasStreamingRef = useRef(false);
  const overlayTimerRef = useRef(null);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const [tool, setTool] = useState("freehand");
  const [strokeColor, setStrokeColor] = useState("#ff0000");
  const [fillColor, setFillColor] = useState("transparent");
  const [activeColorTarget, setActiveColorTarget] = useState("stroke"); // "stroke" | "fill"
  const [fontSize, setFontSize] = useState(16);
  const [drawing, setDrawing] = useState(false);
  const [startPos, setStartPos] = useState(null);
  const historyRef = useRef([]);
  const [textInput, setTextInput] = useState(null); // { x, y, value }
  const textInputRef = useRef(null);
  const [floatingImage, setFloatingImage] = useState(null); // { x, y, w, h }
  const [floatingDrag, setFloatingDrag] = useState(null); // { type, handle?, startX, startY, origRect }
  const floatingImageRef = useRef(null);
  const floatingImageStateRef = useRef(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const hasImageAi = imageConfigured;
  const sidebarWasOpen = useRef(false);
  const rightSidebarWasOpen = useRef(false);

  // ── AI editing overlay logic ──
  useEffect(() => {
    if (state.isStreaming) {
      clearTimeout(overlayTimerRef.current);
      wasStreamingRef.current = true;
      setOverlayMode("editing");
    } else if (wasStreamingRef.current) {
      // Streaming ended — keep overlay visible during server restart gap.
      // Fallback: remove overlay if files_changed never arrives (e.g. question-only).
      overlayTimerRef.current = setTimeout(() => {
        wasStreamingRef.current = false;
        setOverlayMode(null);
      }, 8000);
    }
  }, [state.isStreaming]);

  const handleIframeLoad = useCallback(() => {
    // Only transition to "done" if we were showing the editing overlay after streaming ended
    if (!state.isStreaming && wasStreamingRef.current) {
      clearTimeout(overlayTimerRef.current);
      wasStreamingRef.current = false;
      setOverlayMode("done");
      overlayTimerRef.current = setTimeout(() => setOverlayMode(null), 2000);
    }
  }, [state.isStreaming]);

  useEffect(() => () => clearTimeout(overlayTimerRef.current), []);

  const COLORS = ["#ff0000", "#ff6600", "#ffcc00", "#00cc00", "#0088ff", "#8833ff", "#ff00cc", "#ffffff", "#000000"];
  const FONT_SIZES = [12, 16, 20, 28, 36, 48];
  const activeColor = activeColorTarget === "stroke" ? strokeColor : fillColor;
  const setActiveColor = (c) => { if (activeColorTarget === "stroke") setStrokeColor(c); else setFillColor(c); };

  // Grab one frame of this window via getDisplayMedia and crop it to the
  // preview iframe's current rect. Shared by the manual screenshot button and
  // the agent's screenshot tool.
  const captureIframeImage = async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      preferCurrentTab: true,
    });
    const track = stream.getVideoTracks()[0];
    try {
      const imageCapture = new ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();

      const rect = iframeRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const sx = rect.left * dpr, sy = rect.top * dpr;
      const sw = rect.width * dpr, sh = rect.height * dpr;

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      bitmap.close();

      return canvas.toDataURL("image/png");
    } finally {
      track.stop();
    }
  };

  const captureScreenshot = async () => {
    if (!iframeRef.current) return;
    sidebarWasOpen.current = state.sidebarOpen;
    rightSidebarWasOpen.current = state.rightSidebarOpen;
    if (state.sidebarOpen) dispatch({ type: "SET_SIDEBAR", open: false });
    if (state.rightSidebarOpen) dispatch({ type: "SET_RIGHT_SIDEBAR", open: false });
    if (state.sidebarOpen || state.rightSidebarOpen) await new Promise(r => setTimeout(r, 350));
    try {
      setScreenshotDataUrl(await captureIframeImage());
      setAnnotating(true);
    } catch (err) {
      console.error("Screenshot capture failed:", err);
      if (sidebarWasOpen.current) dispatch({ type: "SET_SIDEBAR", open: true });
      if (rightSidebarWasOpen.current) dispatch({ type: "SET_RIGHT_SIDEBAR", open: true });
    }
  };

  // Capture requested by the agent's screenshot tool.
  // Unlike the manual flow this must show the current app — not the
  // "AI is editing your app" overlay — and never opens the annotation UI.
  const performAgentScreenshot = async () => {
    if (!iframeRef.current || !state.currentProjectId) throw new Error("No project preview is open");
    if (annotating) throw new Error("The user is annotating a screenshot, which hides the preview");
    if (architectMode) {
      setArchitectMode(false);
      await new Promise(r => setTimeout(r, 750)); // flip-back animation
    }
    // Suppress the editing overlay for the capture. isStreaming stays true for
    // the whole tool call, so the overlay effect won't re-fire meanwhile;
    // restore whatever mode was showing once done. Collapse the sidebars too
    // (same as the manual screenshot button) so the iframe gets the full
    // window, and restore them afterwards.
    const prevOverlay = overlayMode;
    setOverlayMode(null);
    const sidebarWas = state.sidebarOpen;
    const rightSidebarWas = state.rightSidebarOpen;
    if (sidebarWas) dispatch({ type: "SET_SIDEBAR", open: false });
    if (rightSidebarWas) dispatch({ type: "SET_RIGHT_SIDEBAR", open: false });
    try {
      if (sidebarWas || rightSidebarWas) await new Promise(r => setTimeout(r, 350)); // collapse animation
      // Reload the iframe so the capture shows the app's current files,
      // skipping the intermediate about:blank hop loadPreview goes through.
      await new Promise((resolve) => {
        const iframe = iframeRef.current;
        const timer = setTimeout(done, 15000);
        function done() {
          clearTimeout(timer);
          iframe.removeEventListener("load", onLoad);
          resolve();
        }
        function onLoad() {
          try {
            if (iframe.contentWindow.location.href === "about:blank") return;
          } catch { /* cross-origin — treat as the real load */ }
          done();
        }
        iframe.addEventListener("load", onLoad);
        refreshPreview();
      });
      await new Promise(r => setTimeout(r, 300)); // paint settle
      const raw = await captureIframeImage();
      // Same size optimization as the manual "add to chat" screenshot path.
      const { dataUrl } = await compressImageDataUrl(raw);
      const rect = iframeRef.current.getBoundingClientRect();
      return { dataUrl, width: Math.round(rect.width), height: Math.round(rect.height) };
    } finally {
      setOverlayMode(prevOverlay);
      if (sidebarWas) dispatch({ type: "SET_SIDEBAR", open: true });
      if (rightSidebarWas) dispatch({ type: "SET_RIGHT_SIDEBAR", open: true });
    }
  };

  const exitAnnotation = () => {
    if (floatingImageRef.current?.src?.startsWith("blob:")) URL.revokeObjectURL(floatingImageRef.current.src);
    floatingImageRef.current = null;
    setFloatingImage(null);
    setFloatingDrag(null);
    setAnnotating(false);
    setScreenshotDataUrl(null);
    setAiPrompt("");
    setAiError("");
    historyRef.current = [];
    if (sidebarWasOpen.current) dispatch({ type: "SET_SIDEBAR", open: true });
    if (rightSidebarWasOpen.current) dispatch({ type: "SET_RIGHT_SIDEBAR", open: true });
  };

  useEffect(() => { captureScreenshotRef.current = captureScreenshot; });
  useEffect(() => { agentScreenshotRef.current = performAgentScreenshot; });

  // Initialize canvases when screenshot is ready
  useEffect(() => {
    if (!annotating || !screenshotDataUrl || !containerRef.current) return;
    const img = new window.Image();
    img.onload = () => {
      imgRef.current = img;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const scale = Math.min(cw / img.width, ch / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      canvasRef.current.width = w;
      canvasRef.current.height = h;
      overlayRef.current.width = w;
      overlayRef.current.height = h;
      const ctx = canvasRef.current.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      historyRef.current = [canvasRef.current.toDataURL()];
    };
    img.src = screenshotDataUrl;
  }, [annotating, screenshotDataUrl]);

  // Keep floatingImage ref in sync for event listeners
  useEffect(() => { floatingImageStateRef.current = floatingImage; }, [floatingImage]);

  // Paste image from clipboard
  useEffect(() => {
    if (!annotating) return;
    const loadFloatingImage = (blob) => {
      const url = URL.createObjectURL(blob);
      const img = new window.Image();
      img.onload = () => {
        if (!canvasRef.current) return;
        const cw = canvasRef.current.width, ch = canvasRef.current.height;
        const maxW = cw * 0.5, maxH = ch * 0.5;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        floatingImageRef.current = img;
        setFloatingImage({ x: Math.round((cw - w) / 2), y: Math.round((ch - h) / 2), w, h });
      };
      img.src = url;
    };
    const handlePaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          loadFloatingImage(item.getAsFile());
          break;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [annotating]);

  // Draw floating image + handles on overlay
  useEffect(() => {
    if (!floatingImage || !overlayRef.current || !floatingImageRef.current) return;
    const octx = overlayRef.current.getContext("2d");
    octx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
    const { x, y, w, h } = floatingImage;
    octx.drawImage(floatingImageRef.current, x, y, w, h);
    octx.strokeStyle = "#0088ff";
    octx.lineWidth = 2;
    octx.setLineDash([6, 3]);
    octx.strokeRect(x, y, w, h);
    octx.setLineDash([]);
    const hs = 8;
    octx.fillStyle = "#ffffff";
    octx.strokeStyle = "#0088ff";
    octx.lineWidth = 2;
    [{ cx: x, cy: y }, { cx: x + w, cy: y }, { cx: x, cy: y + h }, { cx: x + w, cy: y + h }].forEach(({ cx, cy }) => {
      octx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      octx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
    });
  }, [floatingImage]);

  // Keyboard: Enter to commit, Escape to cancel floating image
  useEffect(() => {
    if (!floatingImage) return;
    const handleKeyDown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitFloatingImage(); }
      if (e.key === "Escape") { e.preventDefault(); cancelFloatingImage(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [floatingImage]);

  const getPos = (e) => {
    const rect = overlayRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const saveState = () => { historyRef.current.push(canvasRef.current.toDataURL()); };
  const clearOverlay = () => { overlayRef.current.getContext("2d").clearRect(0, 0, overlayRef.current.width, overlayRef.current.height); };
  const commitOverlay = () => {
    canvasRef.current.getContext("2d").drawImage(overlayRef.current, 0, 0);
    clearOverlay();
    saveState();
  };
  const commitFloatingImage = () => {
    const fi = floatingImageStateRef.current;
    if (!fi || !floatingImageRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    ctx.drawImage(floatingImageRef.current, fi.x, fi.y, fi.w, fi.h);
    saveState();
    clearOverlay();
    if (floatingImageRef.current.src.startsWith("blob:")) URL.revokeObjectURL(floatingImageRef.current.src);
    floatingImageRef.current = null;
    setFloatingImage(null);
    setFloatingDrag(null);
  };
  const cancelFloatingImage = () => {
    if (!floatingImageStateRef.current) return;
    clearOverlay();
    if (floatingImageRef.current?.src?.startsWith("blob:")) URL.revokeObjectURL(floatingImageRef.current.src);
    floatingImageRef.current = null;
    setFloatingImage(null);
    setFloatingDrag(null);
  };
  const undo = () => {
    if (floatingImage) { cancelFloatingImage(); return; }
    if (historyRef.current.length <= 1) return;
    historyRef.current.pop();
    const prev = historyRef.current[historyRef.current.length - 1];
    const img = new window.Image();
    img.onload = () => {
      const ctx = canvasRef.current.getContext("2d");
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = prev;
  };

  const commitText = (txt, x, y) => {
    if (!txt || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    const lh = Math.round(fontSize * 1.3);
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    ctx.fillStyle = strokeColor;
    ctx.textBaseline = "top";
    txt.split("\n").forEach((line, i) => {
      ctx.fillText(line, x, y + i * lh);
    });
    saveState();
  };

  const onPointerDown = (e) => {
    if (floatingImage) {
      const pos = getPos(e);
      const { x, y, w, h } = floatingImage;
      const hs = 8;
      const handles = [
        { id: "nw", cx: x, cy: y }, { id: "ne", cx: x + w, cy: y },
        { id: "sw", cx: x, cy: y + h }, { id: "se", cx: x + w, cy: y + h },
      ];
      for (const handle of handles) {
        if (Math.abs(pos.x - handle.cx) <= hs && Math.abs(pos.y - handle.cy) <= hs) {
          setFloatingDrag({ type: "resize", handle: handle.id, startX: pos.x, startY: pos.y, origRect: { x, y, w, h } });
          overlayRef.current.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
        setFloatingDrag({ type: "move", startX: pos.x, startY: pos.y, origRect: { x, y, w, h } });
        overlayRef.current.setPointerCapture(e.pointerId);
        return;
      }
      commitFloatingImage();
    }
    if (tool === "text") {
      const pos = getPos(e);
      // If already editing text, commit it first
      if (textInput) {
        commitText(textInput.value, textInput.x, textInput.y);
        setTextInput(null);
      }
      setTextInput({ x: pos.x, y: pos.y, value: "" });
      setTimeout(() => textInputRef.current?.focus(), 0);
      return;
    }
    // Commit any pending text when switching away
    if (textInput) { commitText(textInput.value, textInput.x, textInput.y); setTextInput(null); }
    setDrawing(true);
    const pos = getPos(e);
    setStartPos(pos);
    if (tool === "freehand") {
      const octx = overlayRef.current.getContext("2d");
      octx.beginPath();
      octx.moveTo(pos.x, pos.y);
      octx.strokeStyle = strokeColor;
      octx.lineWidth = 3;
      octx.lineCap = "round";
      octx.lineJoin = "round";
    }
    overlayRef.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (floatingDrag) {
      const pos = getPos(e);
      const { type, startX, startY, origRect } = floatingDrag;
      const dx = pos.x - startX, dy = pos.y - startY;
      if (type === "move") {
        setFloatingImage({ ...origRect, x: origRect.x + dx, y: origRect.y + dy });
      } else {
        const hid = floatingDrag.handle;
        let nx = origRect.x, ny = origRect.y, nw = origRect.w, nh = origRect.h;
        if (hid === "se") { nw = Math.max(20, origRect.w + dx); nh = Math.max(20, origRect.h + dy); }
        else if (hid === "sw") { nx = origRect.x + dx; nw = Math.max(20, origRect.w - dx); nh = Math.max(20, origRect.h + dy); }
        else if (hid === "ne") { ny = origRect.y + dy; nw = Math.max(20, origRect.w + dx); nh = Math.max(20, origRect.h - dy); }
        else if (hid === "nw") { nx = origRect.x + dx; ny = origRect.y + dy; nw = Math.max(20, origRect.w - dx); nh = Math.max(20, origRect.h - dy); }
        setFloatingImage({ x: nx, y: ny, w: nw, h: nh });
      }
      return;
    }
    if (!drawing) return;
    const pos = getPos(e);
    const octx = overlayRef.current.getContext("2d");
    if (tool === "freehand") {
      octx.lineTo(pos.x, pos.y);
      octx.stroke();
    } else {
      clearOverlay();
      octx.strokeStyle = strokeColor;
      octx.lineWidth = 3;
      octx.lineCap = "round";
      const dx = pos.x - startPos.x, dy = pos.y - startPos.y;
      if (tool === "select") {
        octx.strokeStyle = "#0088ff";
        octx.lineWidth = 2;
        octx.setLineDash([6, 3]);
        octx.strokeRect(startPos.x, startPos.y, dx, dy);
        octx.setLineDash([]);
      }
      else if (tool === "line") { octx.beginPath(); octx.moveTo(startPos.x, startPos.y); octx.lineTo(pos.x, pos.y); octx.stroke(); }
      else if (tool === "rect") {
        if (fillColor !== "transparent") { octx.fillStyle = fillColor; octx.fillRect(startPos.x, startPos.y, dx, dy); }
        octx.strokeRect(startPos.x, startPos.y, dx, dy);
      }
      else if (tool === "circle") {
        octx.beginPath(); octx.ellipse(startPos.x + dx/2, startPos.y + dy/2, Math.abs(dx)/2, Math.abs(dy)/2, 0, 0, Math.PI*2);
        if (fillColor !== "transparent") { octx.fillStyle = fillColor; octx.fill(); }
        octx.stroke();
      }
    }
  };
  const onPointerUp = (e) => {
    if (floatingDrag) { setFloatingDrag(null); return; }
    if (!drawing) return;
    setDrawing(false);
    if (tool === "select" && startPos) {
      clearOverlay();
      const pos = getPos(e);
      const sx = Math.min(startPos.x, pos.x), sy = Math.min(startPos.y, pos.y);
      const sw = Math.abs(pos.x - startPos.x), sh = Math.abs(pos.y - startPos.y);
      if (sw < 5 || sh < 5) return;
      // Extract selected region from main canvas
      const tmp = document.createElement("canvas");
      tmp.width = sw; tmp.height = sh;
      tmp.getContext("2d").drawImage(canvasRef.current, sx, sy, sw, sh, 0, 0, sw, sh);
      const isCopy = e.ctrlKey || e.metaKey;
      if (!isCopy) {
        // Move: clear original area with white
        const ctx = canvasRef.current.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(sx, sy, sw, sh);
        saveState();
      }
      const img = new window.Image();
      img.onload = () => {
        floatingImageRef.current = img;
        setFloatingImage({ x: sx, y: sy, w: sw, h: sh });
      };
      img.src = tmp.toDataURL();
      return;
    }
    commitOverlay();
  };

  const handleAttach = () => {
    if (floatingImage) commitFloatingImage();
    if (textInput) { commitText(textInput.value, textInput.x, textInput.y); setTextInput(null); }
    addScreenshotAttachment(canvasRef.current.toDataURL("image/png"));
    sidebarWasOpen.current = true;
    exitAnnotation();
  };

  const handleAiEdit = async () => {
    if (!aiPrompt.trim() || !hasImageAi || !canvasRef.current) return;
    setAiLoading(true);
    setAiError("");
    try {
      const currentDataUrl = canvasRef.current.toDataURL("image/png");
      // Single backend proxy handles provider dispatch + key lookup, so the
      // browser never needs to hold the OpenRouter / Google / etc. key.
      const res = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt, imageDataUrl: currentDataUrl }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `API error ${res.status}`); }
      const result = await res.json();
      if (!result?.dataUrl) throw new Error("No image returned");
      const newImg = new window.Image();
      newImg.onload = () => {
        imgRef.current = newImg;
        const ctx = canvasRef.current.getContext("2d");
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        ctx.drawImage(newImg, 0, 0, canvasRef.current.width, canvasRef.current.height);
        historyRef.current.push(canvasRef.current.toDataURL());
        setAiLoading(false);
      };
      newImg.onerror = () => { setAiError("Failed to load returned image"); setAiLoading(false); };
      newImg.src = result.dataUrl;
    } catch (err) { setAiError(err.message); setAiLoading(false); }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const url = URL.createObjectURL(blob);
          const img = new window.Image();
          img.onload = () => {
            if (!canvasRef.current) return;
            const cw = canvasRef.current.width, ch = canvasRef.current.height;
            const maxW = cw * 0.5, maxH = ch * 0.5;
            const scale = Math.min(maxW / img.width, maxH / img.height, 1);
            const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
            floatingImageRef.current = img;
            setFloatingImage({ x: Math.round((cw - w) / 2), y: Math.round((ch - h) / 2), w, h });
          };
          img.src = url;
          break;
        }
      }
    } catch (err) { console.error("Clipboard read failed:", err); }
  };

  const selectTool = (id) => {
    if (floatingImage) commitFloatingImage();
    setTool(id);
  };

  const annotTools = [
    { id: "select", icon: BoxSelect, label: t("annotator.select") },
    { id: "freehand", icon: Pencil, label: t("annotator.freehand") },
    { id: "line", icon: Minus, label: t("annotator.line") },
    { id: "rect", icon: Square, label: t("annotator.rectangle") },
    { id: "circle", icon: Circle, label: t("annotator.circle") },
    { id: "text", icon: Type, label: t("annotator.text") },
  ];

  return (
    <div className="preview-pane">
      <iframe ref={iframeRef} src="about:blank" className="preview-iframe" style={annotating ? { visibility: "hidden" } : undefined} onLoad={handleIframeLoad} />
      {!state.currentProjectId && (
        <div className="preview-empty">
          <FolderOpen size={48} />
          <h2>{t("preview.empty.title")}</h2>
          <p>{t("preview.empty.body")}</p>
        </div>
      )}
      {overlayMode && !annotating && (
        <div className={`preview-overlay${overlayMode === "done" ? " done" : ""}`}>
          <span>{overlayMode === "editing" ? t("preview.aiEditing") : t("preview.editsDone")}</span>
        </div>
      )}
      {annotating && (
        <div className="annotation-overlay" ref={containerRef}>
          <div className="annotation-canvas-fill">
            <div style={{ position: "relative" }}>
              <canvas ref={canvasRef} style={{ display: "block" }} />
              <canvas
                ref={overlayRef}
                style={{ position: "absolute", top: 0, left: 0, cursor: floatingImage ? "move" : (tool === "text" ? "text" : "crosshair") }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
              {floatingImage && (
                <div className="annotation-floating-hint">{t("annotator.floatingHint")}</div>
              )}
              {tool === "select" && !floatingImage && !drawing && (
                <div className="annotation-floating-hint">{t("annotator.selectHint")}</div>
              )}
              {textInput && (
                <textarea
                  ref={textInputRef}
                  className="annotation-text-input"
                  style={{ left: textInput.x, top: textInput.y, color: strokeColor, fontSize, lineHeight: `${Math.round(fontSize * 1.3)}px` }}
                  value={textInput.value}
                  onChange={(e) => setTextInput(prev => ({ ...prev, value: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      commitText(textInput.value, textInput.x, textInput.y);
                      setTextInput(null);
                    }
                    if (e.key === "Escape") { setTextInput(null); }
                  }}
                  autoFocus
                />
              )}
            </div>
          </div>
          <div className="annotation-float-toolbar">
            {annotTools.map(tb => (
              <Tip key={tb.id} label={tb.label} side="bottom">
                <button className={`annotator-tool-btn${tool === tb.id ? " active" : ""}`} onClick={() => selectTool(tb.id)}>
                  <tb.icon size={16} />
                </button>
              </Tip>
            ))}
            <div className="annotator-divider" />
            <Tip label={t("annotator.undo")} side="bottom">
              <button className="annotator-tool-btn" onClick={undo}><Undo2 size={16} /></button>
            </Tip>
            <Tip label={t("annotator.pasteImage")} side="bottom">
              <button className="annotator-tool-btn" onClick={handlePasteFromClipboard}><ImageIcon size={16} /></button>
            </Tip>
            <div className="annotator-divider" />
            <div className="annotator-color-targets">
              <Tip label={t("annotator.stroke")} side="bottom">
                <button
                  className={`annotator-color-target${activeColorTarget === "stroke" ? " active" : ""}`}
                  onClick={() => setActiveColorTarget("stroke")}
                >
                  <span className="color-target-swatch color-target-stroke" style={{ borderColor: strokeColor }} />
                </button>
              </Tip>
              <Tip label={t("annotator.fill")} side="bottom">
                <button
                  className={`annotator-color-target${activeColorTarget === "fill" ? " active" : ""}`}
                  onClick={() => setActiveColorTarget("fill")}
                >
                  <span className="color-target-swatch color-target-fill" style={{ background: fillColor === "transparent" ? undefined : fillColor }} />
                </button>
              </Tip>
            </div>
            <div className="annotator-colors">
              {activeColorTarget === "fill" && (
                <button
                  className={`annotator-color-btn annotator-color-none${fillColor === "transparent" ? " active" : ""}`}
                  onClick={() => setFillColor("transparent")}
                  title={t("annotator.noFill")}
                />
              )}
              {COLORS.map(c => (
                <button key={c} className={`annotator-color-btn${activeColor === c ? " active" : ""}`} style={{ background: c }} onClick={() => setActiveColor(c)} />
              ))}
            </div>
            {tool === "text" && (
              <>
                <div className="annotator-divider" />
                <select className="annotator-fontsize" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}>
                  {FONT_SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
                </select>
              </>
            )}
          </div>
          <div className="annotation-float-actions">
            {hasImageAi && (
              <div className="annotation-ai-row">
                <Zap size={14} className="annotator-ai-icon" />
                <input
                  type="text"
                  className="annotator-ai-input"
                  placeholder={t("annotator.aiPlaceholder")}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !aiLoading) handleAiEdit(); }}
                  disabled={aiLoading}
                />
                <button className="btn-primary btn-sm" onClick={handleAiEdit} disabled={!aiPrompt.trim() || aiLoading}>
                  {aiLoading ? <Loader size={14} className="spin" /> : <Zap size={14} />}
                </button>
              </div>
            )}
            {aiError && <div className="annotator-ai-error">{aiError}</div>}
            <button className="btn-secondary btn-sm" onClick={exitAnnotation}><X size={14} /> {t("common.cancel")}</button>
            <button className="btn-primary btn-sm" onClick={handleAttach}><Send size={14} /> {t("annotator.attach")}</button>
          </div>
        </div>
      )}
      {!annotating && !overlayMode && (
        <Tip label={t("architect.openDesigner")} side="top">
          <button className={`architect-toggle-btn${useCasePulse || deploymentPulse || componentPulse || activityPulse || erPulse ? " usecase-pulse" : ""}`} onClick={() => { setArchitectMode(true); setUseCasePulse(false); setDeploymentPulse(false); setComponentPulse(false); setActivityPulse(false); setERPulse(false); }}>
            <Hexagon size={16} /> {t("architect.title")}
          </button>
        </Tip>
      )}
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────
function SidebarHeader() {
  const { state, setShowProjectsGallery, onboardingStep, advanceOnboarding, dismissOnboarding, serverConfig, authUser, authEnabled, t } = useContext(AppContext);
  const btnRef = useRef(null);
  const version = serverConfig?.appVersion;
  return (
    <div className="sidebar-header">
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <h1 style={{ margin: 0 }}>{t("sidebar.title")}</h1>
          {version && <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>v{version}</span>}
        </div>
        {authUser && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{authUser.displayName}</span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <Tip label={t("sidebar.projects")} side="bottom">
          <button ref={btnRef} className="btn-accent" onClick={() => { setShowProjectsGallery(true); advanceOnboarding("create-project"); }}>
            <LayoutGrid size={16} />
          </button>
        </Tip>
      </div>
      {onboardingStep === "create-project" && (
        <OnboardingTooltip targetRef={btnRef} text={t("onboarding.createProject")} side="bottom" onDismiss={dismissOnboarding} />
      )}
    </div>
  );
}

// ─── Message Components ──────────────────────────────────────
function UserMessage({ text, image, attachments, userName, ts }) {
  const imageAtts = attachments?.filter(a => a.type === "image") || [];
  const textAtts = attachments?.filter(a => a.type === "text") || [];
  // Fallback for old messages that only have `image`
  const hasLegacyImage = image && imageAtts.length === 0;
  const [modalSrc, setModalSrc] = useState(null);

  return (
    <div className="message-user-group">
      <MessageMeta name={userName || "User"} ts={ts} text={text} />
      <div className="message message-user">
        <User size={14} className="user-icon" />
        <div className="user-message-content">
          {hasLegacyImage && <img src={image} alt="Screenshot" className="user-message-image" onClick={() => setModalSrc(image)} />}
          {imageAtts.map((a, i) => (
            <img key={i} src={a.dataUrl} alt={a.name} className="user-message-image" onClick={() => setModalSrc(a.dataUrl)} />
          ))}
          {textAtts.length > 0 && (
            <div className="user-message-files">
              {textAtts.map((a, i) => (
                <span key={i} className="user-message-file-badge">
                  <FileText size={11} /> {a.name}
                </span>
              ))}
            </div>
          )}
          {text && <MarkdownChunk text={text} />}
        </div>
      </div>
      <Dialog.Root open={!!modalSrc} onOpenChange={(o) => { if (!o) setModalSrc(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content image-modal-content">
            <Dialog.Title style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>Image preview</Dialog.Title>
            {modalSrc && <img src={modalSrc} alt="" className="image-modal-img" />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

// Small hover-revealed button that copies a single message's raw markdown.
function CopyMessageButton({ text }) {
  const [state, setState] = useState("idle"); // idle | copied
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text || "");
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch { /* clipboard unavailable — ignore */ }
  };
  return (
    <button type="button" className="message-copy-btn" onClick={copy} aria-label="Copy as markdown" title="Copy as markdown">
      {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

// Muted meta row shown above a message: optional author name, the formatted
// datetime, and the copy button. Renders nothing if there's no content at all.
function MessageMeta({ name, ts, text, model, reasoning, cost }) {
  const when = formatMessageDateTime(ts);
  const modelLabel = model ? (reasoning ? `${model}:${reasoning}` : model) : null;
  const costLabel = typeof cost === "number" && Number.isFinite(cost) ? formatProjectCost(cost) : null;
  return (
    <div className="message-meta">
      {name && <span className="message-meta-name">{name}</span>}
      {when && <span className="message-meta-time">{when}</span>}
      {modelLabel && <span className="message-meta-model">{modelLabel}</span>}
      {costLabel && <span className="message-meta-cost">{costLabel}</span>}
      <CopyMessageButton text={text} />
    </div>
  );
}

function MarkdownChunk({ text, streaming }) {
  const ref = useRef(null);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || "")), [text]);

  useEffect(() => {
    if (streaming || !ref.current) return;
    ref.current.querySelectorAll("pre code").forEach(block => hljs.highlightElement(block));
  }, [streaming, html]);

  return <div ref={ref} className="markdown-chunk" dangerouslySetInnerHTML={{ __html: html }} />;
}

function MermaidDiagram({ src, onOpen }) {
  const ref = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    setError(null);
    const id = `md-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
    // Pre-validate via parse(): on invalid input it returns falsy without any
    // DOM side effects. render() with bad input would inject a global bomb
    // sprite into <body> that we can't reliably clean up afterwards.
    (async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        const ok = await mermaid.parse(src, { suppressErrors: true });
        if (cancelled) return;
        if (!ok) {
          setError("Mermaid render failed: invalid syntax");
          return;
        }
        const { svg } = await mermaid.render(id, src);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled) setError(`Mermaid render failed: ${err?.message || err}`);
      }
    })();
    return () => { cancelled = true; };
  }, [src]);

  if (error) {
    return <div className="chat-mermaid chat-mermaid-error">{error}{"\n\n"}{src}</div>;
  }
  return (
    <div
      ref={ref}
      className="chat-mermaid"
      onClick={() => onOpen && onOpen(src)}
    />
  );
}

function MermaidModal({ src, onClose }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const viewportRef = useRef(null);
  const innerRef = useRef(null);
  const panRef = useRef(null);
  const naturalSizeRef = useRef(null);

  useEffect(() => {
    if (!src) { setSvg(""); setError(null); return; }
    let cancelled = false;
    setError(null);
    setSvg("");
    setTransform({ scale: 1, x: 0, y: 0 });
    const id = `mm-modal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        const ok = await mermaid.parse(src, { suppressErrors: true });
        if (cancelled) return;
        if (!ok) {
          setError("Mermaid render failed: invalid syntax");
          return;
        }
        const { svg } = await mermaid.render(id, src);
        if (!cancelled) setSvg(svg);
      } catch (err) {
        if (!cancelled) setError(`Mermaid render failed: ${err?.message || err}`);
      }
    })();
    return () => { cancelled = true; };
  }, [src]);

  const computeFit = useCallback(() => {
    const vp = viewportRef.current;
    const ns = naturalSizeRef.current;
    if (!vp || !ns) return null;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const fit = Math.min(vw / ns.w, vh / ns.h, 1);
    const x = (vw - ns.w * fit) / 2;
    const y = (vh - ns.h * fit) / 2;
    return { scale: fit, x, y };
  }, []);

  // Capture the SVG's natural (unscaled) dimensions once per render so zoom can
  // resize the SVG element directly — keeping vector crispness at all zoom levels.
  useEffect(() => {
    if (!svg) { naturalSizeRef.current = null; return; }
    const inner = innerRef.current;
    const svgEl = inner && inner.querySelector("svg");
    if (!svgEl) return;
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    let w = vb && vb.width ? vb.width : 0;
    let h = vb && vb.height ? vb.height : 0;
    if (!w || !h) {
      svgEl.removeAttribute("width");
      svgEl.removeAttribute("height");
      const r = svgEl.getBoundingClientRect();
      w = r.width; h = r.height;
    }
    naturalSizeRef.current = (w && h) ? { w, h } : null;
  }, [svg]);

  // Apply zoom by resizing the SVG element itself so the browser re-rasterizes
  // it as vector graphics at the new size. The wrapper div only translates.
  useEffect(() => {
    const inner = innerRef.current;
    const svgEl = inner && inner.querySelector("svg");
    const ns = naturalSizeRef.current;
    if (!svgEl || !ns) return;
    svgEl.setAttribute("width", String(ns.w * transform.scale));
    svgEl.setAttribute("height", String(ns.h * transform.scale));
    svgEl.style.maxWidth = "none";
    svgEl.style.maxHeight = "none";
  }, [svg, transform.scale]);

  // Fit-to-view once the SVG renders so the diagram is centered and visible
  useEffect(() => {
    if (!svg) return;
    const fit = computeFit();
    if (fit) setTransform(fit);
    // computeFit intentionally not in deps — we only refit on new svg
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg]);

  // Wheel zoom — needs non-passive listener to preventDefault page scroll
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || error) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setTransform(t => {
        const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
        const newScale = Math.min(20, Math.max(0.1, t.scale * factor));
        const k = newScale / t.scale;
        return { scale: newScale, x: px - (px - t.x) * k, y: py - (py - t.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [error, svg]);

  const onPanDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    panRef.current = { startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
    const onMove = (ev) => {
      if (!panRef.current) return;
      setTransform(t => ({ ...t, x: panRef.current.origX + (ev.clientX - panRef.current.startX), y: panRef.current.origY + (ev.clientY - panRef.current.startY) }));
    };
    const onUp = () => {
      panRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const zoomBy = (factor) => {
    const el = viewportRef.current;
    const rect = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const px = rect.width / 2;
    const py = rect.height / 2;
    setTransform(t => {
      const newScale = Math.min(20, Math.max(0.1, t.scale * factor));
      const k = newScale / t.scale;
      return { scale: newScale, x: px - (px - t.x) * k, y: py - (py - t.y) * k };
    });
  };
  const resetView = () => {
    const fit = computeFit();
    setTransform(fit || { scale: 1, x: 0, y: 0 });
  };

  return (
    <Dialog.Root open={!!src} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content chat-mermaid-modal">
          <Dialog.Title className="modal-title">Diagram</Dialog.Title>
          {error
            ? <div className="chat-mermaid-modal-error">{error}{"\n\n"}{src}</div>
            : (
              <div
                ref={viewportRef}
                className="chat-mermaid-modal-svg"
                onMouseDown={onPanDown}
              >
                <div
                  ref={innerRef}
                  className="chat-mermaid-modal-svg-inner"
                  style={{ transform: `translate(${transform.x}px, ${transform.y}px)` }}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                <div className="chat-mermaid-modal-zoom-controls" onMouseDown={e => e.stopPropagation()}>
                  <button type="button" className="chat-mermaid-modal-zoom-btn" onClick={() => zoomBy(1.2)} title="Zoom in"><ZoomIn size={16} /></button>
                  <button type="button" className="chat-mermaid-modal-zoom-btn" onClick={() => zoomBy(1 / 1.2)} title="Zoom out"><ZoomOut size={16} /></button>
                  <button type="button" className="chat-mermaid-modal-zoom-btn" onClick={resetView} title="Reset view"><RotateCcw size={16} /></button>
                </div>
              </div>
            )}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AssistantMessage({ text, streaming, isError, iconAsTrigger, triggerOpen, ts, model, reasoning, costUsd, withMeta }) {
  const { t } = useContext(AppContext);
  const [modalSrc, setModalSrc] = useState(null);
  const cleaned = useMemo(() => stripChatArtifacts(text) || "", [text]);
  const parts = useMemo(() => splitMarkdownByMermaid(cleaned), [cleaned]);
  const verbs = useMemo(() => t("msg.spinnerVerbs"), [t]);
  const spinnerVerb = useSpinnerVerb(streaming && !text, Array.isArray(verbs) ? verbs : null);

  if (!text && !streaming) return null;

  const IconEl = isError
    ? <AlertTriangle size={16} className="bot-icon" style={{ color: "var(--error)" }} />
    : <Bot size={16} className="bot-icon" />;
  const iconNode = iconAsTrigger ? (
    <Collapsible.Trigger asChild>
      <button type="button" className="bot-icon-trigger" aria-label={t("msg.toggleToolHistory")} aria-expanded={!!triggerOpen}>
        {IconEl}
      </button>
    </Collapsible.Trigger>
  ) : IconEl;

  if (streaming && !text) {
    return (
      <div className="message-assistant-wrapper">
        {iconNode}
        <div className="message message-assistant spinner-verb">
          <span>{spinnerVerb}</span><span className="spinner-verb-cursor">|</span>
        </div>
      </div>
    );
  }

  const classes = `message message-assistant${streaming ? " streaming-cursor" : ""}${isError ? " message-error" : ""}`;
  const lastIdx = parts.length - 1;
  // Datetime + copy only on the finished, standalone assistant message in the
  // main list (withMeta) — not on streaming text or the in-group/preview ones.
  const showMeta = withMeta && !streaming && !!cleaned;

  return (
    <div className="message-assistant-wrapper">
      {iconNode}
      <div className={classes}>
        {showMeta && <MessageMeta ts={ts} text={cleaned} model={model} reasoning={reasoning} cost={costUsd} />}
        {isError
          // Error text is a raw runtime string (often a Windows file path).
          // Rendering it as Markdown would swallow backslashes before escapable
          // chars (e.g. "\.vca-skills" -> ".vca-skills"), so show it verbatim.
          ? <div className="markdown-chunk" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{cleaned}</div>
          : parts.map((p, i) =>
              p.type === "mermaid"
                ? <MermaidDiagram key={`m-${i}`} src={p.src} onOpen={setModalSrc} />
                : <MarkdownChunk key={`t-${i}`} text={p.text} streaming={streaming && i === lastIdx} />
            )}
      </div>
      <MermaidModal src={modalSrc} onClose={() => setModalSrc(null)} />
    </div>
  );
}

function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false);
  const { t } = useContext(AppContext);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="inline-collapse-trigger">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        <span className="inline-collapse-label">{t("msg.thinking")}</span>
      </Collapsible.Trigger>
      <Collapsible.Content className="inline-collapse-content">
        {text}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function CompactionBlock({ error }) {
  const { t } = useContext(AppContext);
  return (
    <div className="inline-collapse-trigger" style={{ cursor: "default" }}>
      <RotateCcw size={12} className={error ? "" : "inline-collapse-status-icon"} style={error ? { color: "var(--error)" } : { color: "var(--success)" }} />
      {/* Raw provider error (e.g. "model produced invalid content …") kept in the
          tooltip for debugging; the label stays user-friendly and actionable. */}
      <span className="inline-collapse-label" style={error ? { color: "var(--error)" } : {}} title={error || undefined}>
        {error ? t("msg.compactionFailedFinal") : t("msg.compactionDone")}
      </span>
    </div>
  );
}

const DIFF_PREVIEW_LINES = 8;

function getDiffLines(toolName, args) {
  const name = (toolName || "").toLowerCase();
  const filePath = args?.file_path || args?.path || "";
  if (name === "edit" || name === "multiedit") {
    const lines = [];
    if (Array.isArray(args?.edits)) {
      for (const edit of args.edits) {
        if (typeof edit?.oldText === "string") {
          for (const l of edit.oldText.split("\n")) lines.push({ type: "removed", text: l });
        }
        if (typeof edit?.newText === "string") {
          for (const l of edit.newText.split("\n")) lines.push({ type: "added", text: l });
        }
      }
    } else {
      const oldStr = args?.old_string ?? args?.oldText;
      const newStr = args?.new_string ?? args?.newText;
      if (oldStr != null) for (const l of String(oldStr).split("\n")) lines.push({ type: "removed", text: l });
      if (newStr != null) for (const l of String(newStr).split("\n")) lines.push({ type: "added", text: l });
    }
    if (lines.length > 0) return { filePath, lines };
  }
  if (name === "write" && (args?.content != null || filePath)) {
    const added = (args.content || "").split("\n").map(l => ({ type: "added", text: l }));
    return { filePath, lines: added };
  }
  return null;
}

function DiffLines({ lines }) {
  return lines.map((l, i) => (
    <div key={i} className={`diff-line diff-${l.type}`}>{l.type === "removed" ? "-" : "+"} {l.text}</div>
  ));
}

function DiffModal({ open, onOpenChange, filePath, lines }) {
  const { t } = useContext(AppContext);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content diff-modal-content">
          <Dialog.Title className="modal-title">
            <FileText size={18} className="title-icon" />
            {filePath ? filePath.split("/").pop() : t("diff.title")}
          </Dialog.Title>
          <div className="diff-block diff-block-full">
            {filePath && <div className="diff-file-path">{filePath}</div>}
            <div className="diff-block-scroll">
              <DiffLines lines={lines} />
            </div>
          </div>
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary"><X size={14} /> {t("common.close")}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SkillInvocationBlock({ skillName, status }) {
  const { t } = useContext(AppContext);
  const StatusIcon = status === "error" ? CircleX : status === "completed" ? CircleCheck : Terminal;
  return (
    <div className={`inline-collapse-trigger tool-status-${status}`} style={{ cursor: "default" }}>
      <span className="inline-collapse-chevron-spacer" />
      <StatusIcon size={12} className="inline-collapse-status-icon" />
      <span className="inline-collapse-label">{t("msg.skillLoading")}</span>
      <span className="inline-collapse-tool-name">{skillName}</span>
    </div>
  );
}

function ToolCallBlock({ toolName, args, status, output }) {
  const [open, setOpen] = useState(false);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const outputEndRef = useRef(null);
  const { t } = useContext(AppContext);
  const StatusIcon = status === "error" ? CircleX : status === "completed" ? CircleCheck : Terminal;
  const statusLabel = status === "completed" ? t("msg.toolUsed") : status === "error" ? t("msg.toolFailed") : t("msg.toolUsing");
  const name = (toolName || "").toLowerCase();
  const filePath = args?.file_path || args?.path || "";
  const shortPath = filePath ? filePath.split("/").pop() : "";
  const triggerDetail = (name === "edit" || name === "multiedit" || name === "write" || name === "read") && shortPath
    ? `${toolName} ${shortPath}`
    : name === "wait" && args?.reason
      ? `wait ${args.seconds ?? "?"}s — ${args.reason}`
      : toolName;

  const diff = useMemo(() => getDiffLines(toolName, args), [toolName, args]);
  const isTruncated = diff && diff.lines.length > DIFF_PREVIEW_LINES;

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (outputEndRef.current && status === "running") {
      outputEndRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [output, status]);

  return (
    <>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className={`inline-collapse-trigger tool-status-${status}`}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <StatusIcon size={12} className="inline-collapse-status-icon" />
          <span className="inline-collapse-label">{statusLabel}</span>
          <span className="inline-collapse-tool-name">{triggerDetail}</span>
        </Collapsible.Trigger>
        <Collapsible.Content className="inline-collapse-content">
          {diff ? (
            <div className="diff-block">
              {diff.filePath && <div className="diff-file-path">{diff.filePath}</div>}
              <DiffLines lines={diff.lines.slice(0, DIFF_PREVIEW_LINES)} />
              {isTruncated && (
                <button className="diff-expand-btn" onClick={(e) => { e.stopPropagation(); setShowFullDiff(true); }}>
                  {t("msg.showAll", { count: diff.lines.length })}
                </button>
              )}
            </div>
          ) : (
            (() => { const s = getToolArgsStr(args); return s ? <div className="inline-collapse-args">{s}</div> : null; })()
          )}
          {output && (
            <div className="tool-output-block">
              <pre className="tool-output-pre">{output}</pre>
              <div ref={outputEndRef} />
            </div>
          )}
        </Collapsible.Content>
      </Collapsible.Root>
      {showFullDiff && diff && (
        <DiffModal open={true} onOpenChange={setShowFullDiff} filePath={diff.filePath} lines={diff.lines} />
      )}
    </>
  );
}

function renderRunChild(msg, key) {
  if (msg.type === "thinking") return <ThinkingBlock key={key} text={msg.text} />;
  if (msg.type === "assistant") return <AssistantMessage key={key} text={msg.text} streaming={msg.streaming} isError={msg.isError} />;
  if (msg.isSkill) return <SkillInvocationBlock key={key} skillName={msg.skillName} status={msg.status} />;
  return <ToolCallBlock key={key} toolName={msg.toolName} args={msg.args} status={msg.status} output={msg.output} />;
}

function ToolRunGroup({ messages, isLive }) {
  const [open, setOpen] = useState(false);
  const { t } = useContext(AppContext);
  const toolCount = messages.reduce((n, m) => n + (m.type === "tool" ? 1 : 0), 0);
  const label = toolCount === 0 ? t("msg.thinking") : t("msg.toolRunSummary", { count: toolCount });

  // The "live" branch is owned by LiveSpinnerGroup (the spinner's bot icon
  // acts as the trigger). This only handles the rare transient state where
  // a live run exists with no following streaming assistant yet.
  if (isLive) return null;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="inline-collapse-trigger tool-run-group-trigger" aria-label={label}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="inline-collapse-label">{label}</span>
      </Collapsible.Trigger>
      <Collapsible.Content className="inline-collapse-content tool-run-group-content">
        {messages.map((msg, i) => renderRunChild(msg, i))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function LiveSpinnerGroup({ historyMessages, spinnerMsg }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Content className="inline-collapse-content tool-run-group-content live-spinner-history">
        {historyMessages.map((msg, i) => renderRunChild(msg, i))}
      </Collapsible.Content>
      <AssistantMessage
        text={spinnerMsg.text}
        streaming={spinnerMsg.streaming}
        isError={spinnerMsg.isError}
        iconAsTrigger
        triggerOpen={open}
      />
    </Collapsible.Root>
  );
}

function MultipleChoiceQuestion({ toolCallId, question, options, answered, selectedAnswer }) {
  const { state, dispatch, userId } = useContext(AppContext);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");

  const handleSelect = async (answer) => {
    dispatch({ type: "ANSWER_QUESTION", toolCallId, answer });
    try {
      await fetch(`/api/projects/${state.currentProjectId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, chatId: state.currentChatId, toolCallId, answer }),
      });
    } catch (err) {
      console.error("Failed to send answer:", err);
    }
  };

  const handleCustomSubmit = () => {
    if (customText.trim()) handleSelect(customText.trim());
  };

  return (
    <div className="message-question">
      <div className="question-header">
        <HelpCircle size={16} />
        <span className="question-text">{question}</span>
      </div>
      <div className="question-options">
        {options.map((opt, i) => (
          <button
            key={i}
            className={`question-option${answered && selectedAnswer === opt.label ? " selected" : ""}`}
            disabled={answered}
            onClick={() => handleSelect(opt.label)}
          >
            {answered && selectedAnswer === opt.label && <Check size={14} />}
            <span className="question-option-label">{opt.label}</span>
            {opt.description && <span className="question-option-desc">{opt.description}</span>}
          </button>
        ))}
        {!answered && !customMode && (
          <button className="question-option question-option-custom" onClick={() => setCustomMode(true)}>
            <PenLine size={14} />
            <span className="question-option-label">Other...</span>
          </button>
        )}
        {!answered && customMode && (
          <div className="question-custom-input">
            <input
              type="text"
              placeholder="Type your answer..."
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCustomSubmit(); }}
              autoFocus
            />
            <button className="question-custom-send" onClick={handleCustomSubmit} disabled={!customText.trim()}>
              <Send size={14} />
            </button>
          </div>
        )}
        {answered && selectedAnswer && !options.some(o => o.label === selectedAnswer) && (
          <div className="question-option selected">
            <Check size={14} />
            <span className="question-option-label">{selectedAnswer}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function groupMessagesForRender(messages) {
  // For each user turn, collapse the agent's tool calls / thinking into runs,
  // but keep EVERY assistant message with text visible standalone — the
  // agent's messages to the user must stay permanently in the chat. The LAST
  // assistant stays visible even without text so the live spinner bubble
  // renders. User / question / compaction messages act as turn boundaries and
  // always render standalone.
  const isBoundary = (m) => m.type === "user" || m.type === "question" || m.type === "compaction";
  const items = [];
  let i = 0;
  while (i < messages.length) {
    if (isBoundary(messages[i])) {
      items.push({ kind: "msg", msg: messages[i], idx: i });
      i++;
      continue;
    }
    let j = i;
    while (j < messages.length && !isBoundary(messages[j])) j++;
    const zone = messages.slice(i, j);

    let lastAsst = -1;
    for (let k = zone.length - 1; k >= 0; k--) {
      if (zone[k].type === "assistant") { lastAsst = k; break; }
    }

    let runStart = -1;
    const flushRun = (endExclusive) => {
      if (runStart >= 0) {
        items.push({ kind: "toolRun", messages: zone.slice(runStart, endExclusive), startIdx: i + runStart });
        runStart = -1;
      }
    };
    for (let k = 0; k < zone.length; k++) {
      const visible = (zone[k].type === "assistant" && zone[k].text) || (k === lastAsst);
      if (visible) {
        flushRun(k);
        items.push({ kind: "msg", msg: zone[k], idx: i + k });
      } else if (runStart < 0) {
        runStart = k;
      }
    }
    flushRun(zone.length);

    i = j;
  }
  return items;
}

// Pair a tool-run with an immediately-following streaming-assistant message
// so the spinner's bot icon can act as the collapse trigger for that run.
function combineLiveSpinnerWithHistory(items) {
  const out = [];
  let i = 0;
  while (i < items.length) {
    const cur = items[i];
    const next = items[i + 1];
    if (cur.kind === "toolRun" && next && next.kind === "msg"
        && next.msg.type === "assistant" && next.msg.streaming) {
      out.push({
        kind: "liveSpinnerGroup",
        historyMessages: cur.messages,
        spinnerMsg: next.msg,
        startIdx: cur.startIdx,
      });
      i += 2;
    } else {
      out.push(cur);
      i++;
    }
  }
  return out;
}

function MessageList({ height }) {
  const { state, t } = useContext(AppContext);
  const viewportRef = useRef(null);        // Radix viewport = the scroll container
  const stickToBottomRef = useRef(true);   // follow live output? (ref = no re-render)
  const prevLastRef = useRef(null);        // detect a freshly-sent user message
  const [showJumpBtn, setShowJumpBtn] = useState(false);
  const NEAR_BOTTOM_PX = 120;              // within this many px counts as "at bottom"

  // Track whether the user is parked near the bottom. Self-correcting: scrolling
  // back down re-arms follow, scrolling up disarms it — no need to tell apart
  // programmatic from user scrolls.
  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickToBottomRef.current = nearBottom;
    setShowJumpBtn(prev => (prev === !nearBottom ? prev : !nearBottom));
  }, []);

  // Follow new content only while the user is at the bottom; always snap to a
  // message the user just sent. useLayoutEffect scrolls before paint (no flicker).
  useLayoutEffect(() => {
    const last = state.messages[state.messages.length - 1];
    const userJustSent = last && last.type === "user" && prevLastRef.current !== last;
    prevLastRef.current = last;
    if (userJustSent) stickToBottomRef.current = true;

    if (stickToBottomRef.current) {
      const el = viewportRef.current;
      if (el) el.scrollTop = el.scrollHeight; // instant: tracks the stream crisply
      setShowJumpBtn(false);
    }
  }, [state.messages]);

  const jumpToLatest = useCallback(() => {
    const el = viewportRef.current;
    stickToBottomRef.current = true;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowJumpBtn(false);
  }, []);

  const items = useMemo(() => combineLiveSpinnerWithHistory(groupMessagesForRender(state.messages)), [state.messages]);

  return (
    <div className="messages-container" style={height ? { height, flex: "none" } : undefined}>
      <ScrollArea.Root style={{ height: "100%" }}>
        <ScrollArea.Viewport ref={viewportRef} onScroll={handleScroll} style={{ height: "100%" }}>
          <div className="messages-list">
            {items.map((item, i) => {
              if (item.kind === "liveSpinnerGroup") {
                return <LiveSpinnerGroup key={`live-${item.startIdx}`} historyMessages={item.historyMessages} spinnerMsg={item.spinnerMsg} />;
              }
              if (item.kind === "toolRun") {
                const hasRunning = item.messages.some(m => m.type === "tool" && m.status === "running");
                const next = items[i + 1];
                const nextIsStreamingAssistant = next && next.kind === "msg" && next.msg.type === "assistant" && next.msg.streaming;
                const isLive = hasRunning || nextIsStreamingAssistant || (state.isStreaming && i === items.length - 1);
                return <ToolRunGroup key={`run-${item.startIdx}`} messages={item.messages} isLive={isLive} />;
              }
              const msg = item.msg;
              const key = item.idx;
              switch (msg.type) {
                case "user": return <UserMessage key={key} text={msg.text} image={msg.image} attachments={msg.attachments} userName={msg.author || "User"} ts={msg.ts} />;
                case "assistant": return <AssistantMessage key={key} text={msg.text} streaming={msg.streaming} isError={msg.isError} ts={msg.ts} model={msg.model} reasoning={msg.reasoning} costUsd={msg.costUsd} withMeta />;
                case "compaction": return <CompactionBlock key={key} error={msg.error} />;
                case "question": return <MultipleChoiceQuestion key={key} toolCallId={msg.toolCallId} question={msg.question} options={msg.options} answered={msg.answered} selectedAnswer={msg.selectedAnswer} />;
                default: return null;
              }
            })}
          </div>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="scrollbar">
          <ScrollArea.Thumb className="scrollbar-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
      {showJumpBtn && (
        <button type="button" className="jump-to-latest" aria-label={t("chat.jumpToLatest")} onClick={jumpToLatest}>
          <span aria-hidden="true">↓</span> {t("chat.jumpToLatest")}
        </button>
      )}
    </div>
  );
}

function InputArea({ height, attachments, addFile, clearAttachments }) {
  const { state, dispatch, userId, handleSend, handleAbort, handleCompact, refreshPreview, onboardingStep, advanceOnboarding, dismissOnboarding, contextUsage, tokenStats, projectCost, t, lang } = useContext(AppContext);
  const [text, setText] = useState("");
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  // ── "@" userdata mention picker ──
  // Typing "@" (at the start of a word) opens a browsable overlay of the
  // project's userdata/ tree; picking an entry inserts its workspace-relative
  // path (userdata/...) into the prompt. Characters typed after the "@"
  // filter the current folder; navigation happens inside the overlay.
  const [mention, setMention] = useState(null); // { anchor, rect } — index of "@", textarea rect
  const [mentionPath, setMentionPath] = useState("");
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionItems, setMentionItems] = useState(null); // null = loading
  const [mentionIndex, setMentionIndex] = useState(0);

  const closeMention = () => { setMention(null); setMentionPath(""); setMentionQuery(""); setMentionItems(null); setMentionIndex(0); };

  useEffect(() => {
    if (!mention || !state.currentProjectId) return;
    let cancelled = false;
    setMentionItems(null);
    api(`/projects/${state.currentProjectId}/userdata?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(mentionPath)}`)
      .then((items) => { if (!cancelled) { setMentionItems(Array.isArray(items) ? items : []); setMentionIndex(0); } })
      .catch(() => { if (!cancelled) setMentionItems([]); });
    return () => { cancelled = true; };
  }, [mention?.anchor, mentionPath, state.currentProjectId]);

  // Rows the keyboard can walk: ".." first (when inside a subfolder), then
  // the current folder's entries filtered by whatever was typed after "@".
  const mentionRows = useMemo(() => {
    if (!mention) return [];
    const q = mentionQuery.toLowerCase();
    const entries = (mentionItems || []).filter(i => !q || i.name.toLowerCase().includes(q));
    return [...(mentionPath ? [{ type: "up", name: ".." }] : []), ...entries];
  }, [mention, mentionItems, mentionQuery, mentionPath]);

  // Drop the filter characters (anchor+1 … cursor) when navigating folders,
  // so a filter typed at one level doesn't stick at the next.
  const clearMentionQuery = () => {
    if (!mention) return;
    const el = textareaRef.current;
    const cursor = el ? el.selectionStart : text.length;
    const next = text.slice(0, mention.anchor + 1) + text.slice(cursor);
    setText(next);
    setMentionQuery("");
    requestAnimationFrame(() => {
      if (el) { el.focus(); el.setSelectionRange(mention.anchor + 1, mention.anchor + 1); }
    });
  };

  const activateMentionRow = (row) => {
    if (row.type === "up") {
      setMentionPath(mentionPath.split("/").slice(0, -1).join("/"));
      clearMentionQuery();
    } else if (row.type === "directory") {
      setMentionPath(mentionPath ? `${mentionPath}/${row.name}` : row.name);
      clearMentionQuery();
    } else {
      insertMention(mentionPath ? `${mentionPath}/${row.name}` : row.name);
    }
  };

  const insertMention = (relPath) => {
    const el = textareaRef.current;
    const cursor = el ? el.selectionStart : text.length;
    const before = text.slice(0, mention.anchor);
    const inserted = `userdata/${relPath}`;
    const next = `${before}${inserted} ${text.slice(cursor)}`;
    setText(next);
    closeMention();
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = before.length + inserted.length + 1;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const onTextChange = (e) => {
    const value = e.target.value;
    const cursor = e.target.selectionStart;
    setText(value);
    if (mention) {
      // Still a valid "@word" under the cursor? Otherwise dismiss.
      if (value[mention.anchor] !== "@" || cursor <= mention.anchor) {
        closeMention();
        return;
      }
      const q = value.slice(mention.anchor + 1, cursor);
      if (/[\s@]/.test(q)) { closeMention(); return; }
      setMentionQuery(q);
      setMentionIndex(0);
      return;
    }
    // Open when "@" was just typed at a word start (start of text or after
    // whitespace) — only inside a project, where userdata exists.
    if (
      state.currentProjectId &&
      cursor > 0 && value[cursor - 1] === "@" &&
      (cursor === 1 || /\s/.test(value[cursor - 2]))
    ) {
      const rect = textareaRef.current?.getBoundingClientRect();
      setMention({ anchor: cursor - 1, rect });
      setMentionPath("");
      setMentionQuery("");
      setMentionIndex(0);
    }
  };

  // ── Speech-to-Text (Web Speech API) ──
  const sttSupported = typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const [sttActive, setSttActive] = useState(false);
  const sttRef = useRef(null);
  const langToLocale = { en: "en-US", de: "de-DE", fr: "fr-FR", it: "it-IT", pl: "pl-PL" };

  const toggleSTT = useCallback(() => {
    if (sttActive) {
      sttRef.current?.stop();
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.lang = langToLocale[lang] || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      let transcript = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) transcript += e.results[i][0].transcript;
      }
      if (transcript) {
        setText(prev => prev ? prev + " " + transcript : transcript);
      }
    };
    recognition.onend = () => setSttActive(false);
    recognition.onerror = () => setSttActive(false);
    sttRef.current = recognition;
    recognition.start();
    setSttActive(true);
  }, [sttActive, lang]);

  const handleFileUpload = (e) => {
    Array.from(e.target.files || []).forEach(addFile);
    e.target.value = "";
  };

  const onSend = () => {
    if (!text.trim() && attachments.length === 0) return;
    closeMention();
    handleSend(text.trim(), attachments);
    setText("");
    clearAttachments();
    advanceOnboarding("send-prompt");
  };

  const onKeyDown = (e) => {
    // While the "@" picker is open it owns Enter/arrows/Escape — Enter must
    // activate the highlighted row, not send the prompt.
    if (mention) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (mentionRows.length > 0) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setMentionIndex((prev) => (prev + delta + mentionRows.length) % mentionRows.length);
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const row = mentionRows[mentionIndex];
        if (row) activateMentionRow(row);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    let handled = false;
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) { addFile(file); handled = true; }
      }
    }
    if (handled) e.preventDefault();
  };

  return (
    <div className="input-area" style={height ? { height, display: "flex", flexDirection: "column" } : undefined}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={onTextChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => { /* mousedown on the overlay is prevented, so a blur means focus truly left */ closeMention(); }}
        placeholder={t("input.placeholder")}
        rows={3}
        style={height ? { flex: 1, resize: "none", minHeight: 0, overflow: "auto" } : undefined}
      />
      {mention && mention.rect && (
        <div
          className="mention-overlay"
          style={{
            left: mention.rect.left,
            width: Math.min(mention.rect.width, 440),
            bottom: window.innerHeight - mention.rect.top + 6,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="mention-breadcrumb">
            <FolderOpen size={12} /> userdata{mentionPath ? `/${mentionPath}` : ""}
          </div>
          {mentionItems === null ? (
            <div className="mention-empty">…</div>
          ) : mentionRows.length === 0 ? (
            <div className="mention-empty">{t("input.mentionEmpty")}</div>
          ) : (
            <div className="mention-list">
              {mentionRows.map((row, i) => (
                <div
                  key={`${row.type}-${row.name}`}
                  className={`mention-row${i === mentionIndex ? " active" : ""}`}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => activateMentionRow(row)}
                >
                  {row.type === "file" ? <FileText size={13} /> : <FolderOpen size={13} />}
                  <span className="mention-name">{row.name}{row.type === "directory" ? "/" : ""}</span>
                  {row.type === "directory" && (
                    <button
                      type="button"
                      className="mention-insert-btn"
                      title={t("input.mentionInsertFolder")}
                      onClick={(e) => {
                        e.stopPropagation();
                        insertMention(mentionPath ? `${mentionPath}/${row.name}` : row.name);
                      }}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {onboardingStep === "send-prompt" && state.currentProjectId && (
        <OnboardingTooltip targetRef={textareaRef} text={t("onboarding.sendPrompt")} side="top" onDismiss={dismissOnboarding} />
      )}
      <div className="context-usage-row">
        <Tip label={t("chat.compact")}>
          <button className="context-compact-btn" onClick={handleCompact} disabled={state.isStreaming}>
            <Minimize2 size={10} />
          </button>
        </Tip>
        <Tip label={contextUsage && contextUsage.percent != null
          ? `${t("input.context")}: ${Math.round(contextUsage.percent)}% (${Math.round((contextUsage.tokens || 0) / 1000)}k / ${Math.round(contextUsage.contextWindow / 1000)}k)`
          : t("input.context")
        }>
          <div className="context-usage-bar">
            {contextUsage && contextUsage.percent != null && (
              <div
                className={`context-usage-fill${contextUsage.percent > 80 ? " warning" : ""}${contextUsage.percent > 95 ? " critical" : ""}`}
                style={{ width: `${Math.min(contextUsage.percent, 100)}%` }}
              />
            )}
          </div>
        </Tip>
        {tokenStats && (
          <Tip label={tokenStats.live
            ? `~${tokenStats.outputTokens} tok · ${(tokenStats.durationMs / 1000).toFixed(1)}s`
            : `In: ${tokenStats.inputTokens.toLocaleString()} tok (${tokenStats.inputPerSec} tok/s) · Out: ${tokenStats.outputTokens.toLocaleString()} tok (${tokenStats.outputPerSec} tok/s) · ${(tokenStats.durationMs / 1000).toFixed(1)}s`
          }>
            <span className="token-stats">
              {tokenStats.live
                ? `↓${tokenStats.outputPerSec} tok/s`
                : `↑${tokenStats.inputPerSec} ↓${tokenStats.outputPerSec} tok/s`
              }
            </span>
          </Tip>
        )}
        {formatProjectCost(projectCost?.totalUsd) && (
          <Tip label={`${t("projectCost.tooltip")}${projectCost.tokens
            ? ` · ${t("projectCost.tokens", {
                input: formatTokenCount(projectCost.tokens.input) || 0,
                output: formatTokenCount(projectCost.tokens.output) || 0,
                cacheRead: formatTokenCount(projectCost.tokens.cacheRead) || 0,
                cacheWrite: formatTokenCount(projectCost.tokens.cacheWrite) || 0,
              })}`
            : ""}`}>
            <span className="token-stats project-cost-live">{formatProjectCost(projectCost.totalUsd)}</span>
          </Tip>
        )}
      </div>
      <div className="input-actions">
        {!state.isStreaming && sttSupported && (
          <Tip label={sttActive ? t("input.sttStop") : t("input.sttStart")}>
            <button
              className={`btn-screenshot${sttActive ? " stt-active" : ""}`}
              onClick={toggleSTT}
              disabled={!state.currentProjectId}
            >
              {sttActive ? <MicOff size={13} /> : <Mic size={13} />}
            </button>
          </Tip>
        )}
        {!state.isStreaming && (
          <Tip label={t("input.upload")}>
            <button
              className="btn-screenshot"
              onClick={() => fileInputRef.current?.click()}
              disabled={!state.currentProjectId}
            >
              <Paperclip size={13} />
            </button>
          </Tip>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.html,.css,.xml,.yaml,.yml,.log,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.sh,image/*"
          onChange={handleFileUpload}
          style={{ display: "none" }}
        />
        {state.isStreaming ? (
          <Tip label={t("input.stopLabel")}>
            <button className="btn-abort" onClick={handleAbort}>
              <Square size={13} /> {t("input.stop")}
            </button>
          </Tip>
        ) : (() => {
          const otherChatBusy = !!(state.projectActiveChatId && state.projectActiveChatId !== state.currentChatId);
          const otherChatName = otherChatBusy
            ? (state.chats.find(c => c.id === state.projectActiveChatId)?.name ?? state.projectActiveChatId)
            : null;
          return (
            <Tip label={otherChatBusy ? `Another chat (${otherChatName}) is running. Wait or abort it first.` : t("input.sendLabel")}>
              <button
                className="btn-send"
                onClick={onSend}
                disabled={(!text.trim() && attachments.length === 0) || !state.currentProjectId || otherChatBusy}
              >
                <Send size={13} /> {t("input.send")}
              </button>
            </Tip>
          );
        })()}
      </div>
    </div>
  );
}

function ChatSkillsModal({ open, onOpenChange }) {
  const { state, userId, t } = useContext(AppContext);
  const [skills, setSkills] = useState([]);
  const [activeSkills, setActiveSkillsLocal] = useState([]);
  const [skillStatus, setSkillStatus] = useState({});

  const load = async () => {
    try { setSkills(await api(`/users/${userId}/skills?projectId=${state.currentProjectId}`)); } catch { setSkills([]); }
    try { setActiveSkillsLocal(await api(`/projects/${state.currentProjectId}/active-skills?userId=${userId}`)); } catch { setActiveSkillsLocal([]); }
    try { setSkillStatus(await api(`/projects/${state.currentProjectId}/skills-status?userId=${userId}`)); } catch { setSkillStatus({}); }
  };

  useEffect(() => { if (open) load(); }, [open]);

  const toggleSkill = async (key) => {
    const newActive = activeSkills.includes(key)
      ? activeSkills.filter(n => n !== key)
      : [...activeSkills, key];
    setActiveSkillsLocal(newActive);
    await api(`/projects/${state.currentProjectId}/active-skills`, {
      method: "PUT",
      body: JSON.stringify({ userId, skills: newActive }),
    });
    try { setSkillStatus(await api(`/projects/${state.currentProjectId}/skills-status?userId=${userId}`)); }
    catch {}
  };

  const systemSkills = skills.filter(s => (s.kind ? s.kind === "system" : s.system));
  const projectSkills = skills.filter(s => s.kind === "project");
  const userSkills = skills.filter(s => (s.kind ? s.kind === "user" : !s.system));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content modal-sticky">
          <Dialog.Title className="modal-title">
            <Zap size={20} className="title-icon" />
            {t("chatSkills.title")}
          </Dialog.Title>
          <div className="modal-body">

          {systemSkills.length > 0 && (
            <>
              <div className="skills-section-label">{t("chatSkills.system")}</div>
              {systemSkills.map(s => (
                <label key={s.name} className="skills-modal-item system">
                  <input type="checkbox" checked disabled />
                  <span>{s.name}</span>
                  <span className="skill-badge system">{t("chatSkills.alwaysActive")}</span>
                </label>
              ))}
            </>
          )}

          {projectSkills.length > 0 && (
            <>
              <div className="skills-section-label" style={{ marginTop: 12 }}>{t("chatSkills.project")}</div>
              {projectSkills.map(s => {
                const dirKey = s.dirName || s.name;
                const status = activeSkills.includes(s.name) ? skillStatus[dirKey] : null;
                return (
                  <label key={s.name} className="skills-modal-item">
                    <input type="checkbox" checked={activeSkills.includes(s.name)} onChange={() => toggleSkill(s.name)} />
                    <span>{s.name}</span>
                    <span className="skill-badge project">{t("skills.projectBadge")}</span>
                    {status && status.loaded && (
                      <span className="skill-badge status-loaded" title={t("skills.statusLoadedTitle")}>{t("skills.statusLoaded")}</span>
                    )}
                    {status && !status.loaded && (
                      <span className="skill-badge status-failed" title={status.errors.join("\n") || t("skills.statusFailedTitle")}>{t("skills.statusFailed")}</span>
                    )}
                    {s.description && <span className="skills-modal-desc">{s.description}</span>}
                  </label>
                );
              })}
            </>
          )}

          {userSkills.length > 0 && (
            <>
              <div className="skills-section-label" style={{ marginTop: 12 }}>{t("chatSkills.user")}</div>
              {userSkills.map(s => {
                const dirKey = s.dirName || s.name;
                const status = activeSkills.includes(s.name) ? skillStatus[dirKey] : null;
                return (
                  <label key={s.name} className="skills-modal-item">
                    <input type="checkbox" checked={activeSkills.includes(s.name)} onChange={() => toggleSkill(s.name)} />
                    <span>{s.name}</span>
                    {status && status.loaded && (
                      <span className="skill-badge status-loaded" title={t("skills.statusLoadedTitle")}>{t("skills.statusLoaded")}</span>
                    )}
                    {status && !status.loaded && (
                      <span className="skill-badge status-failed" title={status.errors.join("\n") || t("skills.statusFailedTitle")}>{t("skills.statusFailed")}</span>
                    )}
                    {s.description && <span className="skills-modal-desc">{s.description}</span>}
                  </label>
                );
              })}
            </>
          )}

          {skills.length === 0 && (
            <div className="skills-empty">{t("chatSkills.empty")}</div>
          )}

          </div>
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary">{t("common.close")}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── User Data File Manager Dialog ──────────────────────────

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UserDataModal({ open, onOpenChange, userdataNotesRef }) {
  const { state, userId, t } = useContext(AppContext);
  const projectId = state.currentProjectId;
  const [currentPath, setCurrentPath] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingItem, setRenamingItem] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [clipboard, setClipboard] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const loadDir = useCallback(async (p) => {
    if (!projectId || !userId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/userdata?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(p || "")}`);
      if (!res.ok) throw new Error("Failed to load");
      setItems(await res.json());
      setCurrentPath(p || "");
    } catch { setItems([]); }
    setLoading(false);
  }, [projectId, userId]);

  useEffect(() => { if (open) loadDir(""); }, [open, loadDir]);

  const pathSegments = currentPath ? currentPath.split("/").filter(Boolean) : [];

  const navigateTo = (idx) => {
    const p = idx < 0 ? "" : pathSegments.slice(0, idx + 1).join("/");
    setRenamingItem(null);
    setShowNewFolder(false);
    loadDir(p);
  };

  const enterFolder = (name) => {
    const p = currentPath ? `${currentPath}/${name}` : name;
    setRenamingItem(null);
    setShowNewFolder(false);
    loadDir(p);
  };

  const handleUploadFiles = async (files) => {
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    try {
      const res = await fetch(`/api/projects/${projectId}/userdata/upload?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(currentPath)}`, {
        method: "POST", body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const names = Array.from(files).map(f => f.name).join(", ");
      userdataNotesRef.current.push(`uploaded ${names} to /${currentPath || "userdata"}`);
      loadDir(currentPath);
    } catch (err) { console.error("Upload failed:", err); }
  };

  const handleMkdir = async () => {
    if (!newFolderName.trim()) return;
    const p = currentPath ? `${currentPath}/${newFolderName.trim()}` : newFolderName.trim();
    try {
      await api(`/projects/${projectId}/userdata/mkdir`, { method: "POST", body: JSON.stringify({ userId, path: p }) });
      userdataNotesRef.current.push(`created folder /${p}`);
      setShowNewFolder(false);
      setNewFolderName("");
      loadDir(currentPath);
    } catch (err) { console.error("Mkdir failed:", err); }
  };

  const handleRename = async (oldName) => {
    if (!renameValue.trim() || renameValue.trim() === oldName) { setRenamingItem(null); return; }
    const p = currentPath ? `${currentPath}/${oldName}` : oldName;
    try {
      await api(`/projects/${projectId}/userdata/rename`, { method: "POST", body: JSON.stringify({ userId, path: p, newName: renameValue.trim() }) });
      userdataNotesRef.current.push(`renamed ${oldName} → ${renameValue.trim()} in /${currentPath || "userdata"}`);
      setRenamingItem(null);
      loadDir(currentPath);
    } catch (err) { console.error("Rename failed:", err); }
  };

  const handleDelete = async (name) => {
    const p = currentPath ? `${currentPath}/${name}` : name;
    if (!window.confirm(t("userdata.deleteConfirm").replace("{name}", name))) return;
    try {
      await api(`/projects/${projectId}/userdata`, { method: "DELETE", body: JSON.stringify({ userId, path: p }) });
      userdataNotesRef.current.push(`deleted ${name} from /${currentPath || "userdata"}`);
      loadDir(currentPath);
    } catch (err) { console.error("Delete failed:", err); }
  };

  const handleCut = (item) => {
    setClipboard({ name: item.name, path: currentPath ? `${currentPath}/${item.name}` : item.name, from: currentPath });
  };

  const handlePaste = async () => {
    if (!clipboard) return;
    const dest = currentPath ? `${currentPath}/${clipboard.name}` : clipboard.name;
    try {
      await api(`/projects/${projectId}/userdata/move`, { method: "POST", body: JSON.stringify({ userId, src: clipboard.path, dest }) });
      userdataNotesRef.current.push(`moved ${clipboard.name} from /${clipboard.from || "userdata"} to /${currentPath || "userdata"}`);
      setClipboard(null);
      loadDir(currentPath);
    } catch (err) { console.error("Move failed:", err); }
  };

  const handleDownload = (name) => {
    const p = currentPath ? `${currentPath}/${name}` : name;
    window.open(`/api/projects/${projectId}/userdata/download?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(p)}`);
  };

  const handleUnzip = async (name) => {
    const p = currentPath ? `${currentPath}/${name}` : name;
    try {
      const result = await api(`/projects/${projectId}/userdata/unzip`, { method: "POST", body: JSON.stringify({ userId, path: p }) });
      userdataNotesRef.current.push(`unzipped ${name} → /${result.extractedTo}`);
      loadDir(currentPath);
    } catch (err) { console.error("Unzip failed:", err); }
  };

  const onDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); handleUploadFiles(Array.from(e.dataTransfer.files)); };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content userdata-wide" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
          {dragOver && <div className="userdata-dropzone">{t("userdata.dropFiles")}</div>}
          <Dialog.Title className="modal-title">
            <FolderOpen size={18} style={{ marginRight: 8, verticalAlign: "middle" }} />
            {t("userdata.title")}
          </Dialog.Title>

          <div className="userdata-breadcrumb">
            <button onClick={() => navigateTo(-1)}>{t("userdata.root")}</button>
            {pathSegments.map((seg, i) => (
              <React.Fragment key={i}>
                <ChevronRight size={12} className="separator" />
                <button onClick={() => navigateTo(i)}>{seg}</button>
              </React.Fragment>
            ))}
          </div>

          <div className="userdata-toolbar">
            <button onClick={() => fileInputRef.current?.click()}>
              <ArrowUpFromLine size={12} /> {t("userdata.upload")}
            </button>
            <button onClick={() => { setShowNewFolder(true); setNewFolderName(""); }}>
              <FolderPlus size={12} /> {t("userdata.newFolder")}
            </button>
            {clipboard && clipboard.from !== currentPath && (
              <button onClick={handlePaste}>
                <ArrowDownToLine size={12} /> {t("userdata.paste")}
              </button>
            )}
          </div>

          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }}
            onChange={(e) => { handleUploadFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />

          {showNewFolder && (
            <div className="userdata-new-folder">
              <FolderPlus size={14} style={{ color: "var(--muted)" }} />
              <input className="userdata-rename-input" autoFocus placeholder={t("userdata.folderName")}
                value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleMkdir(); if (e.key === "Escape") setShowNewFolder(false); }} />
              <button className="btn-primary" style={{ padding: "3px 10px", fontSize: 12 }} onClick={handleMkdir}>{t("userdata.create")}</button>
              <button className="btn-secondary" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setShowNewFolder(false)}>
                <X size={12} />
              </button>
            </div>
          )}

          <div className="userdata-list">
            {loading && <div className="userdata-empty"><Loader size={16} className="inline-collapse-status-icon" /></div>}
            {!loading && items.length === 0 && <div className="userdata-empty">{t("userdata.empty")}</div>}
            {!loading && items.map(item => (
              <div key={item.name} className={`userdata-item${item.type === "directory" ? " folder" : ""}`}
                onClick={item.type === "directory" ? () => enterFolder(item.name) : undefined}>
                <span className="item-icon">
                  {item.type === "directory" ? <FolderOpen size={14} /> : <FileText size={14} />}
                </span>
                {renamingItem === item.name ? (
                  <input className="userdata-rename-input" autoFocus value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => { if (e.key === "Enter") handleRename(item.name); if (e.key === "Escape") setRenamingItem(null); }}
                    onBlur={() => handleRename(item.name)} />
                ) : (
                  <span className="item-name">{item.name}</span>
                )}
                {item.type === "file" && <span className="item-size">{formatFileSize(item.size)}</span>}
                <span className="item-actions" onClick={e => e.stopPropagation()}>
                  <Tip label={t("userdata.rename")}>
                    <button onClick={() => { setRenamingItem(item.name); setRenameValue(item.name); }}><Pencil size={12} /></button>
                  </Tip>
                  <Tip label={t("userdata.cut")}>
                    <button onClick={() => handleCut(item)}><Minus size={12} /></button>
                  </Tip>
                  {item.type === "file" && (
                    <Tip label={t("userdata.download")}>
                      <button onClick={() => handleDownload(item.name)}><ArrowDownToLine size={12} /></button>
                    </Tip>
                  )}
                  {item.type === "file" && /\.zip$/i.test(item.name) && (
                    <Tip label={t("userdata.unzip")}>
                      <button onClick={() => handleUnzip(item.name)}><Package size={12} /></button>
                    </Tip>
                  )}
                  <Tip label={t("userdata.delete")}>
                    <button className="danger" onClick={() => handleDelete(item.name)}><Trash2 size={12} /></button>
                  </Tip>
                </span>
              </div>
            ))}
          </div>

          <div className="modal-actions" style={{ marginTop: 16 }}>
            <Dialog.Close asChild>
              <button className="btn-secondary">{t("common.close")}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Read-only browser for a project's release/ folder (Electron build output
// and static web exports). Opened from the Deploy dialog when running in a
// normal browser; the desktop app opens the OS file explorer instead.
// Trimmed copy of UserDataModal.
function ReleaseFolderDialog({ open, onOpenChange }) {
  const { state, userId, t } = useContext(AppContext);
  const projectId = state.currentProjectId;
  const [currentPath, setCurrentPath] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadDir = useCallback(async (p) => {
    if (!projectId || !userId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/release?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(p || "")}`);
      if (!res.ok) throw new Error("Failed to load");
      setItems(await res.json());
      setCurrentPath(p || "");
    } catch { setItems([]); }
    setLoading(false);
  }, [projectId, userId]);

  useEffect(() => { if (open) loadDir(""); }, [open, loadDir]);

  const pathSegments = currentPath ? currentPath.split("/").filter(Boolean) : [];
  const navigateTo = (idx) => { loadDir(idx < 0 ? "" : pathSegments.slice(0, idx + 1).join("/")); };
  const enterFolder = (name) => { loadDir(currentPath ? `${currentPath}/${name}` : name); };
  const handleDownload = (name) => {
    const p = currentPath ? `${currentPath}/${name}` : name;
    window.open(`/api/projects/${projectId}/release/download?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(p)}`);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content userdata-wide">
          <Dialog.Title className="modal-title">
            <FolderOpen size={18} style={{ marginRight: 8, verticalAlign: "middle" }} />
            {t("deploy.release.title")}
          </Dialog.Title>

          <div className="userdata-breadcrumb">
            <button onClick={() => navigateTo(-1)}>{t("deploy.release.root")}</button>
            {pathSegments.map((seg, i) => (
              <React.Fragment key={i}>
                <ChevronRight size={12} className="separator" />
                <button onClick={() => navigateTo(i)}>{seg}</button>
              </React.Fragment>
            ))}
          </div>

          <div className="userdata-list">
            {loading && <div className="userdata-empty"><Loader size={16} className="inline-collapse-status-icon" /></div>}
            {!loading && items.length === 0 && <div className="userdata-empty">{t("deploy.release.empty")}</div>}
            {!loading && items.map(item => (
              <div key={item.name} className={`userdata-item${item.type === "directory" ? " folder" : ""}`}
                onClick={item.type === "directory" ? () => enterFolder(item.name) : undefined}>
                <span className="item-icon">
                  {item.type === "directory" ? <FolderOpen size={14} /> : <FileText size={14} />}
                </span>
                <span className="item-name">{item.name}</span>
                {item.type === "file" && <span className="item-size">{formatFileSize(item.size)}</span>}
                <span className="item-actions" onClick={e => e.stopPropagation()}>
                  {item.type === "file" && (
                    <Tip label={t("userdata.download")}>
                      <button onClick={() => handleDownload(item.name)}><ArrowDownToLine size={12} /></button>
                    </Tip>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div className="modal-actions" style={{ marginTop: 16 }}>
            <Dialog.Close asChild>
              <button className="btn-secondary">{t("common.close")}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// "Open release folder" affordance shared by the Electron and web-export
// deploy sections: the packaged desktop app opens the folder in the OS file
// explorer (server-side, via Electron's shell); the container/browser build
// opens the in-app read-only release browser instead.
function ReleaseFolderAccess({ isPackaged }) {
  const { state, userId, t } = useContext(AppContext);
  const projectId = state.currentProjectId;
  const [error, setError] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  return (
    <>
      <button
        type="button"
        className="dpl-release-link"
        onClick={async () => {
          if (isPackaged) {
            setError("");
            try {
              await api(`/projects/${encodeURIComponent(projectId)}/release/open`, {
                method: "POST",
                body: JSON.stringify({ userId }),
              });
            } catch (err) {
              setError(err?.message || String(err));
            }
          } else {
            setShowDialog(true);
          }
        }}
      >
        <FolderOpen size={14} /> {t("deploy.release.openBtn")}
      </button>
      {error && <div className="dpl-error">{error}</div>}
      <ReleaseFolderDialog open={showDialog} onOpenChange={setShowDialog} />
    </>
  );
}

// ─── Use-Case Diagram Dialog (Graphical SVG Editor) ─────────

function ucAutoLayout(data) {
  const d = JSON.parse(JSON.stringify(data));
  // Migrate systemBoundary → boundaries
  if (d.systemBoundary && (!d.boundaries || d.boundaries.length === 0)) {
    const b = d.systemBoundary;
    if (!b.id) b.id = crypto.randomUUID().slice(0, 8);
    d.boundaries = [b];
  }
  if (!d.boundaries) d.boundaries = [];
  delete d.systemBoundary;
  d.actors.forEach((a, i) => { if (a.x == null) { a.x = 80; a.y = i * 130 + 100; } });
  const firstB = d.boundaries[0];
  const bx = firstB ? firstB.x + 60 : 280;
  const by = firstB ? firstB.y + 60 : 80;
  d.useCases.forEach((uc, i) => { if (uc.x == null) { uc.x = bx + (i % 2) * 200; uc.y = by + Math.floor(i / 2) * 110; } });
  // Migrate: ensure all connections have IDs
  d.connections.forEach(c => { if (!c.id) c.id = crypto.randomUUID().slice(0, 8); });
  return d;
}

function svgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function wrapText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  // Hard-break any single token longer than maxChars (e.g. German compound nouns).
  const tokens = text.split(" ").flatMap(w => {
    if (w.length <= maxChars) return [w];
    const chunks = [];
    for (let i = 0; i < w.length; i += maxChars) chunks.push(w.slice(i, i + maxChars));
    return chunks;
  });
  const lines = []; let cur = "";
  for (const w of tokens) {
    if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Shape size buckets — LLM picks "S" | "M" | "L" via the `size` field on each item.
// Default "S" preserves the original geometry; M and L grow the shape to fit longer labels.
const USECASE_SIZES = {
  S: { rx: 75,  ry: 32, wrap: 16 },
  M: { rx: 100, ry: 44, wrap: 18 },
  L: { rx: 130, ry: 56, wrap: 22 },
};
const DEPLOY_NODE_SIZES = {
  S: { w: 120, h: 60,  wrap: 14 },
  M: { w: 160, h: 80,  wrap: 18 },
  L: { w: 200, h: 100, wrap: 22 },
};
const DEPLOY_COMPONENT_SIZES = {
  S: { w: 140, h: 56, wrap: 16 },
  M: { w: 170, h: 76, wrap: 18 },
  L: { w: 210, h: 92, wrap: 22 },
};
const COMPONENT_SIZES = {
  S: { w: 140, h: 56, wrap: 16 },
  M: { w: 170, h: 72, wrap: 18 },
  L: { w: 210, h: 88, wrap: 22 },
};
const ACTIVITY_ACTION_SIZES = {
  S: { w: 140, h: 44, wrap: 18 },
  M: { w: 180, h: 60, wrap: 22 },
  L: { w: 220, h: 76, wrap: 26 },
};
const ACTIVITY_DECISION_SIZES = {
  S: { s: 24, wrap: 10 },
  M: { s: 36, wrap: 14 },
  L: { s: 48, wrap: 18 },
};
const INTERFACE_SIZES = {
  S: { r: 14, wrap: 12 },
  M: { r: 14, wrap: 18 },
  L: { r: 14, wrap: 24 },
};
const ACTOR_SIZES = {
  S: { wrap: 20 },
  M: { wrap: 28 },
  L: { wrap: 36 },
};
const ER_SIZES = {
  S: { w: 180 },
  M: { w: 220 },
  L: { w: 260 },
};
function pickSize(obj, table) { return table[obj && obj.size] || table.S; }

function ActorShape({ actor, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const { x, y } = actor;
  const { wrap } = pickSize(actor, ACTOR_SIZES);
  const labelLines = wrapText(actor.name || "Actor", wrap);
  return (
    <g className={`uc-actor-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <circle cx={x} cy={y - 24} r={12} fill="#2dd4bf" stroke={selected ? "var(--accent)" : "#0d9488"} strokeWidth={selected ? 2.5 : 1.5} />
      <line x1={x} y1={y - 12} x2={x} y2={y + 12} stroke="#0d9488" strokeWidth={2} />
      <line x1={x - 16} y1={y - 2} x2={x + 16} y2={y - 2} stroke="#0d9488" strokeWidth={2} />
      <line x1={x} y1={y + 12} x2={x - 14} y2={y + 30} stroke="#0d9488" strokeWidth={2} />
      <line x1={x} y1={y + 12} x2={x + 14} y2={y + 30} stroke="#0d9488" strokeWidth={2} />
      {labelLines.map((l, i) => (
        <text key={i} x={x} y={y + 48 + i * 14} textAnchor="middle" fontSize="12" fill="var(--text-primary)" fontWeight="500">{l}</text>
      ))}
      {/* Connection point */}
      <circle className="uc-connection-point" cx={x + 20} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, actor.id, "actor"); }} />
    </g>
  );
}

function UseCaseShape({ useCase, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const { x, y } = useCase;
  const { rx, ry, wrap } = pickSize(useCase, USECASE_SIZES);
  const lines = wrapText(useCase.name || "Use Case", wrap);
  return (
    <g className={`uc-usecase-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <ellipse cx={x} cy={y} rx={rx} ry={ry} fill="#4ade80" stroke={selected ? "var(--accent)" : "#16a34a"} strokeWidth={selected ? 2.5 : 1.5} opacity={0.9} />
      {lines.map((l, i) => (
        <text key={i} x={x} y={y + (i - (lines.length - 1) / 2) * 14} textAnchor="middle" fontSize="11" fill="#14532d" fontWeight="500" dominantBaseline="central">{l}</text>
      ))}
      {/* Connection points */}
      <circle className="uc-connection-point" cx={x - rx} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, useCase.id, "usecase"); }} />
      <circle className="uc-connection-point" cx={x + rx} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, useCase.id, "usecase"); }} />
    </g>
  );
}

// UML Deployment Diagram: 3D node box (cube) for external nodes
function DeploymentNodeShape({ actor, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const { x, y } = actor;
  const sz = pickSize(actor, DEPLOY_NODE_SIZES);
  const w = sz.w, h = sz.h, d = 14;
  const lx = x - w / 2, ty = y - h / 2;
  const lines = wrapText(actor.name || "Node", sz.wrap);
  const stroke = selected ? "var(--accent)" : "#0d9488";
  const sw = selected ? 2.5 : 1.5;
  return (
    <g className={`uc-actor-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      {/* Right face */}
      <polygon points={`${lx + w},${ty} ${lx + w + d},${ty - d} ${lx + w + d},${ty + h - d} ${lx + w},${ty + h}`}
        fill="#1a9e8e" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      {/* Top face */}
      <polygon points={`${lx},${ty} ${lx + d},${ty - d} ${lx + w + d},${ty - d} ${lx + w},${ty}`}
        fill="#5eead4" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      {/* Front face */}
      <rect x={lx} y={ty} width={w} height={h} fill="#2dd4bf" stroke={stroke} strokeWidth={sw} rx={2} />
      {/* <<device>> / <<node>> stereotype */}
      <text x={x} y={ty + 14} textAnchor="middle" fontSize="9" fill="#0d6e63" fontStyle="italic" fontWeight="400">{"«node»"}</text>
      {/* Name */}
      {lines.map((l, i) => (
        <text key={i} x={x} y={ty + 28 + i * 14} textAnchor="middle" fontSize="11" fill="#042f2e" fontWeight="600" dominantBaseline="central">{l}</text>
      ))}
      {/* Connection point */}
      <circle className="uc-connection-point" cx={lx + w} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, actor.id, "actor"); }} />
    </g>
  );
}

// UML Deployment Diagram: component rectangle with tabs
function DeploymentComponentShape({ useCase, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const { x, y } = useCase;
  const sz = pickSize(useCase, DEPLOY_COMPONENT_SIZES);
  const w = sz.w, h = sz.h;
  const lx = x - w / 2, ty = y - h / 2;
  const lines = wrapText(useCase.name || "Component", sz.wrap);
  const stroke = selected ? "var(--accent)" : "#16a34a";
  const sw = selected ? 2.5 : 1.5;
  const tabW = 16, tabH = 8;
  return (
    <g className={`uc-usecase-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      {/* Main body */}
      <rect x={lx} y={ty} width={w} height={h} fill="#4ade80" stroke={stroke} strokeWidth={sw} rx={3} opacity={0.9} />
      {/* Top tab */}
      <rect x={lx - tabW / 2} y={ty + 8} width={tabW} height={tabH} fill="#4ade80" stroke={stroke} strokeWidth={sw} rx={1} />
      {/* Bottom tab */}
      <rect x={lx - tabW / 2} y={ty + 22} width={tabW} height={tabH} fill="#4ade80" stroke={stroke} strokeWidth={sw} rx={1} />
      {/* <<component>> stereotype */}
      <text x={x} y={ty + 14} textAnchor="middle" fontSize="9" fill="#14532d" fontStyle="italic" fontWeight="400">{"«component»"}</text>
      {/* Name */}
      {lines.map((l, i) => (
        <text key={i} x={x} y={ty + 28 + i * 14} textAnchor="middle" fontSize="11" fill="#14532d" fontWeight="600" dominantBaseline="central">{l}</text>
      ))}
      {/* Connection points */}
      <circle className="uc-connection-point" cx={lx} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, useCase.id, "usecase"); }} />
      <circle className="uc-connection-point" cx={lx + w} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, useCase.id, "usecase"); }} />
    </g>
  );
}

// UML Deployment Diagram: environment boundary (solid box instead of dashed)
function DeploymentBoundaryShape({ boundary, onMouseDown, onDoubleClick }) {
  if (!boundary) return null;
  const { x, y, width, height, name } = boundary;
  const d = 10; // 3D depth
  return (
    <g>
      {/* Right face */}
      <polygon points={`${x + width},${y} ${x + width + d},${y - d} ${x + width + d},${y + height - d} ${x + width},${y + height}`}
        fill="rgba(139,92,246,0.06)" stroke="#8b5cf6" strokeWidth={1.5} strokeLinejoin="round" />
      {/* Top face */}
      <polygon points={`${x},${y} ${x + d},${y - d} ${x + width + d},${y - d} ${x + width},${y}`}
        fill="rgba(139,92,246,0.1)" stroke="#8b5cf6" strokeWidth={1.5} strokeLinejoin="round" />
      {/* Front face */}
      <rect className="uc-boundary-rect" x={x} y={y} width={width} height={height}
        fill="rgba(139,92,246,0.05)" stroke="#8b5cf6" strokeWidth={1.5} rx={3}
        onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} />
      <text x={x + 12} y={y + 20} fontSize="9" fontStyle="italic" fill="#7c3aed">{"«execution environment»"}</text>
      <text x={x + 12} y={y + 36} fontSize="14" fontWeight="600" fill="#8b5cf6">{name || "Environment"}</text>
      {/* Resize handle */}
      <rect className="uc-boundary-resize" x={x + width - 12} y={y + height - 12} width={12} height={12}
        fill="#8b5cf6" opacity={0.3} rx={2}
        onMouseDown={e => { e.stopPropagation(); e._resizeBoundary = true; onMouseDown(e); }} />
    </g>
  );
}

// UML Component Diagram: interface lollipop circle
function InterfaceShape({ actor, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const { x, y } = actor;
  const sz = pickSize(actor, INTERFACE_SIZES);
  const r = sz.r;
  const lines = wrapText(actor.name || "Interface", sz.wrap);
  const stroke = selected ? "var(--accent)" : "#2563eb";
  return (
    <g className={`uc-actor-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <circle cx={x} cy={y} r={r} fill="#dbeafe" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
      <circle cx={x} cy={y} r={4} fill={stroke} />
      {lines.map((l, i) => (
        <text key={i} x={x} y={y + r + 14 + i * 14} textAnchor="middle" fontSize="10" fill="#1e40af" fontWeight="500">{l}</text>
      ))}
      <circle className="uc-connection-point" cx={x + r + 4} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, actor.id, "actor"); }} />
    </g>
  );
}

// UML Component Diagram: component box with UML component icon
function ComponentBoxShape({ useCase, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const { x, y } = useCase;
  const sz = pickSize(useCase, COMPONENT_SIZES);
  const w = sz.w, h = sz.h;
  const lx = x - w / 2, ty = y - h / 2;
  const lines = wrapText(useCase.name || "Component", sz.wrap);
  const stroke = selected ? "var(--accent)" : "#2563eb";
  const sw = selected ? 2.5 : 1.5;
  return (
    <g className={`uc-usecase-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <rect x={lx} y={ty} width={w} height={h} fill="#dbeafe" stroke={stroke} strokeWidth={sw} rx={3} opacity={0.9} />
      {/* Component icon top-right */}
      <rect x={lx + w - 26} y={ty + 4} width={14} height={10} fill="none" stroke={stroke} strokeWidth={1} rx={1} />
      <rect x={lx + w - 29} y={ty + 6} width={6} height={3} fill="#dbeafe" stroke={stroke} strokeWidth={0.8} rx={0.5} />
      <rect x={lx + w - 29} y={ty + 10} width={6} height={3} fill="#dbeafe" stroke={stroke} strokeWidth={0.8} rx={0.5} />
      {lines.map((l, i) => (
        <text key={i} x={x} y={ty + 24 + i * 14} textAnchor="middle" fontSize="11" fill="#1e40af" fontWeight="600" dominantBaseline="central">{l}</text>
      ))}
      <circle className="uc-connection-point" cx={lx} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, useCase.id, "usecase"); }} />
      <circle className="uc-connection-point" cx={lx + w} cy={y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, useCase.id, "usecase"); }} />
    </g>
  );
}

// UML Component Diagram: package boundary (tabbed rectangle)
function PackageBoundaryShape({ boundary, onMouseDown, onDoubleClick }) {
  if (!boundary) return null;
  const { x, y, width, height, name } = boundary;
  const tabW = 80, tabH = 20;
  return (
    <g>
      {/* Tab */}
      <rect x={x} y={y - tabH} width={tabW} height={tabH} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={1.5} rx={0} />
      <text x={x + 6} y={y - 5} fontSize="11" fontWeight="600" fill="#2563eb">{name || "Package"}</text>
      {/* Body */}
      <rect className="uc-boundary-rect" x={x} y={y} width={width} height={height}
        fill="rgba(37,99,235,0.04)" stroke="#2563eb" strokeWidth={1.5} rx={0}
        onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} />
      <rect className="uc-boundary-resize" x={x + width - 12} y={y + height - 12} width={12} height={12}
        fill="#2563eb" opacity={0.3} rx={2}
        onMouseDown={e => { e.stopPropagation(); e._resizeBoundary = true; onMouseDown(e); }} />
    </g>
  );
}

function SystemBoundaryShape({ boundary, onMouseDown, onDoubleClick }) {
  if (!boundary) return null;
  const { x, y, width, height, name } = boundary;
  return (
    <g>
      <rect className="uc-boundary-rect" x={x} y={y} width={width} height={height}
        fill="rgba(139,92,246,0.08)" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="6,3" rx={8}
        onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} />
      <text x={x + 12} y={y + 22} fontSize="14" fontWeight="600" fill="#8b5cf6">{name || "System"}</text>
      {/* Resize handle */}
      <rect className="uc-boundary-resize" x={x + width - 12} y={y + height - 12} width={12} height={12}
        fill="#8b5cf6" opacity={0.3} rx={2}
        onMouseDown={e => { e.stopPropagation(); e._resizeBoundary = true; onMouseDown(e); }} />
    </g>
  );
}

function ConnectionLine({ fromX, fromY, toX, toY, label, dashed, selected, onClick, onDoubleClick }) {
  const mx = (fromX + toX) / 2, my = (fromY + toY) / 2;
  return (
    <g>
      {/* Wide invisible hit area for easier clicking */}
      <line x1={fromX} y1={fromY} x2={toX} y2={toY}
        stroke="transparent" strokeWidth={14} style={{ cursor: "pointer" }}
        onClick={onClick} onDoubleClick={onDoubleClick} />
      <line x1={fromX} y1={fromY} x2={toX} y2={toY}
        stroke={selected ? "var(--accent)" : "var(--text-muted)"} strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={dashed ? "6,4" : "none"}
        markerEnd="url(#arrowhead)" pointerEvents="none" />
      {label && (
        <>
          <rect x={mx - label.length * 3.5 - 4} y={my - 10} width={label.length * 7 + 8} height={16} rx={3} fill="var(--bg-secondary)" stroke={selected ? "var(--accent)" : "var(--border)"} strokeWidth={selected ? 1 : 0.5} pointerEvents="none" />
          <text x={mx} y={my + 1} textAnchor="middle" fontSize="10" fill={selected ? "var(--accent)" : "var(--text-secondary)"} dominantBaseline="central">{label}</text>
        </>
      )}
    </g>
  );
}

function UseCaseCanvas({ data, setData, selectedId, setSelectedId, tool, setTool, t, diagramType, hideAllActors }) {
  const isDeploy = diagramType === "deployment";
  const isComponent = diagramType === "component";
  const isUseCase = diagramType === "usecase";
  const svgRef = useRef(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1800, h: 1000 });
  const [dragging, setDragging] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const [connTypeMenu, setConnTypeMenu] = useState(null); // { fromId, fromType, toId, toType, x, y }
  const [editingConn, setEditingConn] = useState(null); // { id, dataType, label, connType, x, y }

  const getElementCenter = useCallback((id, type) => {
    if (type === "actor") { const a = data.actors.find(a => a.id === id); return a ? { x: a.x, y: a.y } : null; }
    const uc = data.useCases.find(u => u.id === id); return uc ? { x: uc.x, y: uc.y } : null;
  }, [data]);

  const handleCanvasMouseDown = useCallback((e) => {
    if (e.target === svgRef.current || e.target.tagName === "svg") {
      setSelectedId(null);
      setEditingId(null);
      setConnTypeMenu(null);
      setEditingConn(null);
      const startX = e.clientX, startY = e.clientY;
      const origVB = { ...viewBox };
      const onMove = (me) => {
        const dx = (me.clientX - startX) * (viewBox.w / svgRef.current.clientWidth);
        const dy = (me.clientY - startY) * (viewBox.h / svgRef.current.clientHeight);
        setViewBox({ ...origVB, x: origVB.x - dx, y: origVB.y - dy });
      };
      const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
  }, [viewBox]);

  const handleElementMouseDown = useCallback((e, id, type) => {
    e.stopPropagation();
    setSelectedId(id);
    setConnTypeMenu(null);
    setEditingConn(null);
    if (tool === "select" || tool === "connect" || tool === "relationship") {
      const svg = svgRef.current;
      const pt = svgPoint(svg, e.clientX, e.clientY);
      const el = type === "actor" ? data.actors.find(a => a.id === id) : type === "usecase" ? data.useCases.find(u => u.id === id) : (data.boundaries || []).find(b => b.id === id);
      if (!el) return;
      const isResize = e._resizeBoundary;
      setDragging({ type, id, startX: pt.x, startY: pt.y, origX: el.x, origY: el.y, origW: el.width, origH: el.height, isResize });
    }
  }, [tool, data]);

  const handleConnectStart = useCallback((e, fromId, fromType) => {
    const svg = svgRef.current;
    const pt = svgPoint(svg, e.clientX, e.clientY);
    setConnecting({ fromId, fromType, mouseX: pt.x, mouseY: pt.y });
  }, []);

  // Mouse move/up handlers
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onMove = (e) => {
      const pt = svgPoint(svg, e.clientX, e.clientY);
      if (dragging) {
        const dx = pt.x - dragging.startX, dy = pt.y - dragging.startY;
        if (dragging.type === "actor") {
          setData(d => ({ ...d, actors: d.actors.map(a => a.id === dragging.id ? { ...a, x: dragging.origX + dx, y: dragging.origY + dy } : a) }));
        } else if (dragging.type === "usecase") {
          setData(d => ({ ...d, useCases: d.useCases.map(u => u.id === dragging.id ? { ...u, x: dragging.origX + dx, y: dragging.origY + dy } : u) }));
        } else if (dragging.type === "boundary") {
          if (dragging.isResize) {
            setData(d => ({ ...d, boundaries: (d.boundaries || []).map(b => b.id === dragging.id ? { ...b, width: Math.max(200, dragging.origW + dx), height: Math.max(150, dragging.origH + dy) } : b) }));
          } else {
            setData(d => ({ ...d, boundaries: (d.boundaries || []).map(b => b.id === dragging.id ? { ...b, x: dragging.origX + dx, y: dragging.origY + dy } : b) }));
          }
        }
      }
      if (connecting) {
        setConnecting(c => ({ ...c, mouseX: pt.x, mouseY: pt.y }));
      }
    };

    const onUp = (e) => {
      if (connecting) {
        const pt = svgPoint(svg, e.clientX, e.clientY);
        let targetId = null, targetType = null;
        const ucHitW = isDeploy ? 70 : 75, ucHitH = isDeploy ? 28 : 32;
        for (const uc of data.useCases) {
          if (Math.abs(pt.x - uc.x) < ucHitW && Math.abs(pt.y - uc.y) < ucHitH) { targetId = uc.id; targetType = "usecase"; break; }
        }
        if (!targetId) {
          const aHitW = isDeploy ? 60 : 20, aHitH = isDeploy ? 30 : 30;
          for (const a of data.actors) {
            if (Math.abs(pt.x - a.x) < aHitW && Math.abs(pt.y - a.y) < aHitH) { targetId = a.id; targetType = "actor"; break; }
          }
        }
        if (targetId && targetId !== connecting.fromId) {
          // Show type picker for ALL connections
          setConnTypeMenu({ fromId: connecting.fromId, fromType: connecting.fromType, toId: targetId, toType: targetType, x: e.clientX, y: e.clientY });
        }
        setConnecting(null);
      }
      setDragging(null);
    };

    svg.addEventListener("mousemove", onMove);
    svg.addEventListener("mouseup", onUp);
    return () => { svg.removeEventListener("mousemove", onMove); svg.removeEventListener("mouseup", onUp); };
  }, [dragging, connecting, data]);

  // Create connection from type picker
  const createConnection = useCallback((connType) => {
    if (!connTypeMenu) return;
    const { fromId, fromType, toId, toType } = connTypeMenu;
    const isActorConn = (fromType === "actor" && toType === "usecase") || (fromType === "usecase" && toType === "actor");
    if (isActorConn) {
      const actorId = fromType === "actor" ? fromId : toId;
      const useCaseId = fromType === "usecase" ? fromId : toId;
      const id = crypto.randomUUID().slice(0, 8);
      setData(d => ({ ...d, connections: [...d.connections, { id, actorId, useCaseId, label: connType === "association" ? "" : `<<${connType}>>` }] }));
    } else {
      // usecase ↔ usecase
      const id = crypto.randomUUID().slice(0, 8);
      if (connType === "association") {
        setData(d => ({ ...d, relationships: [...(d.relationships || []), { id, fromUseCaseId: fromId, toUseCaseId: toId, type: "association" }] }));
      } else {
        setData(d => ({ ...d, relationships: [...(d.relationships || []), { id, fromUseCaseId: fromId, toUseCaseId: toId, type: connType }] }));
      }
    }
    setConnTypeMenu(null);
  }, [connTypeMenu]);

  // Keyboard handler — delete elements AND connections/relationships
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Delete" && selectedId && !editingId && !editingConn) {
        setData(d => {
          // Check if selectedId is a connection
          const isConn = d.connections.some(c => c.id === selectedId);
          const isRel = (d.relationships || []).some(r => r.id === selectedId);
          const isBoundary = (d.boundaries || []).some(b => b.id === selectedId);
          if (isConn) {
            return { ...d, connections: d.connections.filter(c => c.id !== selectedId) };
          }
          if (isRel) {
            return { ...d, relationships: (d.relationships || []).filter(r => r.id !== selectedId) };
          }
          if (isBoundary) {
            return { ...d, boundaries: (d.boundaries || []).filter(b => b.id !== selectedId) };
          }
          // Otherwise it's an element — remove it and its connections
          return {
            ...d,
            actors: d.actors.filter(a => a.id !== selectedId),
            useCases: d.useCases.filter(u => u.id !== selectedId),
            connections: d.connections.filter(c => c.actorId !== selectedId && c.useCaseId !== selectedId),
            relationships: (d.relationships || []).filter(r => r.fromUseCaseId !== selectedId && r.toUseCaseId !== selectedId),
          };
        });
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, editingId, editingConn]);

  // Double-click to edit element name
  const handleDoubleClick = useCallback((e, id, type) => {
    e.stopPropagation();
    const el = type === "actor" ? data.actors.find(a => a.id === id)
      : type === "usecase" ? data.useCases.find(u => u.id === id)
      : (data.boundaries || []).find(b => b.id === id);
    if (el) { setEditingId(id); setEditingValue(el.name); }
  }, [data]);

  const commitEdit = useCallback(() => {
    if (!editingId) return;
    setData(d => ({
      ...d,
      actors: d.actors.map(a => a.id === editingId ? { ...a, name: editingValue } : a),
      useCases: d.useCases.map(u => u.id === editingId ? { ...u, name: editingValue } : u),
      boundaries: (d.boundaries || []).map(b => b.id === editingId ? { ...b, name: editingValue } : b),
    }));
    setEditingId(null);
  }, [editingId, editingValue]);

  // Double-click on connection line to edit
  const handleConnDoubleClick = useCallback((e, cl) => {
    e.stopPropagation();
    const svgRect = svgRef.current?.getBoundingClientRect();
    const svg = svgRef.current;
    const mx = (cl.fromX + cl.toX) / 2, my = (cl.fromY + cl.toY) / 2;
    const pt = svg.createSVGPoint(); pt.x = mx; pt.y = my;
    const screen = pt.matrixTransform(svg.getScreenCTM());
    setEditingConn({
      id: cl.id,
      dataType: cl.dataType,
      label: cl.rawLabel || "",
      connType: cl.connType || "association",
      x: screen.x - svgRect.left,
      y: screen.y - svgRect.top,
    });
  }, []);

  const commitConnEdit = useCallback(() => {
    if (!editingConn) return;
    const { id, dataType, label, connType } = editingConn;
    if (dataType === "connection") {
      setData(d => ({
        ...d,
        connections: d.connections.map(c => c.id === id ? { ...c, label: connType === "association" ? (label || "") : (label || `<<${connType}>>`), type: connType } : c),
      }));
    } else {
      setData(d => ({
        ...d,
        relationships: (d.relationships || []).map(r => r.id === id ? { ...r, type: connType, label: label || "" } : r),
      }));
    }
    setEditingConn(null);
  }, [editingConn]);

  const deleteEditingConn = useCallback(() => {
    if (!editingConn) return;
    const { id, dataType } = editingConn;
    if (dataType === "connection") {
      setData(d => ({ ...d, connections: d.connections.filter(c => c.id !== id) }));
    } else {
      setData(d => ({ ...d, relationships: (d.relationships || []).filter(r => r.id !== id) }));
    }
    setEditingConn(null);
    setSelectedId(null);
  }, [editingConn]);

  // Zoom — use native listener with { passive: false } so preventDefault works
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e) => {
      e.preventDefault();
      const scale = e.deltaY > 0 ? 1.1 : 0.9;
      setViewBox(vb => {
        const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
        const nw = vb.w * scale, nh = vb.h * scale;
        return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const selectedActor = (isUseCase && selectedId) ? data.actors.find(a => a.id === selectedId) : null;
  const actorsFullyHidden = isUseCase && hideAllActors;
  const actorFilterActive = isUseCase && !!selectedActor && !hideAllActors;

  // Compute connection lines with IDs
  const connectionLines = useMemo(() => {
    const lines = [];
    for (const c of data.connections) {
      if (actorsFullyHidden) continue;
      if (actorFilterActive && c.actorId !== selectedActor.id) continue;
      const actor = data.actors.find(a => a.id === c.actorId);
      const uc = data.useCases.find(u => u.id === c.useCaseId);
      if (actor && uc) {
        const connType = c.type || "association";
        const dashed = connType !== "association";
        const label = c.label || (dashed ? `<<${connType}>>` : "");
        lines.push({ key: `c-${c.id || c.actorId + c.useCaseId}`, id: c.id, dataType: "connection", fromX: actor.x, fromY: actor.y, toX: uc.x, toY: uc.y, label, rawLabel: c.label || "", connType, dashed });
      }
    }
    for (const r of (data.relationships || [])) {
      const from = data.useCases.find(u => u.id === r.fromUseCaseId);
      const to = data.useCases.find(u => u.id === r.toUseCaseId);
      if (from && to) {
        const connType = r.type || "association";
        const dashed = connType !== "association";
        const label = r.label || (dashed ? `<<${connType}>>` : "");
        lines.push({ key: `r-${r.id}`, id: r.id, dataType: "relationship", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, label, rawLabel: r.label || "", connType, dashed });
      }
    }
    return lines;
  }, [data, actorsFullyHidden, actorFilterActive, selectedActor]);

  // Inline editing position
  const editPos = useMemo(() => {
    if (!editingId || !svgRef.current) return null;
    const el = data.actors.find(a => a.id === editingId) || data.useCases.find(u => u.id === editingId) || (data.boundaries || []).find(b => b.id === editingId);
    if (!el) return null;
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = el.x + (el.width ? el.width / 2 : 0); pt.y = el.y + (el.height ? 20 : 0);
    const screen = pt.matrixTransform(svg.getScreenCTM());
    const rect = svg.getBoundingClientRect();
    return { left: screen.x - rect.left - 50, top: screen.y - rect.top - 10 };
  }, [editingId, data, viewBox]);

  const hasElements = data.actors.length > 0 || data.useCases.length > 0;

  return (
    <div className="usecase-svg-wrapper">
      <svg ref={svgRef} className="usecase-svg"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        onMouseDown={handleCanvasMouseDown}
      >
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-muted)" />
          </marker>
        </defs>

        {/* Boundaries */}
        {(data.boundaries || []).map(b => {
          const BShape = isComponent ? PackageBoundaryShape : isDeploy ? DeploymentBoundaryShape : SystemBoundaryShape;
          return <BShape key={b.id} boundary={b}
            onMouseDown={e => handleElementMouseDown(e, b.id, "boundary")}
            onDoubleClick={e => handleDoubleClick(e, b.id, "boundary")} />;
        })}

        {/* Connection lines */}
        {connectionLines.map(cl => (
          <ConnectionLine key={cl.key} fromX={cl.fromX} fromY={cl.fromY} toX={cl.toX} toY={cl.toY}
            label={cl.label} dashed={cl.dashed} selected={selectedId === cl.id}
            onClick={(e) => { e.stopPropagation(); setSelectedId(cl.id); setConnTypeMenu(null); setEditingConn(null); }}
            onDoubleClick={(e) => handleConnDoubleClick(e, cl)} />
        ))}

        {/* Temp connection line while drawing */}
        {connecting && (() => {
          const from = getElementCenter(connecting.fromId, connecting.fromType);
          return from ? <line x1={from.x} y1={from.y} x2={connecting.mouseX} y2={connecting.mouseY} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4,4" opacity={0.7} /> : null;
        })()}

        {/* Actors / Nodes / Interfaces */}
        {data.actors
          .filter(a => {
            if (actorsFullyHidden) return false;
            if (actorFilterActive) return a.id === selectedActor.id;
            return true;
          })
          .map(a => {
          const props = { key: a.id, actor: a, selected: selectedId === a.id,
            onMouseDown: e => { handleElementMouseDown(e, a.id, "actor"); },
            onConnectStart: handleConnectStart,
            onDoubleClick: e => handleDoubleClick(e, a.id, "actor") };
          return isComponent ? <InterfaceShape {...props} />
            : isDeploy ? <DeploymentNodeShape {...props} />
            : <ActorShape {...props} />;
        })}

        {/* Use cases / Components */}
        {data.useCases.map(uc => {
          const props = { key: uc.id, useCase: uc, selected: selectedId === uc.id,
            onMouseDown: e => { handleElementMouseDown(e, uc.id, "usecase"); },
            onConnectStart: handleConnectStart,
            onDoubleClick: e => handleDoubleClick(e, uc.id, "usecase") };
          return isComponent ? <ComponentBoxShape {...props} />
            : isDeploy ? <DeploymentComponentShape {...props} />
            : <UseCaseShape {...props} />;
        })}

        {/* Empty state */}
        {!hasElements && (
          <text x={viewBox.x + viewBox.w / 2} y={viewBox.y + viewBox.h / 2} textAnchor="middle" fontSize="14" fill="var(--text-muted)" fontStyle="italic">{t(isComponent ? "component.empty" : isDeploy ? "deployment.empty" : "usecase.empty")}</text>
        )}
      </svg>

      {/* Inline name editor */}
      {editingId && editPos && (
        <input className="usecase-name-input" style={{ left: editPos.left, top: editPos.top }}
          value={editingValue} onChange={e => setEditingValue(e.target.value)}
          onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingId(null); }}
          autoFocus />
      )}

      {/* Connection type picker (shown when creating any new connection) */}
      {connTypeMenu && (
        <div className="usecase-rel-type-select" style={{ left: connTypeMenu.x - svgRef.current?.getBoundingClientRect().left, top: connTypeMenu.y - svgRef.current?.getBoundingClientRect().top }}>
          <button onClick={() => createConnection("association")}>{isDeploy ? "Communication Path" : "Association"}</button>
          {isDeploy ? (
            <>
              <button onClick={() => createConnection("dependency")}>&lt;&lt;dependency&gt;&gt;</button>
              <button onClick={() => createConnection("deploy")}>&lt;&lt;deploy&gt;&gt;</button>
            </>
          ) : (
            <>
              <button onClick={() => createConnection("extend")}>&lt;&lt;extend&gt;&gt;</button>
              <button onClick={() => createConnection("include")}>&lt;&lt;include&gt;&gt;</button>
            </>
          )}
        </div>
      )}

      {/* Connection edit popup (shown on double-click) */}
      {editingConn && (
        <div className="usecase-conn-edit" style={{ left: editingConn.x - 80, top: editingConn.y - 120 }}>
          <div className="usecase-conn-edit-row">
            <label>{t(isDeploy ? "deployment.relationType" : "usecase.relationType")}</label>
            <select value={editingConn.connType} onChange={e => setEditingConn(ec => ({ ...ec, connType: e.target.value }))}>
              <option value="association">{isDeploy ? "Communication Path" : "Association"}</option>
              {isDeploy ? (
                <>
                  <option value="dependency">&lt;&lt;dependency&gt;&gt;</option>
                  <option value="deploy">&lt;&lt;deploy&gt;&gt;</option>
                </>
              ) : (
                <>
                  <option value="extend">&lt;&lt;extend&gt;&gt;</option>
                  <option value="include">&lt;&lt;include&gt;&gt;</option>
                </>
              )}
            </select>
          </div>
          <div className="usecase-conn-edit-row">
            <label>{t("usecase.connectionLabel")}</label>
            <input value={editingConn.label} onChange={e => setEditingConn(ec => ({ ...ec, label: e.target.value }))}
              placeholder={t("usecase.connectionLabel")}
              onKeyDown={e => { if (e.key === "Enter") commitConnEdit(); if (e.key === "Escape") setEditingConn(null); }} />
          </div>
          <div className="usecase-conn-edit-actions">
            <button className="usecase-conn-edit-delete" onClick={deleteEditingConn}><Trash2 size={12} /> {t("usecase.toolDelete")}</button>
            <button className="usecase-conn-edit-done" onClick={commitConnEdit}>{t("common.save")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagramTabContent({ activeTab, data, setData, selectedId, setSelectedId, tool, setTool, showMermaid, setShowMermaid, saving, handleSave, onOpenChange, devFocus, setDevFocus, t }) {
  const prefix = activeTab; // "usecase", "deployment", or "component"
  const mermaidCode = useMemo(() => generateUseCaseMermaid(data), [data]);
  const [hideAllActors, setHideAllActors] = useState(false);

  const addActor = () => {
    const id = crypto.randomUUID().slice(0, 8);
    const defaultName = activeTab === "component" ? "Interface" : activeTab === "usecase" ? "Actor" : "Node";
    setData(d => ({ ...d, actors: [...d.actors, { id, name: defaultName, x: 80, y: d.actors.length * 130 + 100 }] }));
    setSelectedId(id);
  };

  const addUseCase = () => {
    const id = crypto.randomUUID().slice(0, 8);
    const defaultName = activeTab === "component" ? "Component" : activeTab === "usecase" ? "Use Case" : "Component";
    const firstB = (data.boundaries || [])[0];
    const bx = firstB ? firstB.x + 100 : 350;
    const by = firstB ? firstB.y + 80 : 100;
    setData(d => ({ ...d, useCases: [...d.useCases, { id, name: defaultName, x: bx + (d.useCases.length % 2) * 200, y: by + Math.floor(d.useCases.length / 2) * 110 }] }));
    setSelectedId(id);
  };

  const addBoundary = () => {
    const id = crypto.randomUUID().slice(0, 8);
    const defaultName = activeTab === "component" ? "Package" : activeTab === "usecase" ? "System" : "Environment";
    const count = (data.boundaries || []).length;
    setData(d => ({
      ...d,
      boundaries: [...(d.boundaries || []), {
        id, name: `${defaultName} ${count + 1}`,
        x: 220 + count * 40, y: 30 + count * 30, width: 500, height: 420
      }]
    }));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setData(d => ({
      ...d,
      actors: d.actors.filter(a => a.id !== selectedId),
      useCases: d.useCases.filter(u => u.id !== selectedId),
      connections: d.connections.filter(c => c.actorId !== selectedId && c.useCaseId !== selectedId),
      relationships: (d.relationships || []).filter(r => r.fromUseCaseId !== selectedId && r.toUseCaseId !== selectedId && r.id !== selectedId),
      boundaries: (d.boundaries || []).filter(b => b.id !== selectedId),
    }));
    setSelectedId(null);
  };

  const setFocusOnSelected = () => {
    if (!selectedId) return;
    const actor = data.actors.find(a => a.id === selectedId);
    const useCase = data.useCases.find(u => u.id === selectedId);
    const el = actor || useCase;
    if (el) {
      setDevFocus({ name: el.name, diagramType: activeTab });
    }
  };

  return (
    <>
      <div className="usecase-canvas-container">
        <div className="usecase-toolbar">
          <div className="usecase-toolbar-label">UML</div>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><MousePointer size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t(`${prefix}.toolSelect`)}</Tooltip.Content></Tooltip.Root>
          <div className="usecase-toolbar-separator" />
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={addActor}>{activeTab === "component" ? <Circle size={16} /> : activeTab === "deployment" ? <Box size={16} /> : <Users size={16} />}</button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t(`${prefix}.toolActor`)}</Tooltip.Content></Tooltip.Root>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={addUseCase}>{activeTab === "component" ? <Package size={16} /> : activeTab === "deployment" ? <Package size={16} /> : <Circle size={16} />}</button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t(`${prefix}.toolUseCase`)}</Tooltip.Content></Tooltip.Root>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={addBoundary}><Hexagon size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t(`${prefix}.toolBoundary`)}</Tooltip.Content></Tooltip.Root>
          {activeTab === "usecase" && (
            <Tooltip.Root><Tooltip.Trigger asChild>
              <button className={hideAllActors ? "active" : ""} onClick={() => setHideAllActors(v => !v)}><UserX size={16} /></button>
            </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("usecase.toolHideActors")}</Tooltip.Content></Tooltip.Root>
          )}
          <div className="usecase-toolbar-separator" />
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={deleteSelected} disabled={!selectedId}><Trash2 size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t(`${prefix}.toolDelete`)}</Tooltip.Content></Tooltip.Root>
          <div className="usecase-toolbar-separator" />
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={setFocusOnSelected} disabled={!selectedId} className={devFocus ? "active" : ""}><Crosshair size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("diagram.setFocus")}</Tooltip.Content></Tooltip.Root>
        </div>
        <UseCaseCanvas data={data} setData={setData} selectedId={selectedId} setSelectedId={setSelectedId} tool={tool} setTool={setTool} t={t} diagramType={activeTab} hideAllActors={hideAllActors} />
      </div>

      {showMermaid && mermaidCode && (
        <div className="usecase-mermaid-panel">{mermaidCode}</div>
      )}

      <div className="usecase-footer">
        <div className="usecase-footer-left">
          <button className="usecase-mermaid-toggle" onClick={() => setShowMermaid(s => !s)}>
            <Terminal size={12} />
            {t(`${prefix}.mermaidView`)}
          </button>
        </div>
        <div className="modal-actions" style={{ marginTop: 0 }}>
          <button className="btn-secondary" onClick={() => onOpenChange(false)}>{t("common.cancel")}</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            <Save size={14} />
            {t("common.save")}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Activity Diagram Shape Components ───────────────────────

function ActivityStartShape({ node, selected, onMouseDown, onConnectStart }) {
  return (
    <g onMouseDown={onMouseDown}>
      <circle cx={node.x} cy={node.y} r={14} fill="#1e293b" stroke={selected ? "var(--accent)" : "#475569"} strokeWidth={selected ? 2.5 : 1.5} />
      <circle className="uc-connection-point" cx={node.x} cy={node.y + 18} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
    </g>
  );
}

function ActivityEndShape({ node, selected, onMouseDown, onConnectStart }) {
  return (
    <g onMouseDown={onMouseDown}>
      <circle cx={node.x} cy={node.y} r={16} fill="none" stroke={selected ? "var(--accent)" : "#475569"} strokeWidth={2.5} />
      <circle cx={node.x} cy={node.y} r={10} fill="#1e293b" />
      <circle className="uc-connection-point" cx={node.x} cy={node.y - 20} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
    </g>
  );
}

function ActivityActionShape({ node, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const sz = pickSize(node, ACTIVITY_ACTION_SIZES);
  const w = sz.w, h = sz.h;
  const lx = node.x - w / 2, ty = node.y - h / 2;
  const lines = wrapText(node.name || "Action", sz.wrap);
  return (
    <g className={`uc-usecase-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <rect x={lx} y={ty} width={w} height={h} rx={12} fill="#dbeafe" stroke={selected ? "var(--accent)" : "#3b82f6"} strokeWidth={selected ? 2.5 : 1.5} />
      {lines.map((l, i) => (
        <text key={i} x={node.x} y={ty + 16 + i * 14} textAnchor="middle" fontSize="11" fill="#1e40af" fontWeight="500" dominantBaseline="central">{l}</text>
      ))}
      <circle className="uc-connection-point" cx={lx} cy={node.y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
      <circle className="uc-connection-point" cx={lx + w} cy={node.y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
      <circle className="uc-connection-point" cx={node.x} cy={ty} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
      <circle className="uc-connection-point" cx={node.x} cy={ty + h} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
    </g>
  );
}

function ActivityDecisionShape({ node, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const dsz = pickSize(node, ACTIVITY_DECISION_SIZES);
  const s = dsz.s;
  const points = `${node.x},${node.y - s} ${node.x + s},${node.y} ${node.x},${node.y + s} ${node.x - s},${node.y}`;
  const decisionLines = node.name ? wrapText(node.name, dsz.wrap) : [];
  return (
    <g className={`uc-usecase-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <polygon points={points} fill="#fef3c7" stroke={selected ? "var(--accent)" : "#f59e0b"} strokeWidth={selected ? 2.5 : 1.5} />
      {decisionLines.map((l, i) => (
        <text key={i} x={node.x} y={node.y + 4 + (i - (decisionLines.length - 1) / 2) * 12} textAnchor="middle" fontSize="10" fill="#92400e" fontWeight="500">{l}</text>
      ))}
      <circle className="uc-connection-point" cx={node.x} cy={node.y - s - 4} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
      <circle className="uc-connection-point" cx={node.x + s + 4} cy={node.y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
      <circle className="uc-connection-point" cx={node.x} cy={node.y + s + 4} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
      <circle className="uc-connection-point" cx={node.x - s - 4} cy={node.y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
    </g>
  );
}

function ActivityForkJoinShape({ node, selected, onMouseDown, onConnectStart }) {
  const w = 100, h = 6;
  return (
    <g onMouseDown={onMouseDown}>
      <rect x={node.x - w / 2} y={node.y - h / 2} width={w} height={h} rx={2} fill="#1e293b" stroke={selected ? "var(--accent)" : "#475569"} strokeWidth={selected ? 2 : 1} />
      <circle className="uc-connection-point" cx={node.x} cy={node.y - h / 2 - 4} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
      <circle className="uc-connection-point" cx={node.x} cy={node.y + h / 2 + 4} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, node.id); }} />
    </g>
  );
}

// ─── Activity Canvas ─────────────────────────────────────────

function ActivityCanvas({ data, setData, selectedId, setSelectedId, tool, setTool, t }) {
  const svgRef = useRef(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1800, h: 1000 });
  const [dragging, setDragging] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState("");

  const getNodeCenter = (nodeId) => {
    const n = data.nodes.find(nd => nd.id === nodeId);
    return n ? { x: n.x, y: n.y } : null;
  };

  const svgPoint = (e) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  const handleCanvasMouseDown = (e) => {
    if (e.target === svgRef.current || e.target.classList.contains("activity-bg")) {
      setSelectedId(null);
      if (tool === "select") {
        const p = svgPoint(e);
        setDragging({ type: "pan", startX: p.x, startY: p.y, origX: viewBox.x, origY: viewBox.y });
      }
    }
  };

  const handleNodeMouseDown = (e, nodeId) => {
    e.stopPropagation();
    setSelectedId(nodeId);
    if (tool === "select") {
      const p = svgPoint(e);
      const node = data.nodes.find(n => n.id === nodeId);
      if (node) setDragging({ type: "node", id: nodeId, startX: p.x, startY: p.y, origX: node.x, origY: node.y });
    }
  };

  const handleConnectStart = (e, nodeId) => {
    e.stopPropagation();
    const p = svgPoint(e);
    setConnecting({ fromId: nodeId, mouseX: p.x, mouseY: p.y });
  };

  const handleMouseMove = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const p = svgPoint(e);
    if (dragging) {
      if (dragging.type === "pan") {
        setViewBox(v => ({ ...v, x: dragging.origX - (p.x - dragging.startX), y: dragging.origY - (p.y - dragging.startY) }));
      } else if (dragging.type === "node") {
        setData(d => ({ ...d, nodes: d.nodes.map(n => n.id === dragging.id ? { ...n, x: dragging.origX + (p.x - dragging.startX), y: dragging.origY + (p.y - dragging.startY) } : n) }));
      }
    }
    if (connecting) {
      setConnecting(c => ({ ...c, mouseX: p.x, mouseY: p.y }));
    }
  }, [dragging, connecting]);

  const handleMouseUp = useCallback((e) => {
    if (connecting) {
      const svg = svgRef.current;
      const p = svgPoint(e);
      // Find target node under mouse
      let targetId = null;
      for (const node of data.nodes) {
        const dx = p.x - node.x, dy = p.y - node.y;
        if (Math.sqrt(dx * dx + dy * dy) < 40 && node.id !== connecting.fromId) {
          targetId = node.id;
          break;
        }
      }
      if (targetId) {
        const id = crypto.randomUUID().slice(0, 8);
        setData(d => ({ ...d, transitions: [...d.transitions, { id, fromNodeId: connecting.fromId, toNodeId: targetId }] }));
      }
      setConnecting(null);
    }
    setDragging(null);
  }, [connecting, data.nodes]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("mousemove", handleMouseMove);
    svg.addEventListener("mouseup", handleMouseUp);
    return () => { svg.removeEventListener("mousemove", handleMouseMove); svg.removeEventListener("mouseup", handleMouseUp); };
  }, [handleMouseMove, handleMouseUp]);

  // Wheel zoom
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e) => {
      e.preventDefault();
      const scale = e.deltaY > 0 ? 1.1 : 0.9;
      const p = svgPoint(e);
      setViewBox(v => {
        const nw = v.w * scale, nh = v.h * scale;
        return { x: p.x - (p.x - v.x) * scale, y: p.y - (p.y - v.y) * scale, w: nw, h: nh };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // Delete key
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Delete" && selectedId && !editingId) {
        setData(d => ({
          ...d,
          nodes: d.nodes.filter(n => n.id !== selectedId),
          transitions: d.transitions.filter(t => t.fromNodeId !== selectedId && t.toNodeId !== selectedId),
        }));
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, editingId]);

  const handleDoubleClick = (e, nodeId) => {
    const node = data.nodes.find(n => n.id === nodeId);
    if (node && (node.type === "action" || node.type === "decision")) {
      setEditingId(nodeId);
      setEditingValue(node.name);
    }
  };

  const commitEdit = () => {
    if (editingId) {
      setData(d => ({ ...d, nodes: d.nodes.map(n => n.id === editingId ? { ...n, name: editingValue } : n) }));
      setEditingId(null);
    }
  };

  const hasElements = data.nodes.length > 0;

  return (
    <svg ref={svgRef} className="uc-canvas" viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
      onMouseDown={handleCanvasMouseDown}>
      <rect className="activity-bg" x={viewBox.x} y={viewBox.y} width={viewBox.w} height={viewBox.h} fill="transparent" />
      <defs>
        <marker id="act-arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="var(--text-muted)" />
        </marker>
      </defs>

      {/* Transitions */}
      {data.transitions.map(tr => {
        const from = getNodeCenter(tr.fromNodeId);
        const to = getNodeCenter(tr.toNodeId);
        if (!from || !to) return null;
        const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
        return (
          <g key={tr.id}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke="transparent" strokeWidth={14} style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); setSelectedId(tr.id); }} />
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke={selectedId === tr.id ? "var(--accent)" : "var(--text-muted)"} strokeWidth={selectedId === tr.id ? 2.5 : 1.5}
              markerEnd="url(#act-arrowhead)" pointerEvents="none" />
            {tr.label && (
              <>
                <rect x={mx - tr.label.length * 3.5 - 4} y={my - 10} width={tr.label.length * 7 + 8} height={16} rx={3} fill="var(--bg-secondary)" stroke="var(--border)" strokeWidth={0.5} />
                <text x={mx} y={my + 1} textAnchor="middle" fontSize="10" fill="var(--text-secondary)" dominantBaseline="central">{tr.label}</text>
              </>
            )}
          </g>
        );
      })}

      {/* Temp connection line */}
      {connecting && (() => {
        const from = getNodeCenter(connecting.fromId);
        return from ? <line x1={from.x} y1={from.y} x2={connecting.mouseX} y2={connecting.mouseY} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4,4" opacity={0.7} /> : null;
      })()}

      {/* Nodes */}
      {data.nodes.map(node => {
        const props = { key: node.id, node, selected: selectedId === node.id, onMouseDown: e => handleNodeMouseDown(e, node.id), onConnectStart: handleConnectStart };
        switch (node.type) {
          case "start": return <ActivityStartShape {...props} />;
          case "end": return <ActivityEndShape {...props} />;
          case "action": return <ActivityActionShape {...props} onDoubleClick={e => handleDoubleClick(e, node.id)} />;
          case "decision": return <ActivityDecisionShape {...props} onDoubleClick={e => handleDoubleClick(e, node.id)} />;
          case "fork": case "join": return <ActivityForkJoinShape {...props} />;
          default: return null;
        }
      })}

      {/* Inline edit */}
      {editingId && (() => {
        const node = data.nodes.find(n => n.id === editingId);
        if (!node) return null;
        return (
          <foreignObject x={node.x - 70} y={node.y - 12} width={140} height={24}>
            <input type="text" value={editingValue} onChange={e => setEditingValue(e.target.value)}
              onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingId(null); }}
              autoFocus style={{ width: "100%", fontSize: 11, textAlign: "center", background: "var(--bg-primary)", border: "1px solid var(--accent)", borderRadius: 4, padding: "2px 4px", color: "var(--text-primary)" }} />
          </foreignObject>
        );
      })()}

      {/* Empty state */}
      {!hasElements && (
        <text x={viewBox.x + viewBox.w / 2} y={viewBox.y + viewBox.h / 2} textAnchor="middle" fontSize="14" fill="var(--text-muted)" fontStyle="italic">{t("activity.empty")}</text>
      )}
    </svg>
  );
}

// ─── Activity Tab Content ────────────────────────────────────

function ActivityTabContent({ projectId, userId, activityList, setActivityList, activeActivityId, setActiveActivityId, activityData, setActivityData, saving, handleSave, onOpenChange, t }) {
  const [showMermaid, setShowMermaid] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tool, setTool] = useState("select");
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const loadActivity = async (id) => {
    try {
      const data = await api(`/projects/${projectId}/activities/${id}?userId=${userId}`);
      setActiveActivityId(id);
      setActivityData(data);
    } catch (err) {
      console.error("Failed to load activity diagram:", err);
    }
  };

  const createActivity = async () => {
    if (!newName.trim()) return;
    try {
      const { id } = await api(`/projects/${projectId}/activities`, { method: "POST", body: JSON.stringify({ userId, name: newName.trim() }) });
      setActivityList(prev => [...prev, { id, name: newName.trim() }]);
      setNewName("");
      loadActivity(id);
    } catch (err) {
      console.error("Failed to create activity diagram:", err);
    }
  };

  const deleteActivity = async (id) => {
    try {
      await api(`/projects/${projectId}/activities/${id}?userId=${userId}`, { method: "DELETE" });
      setActivityList(prev => prev.filter(d => d.id !== id));
      if (activeActivityId === id) { setActiveActivityId(null); setActivityData(null); }
    } catch (err) {
      console.error("Failed to delete activity diagram:", err);
    }
  };

  const commitRename = async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    try {
      await api(`/projects/${projectId}/activities/${renamingId}`, { method: "PATCH", body: JSON.stringify({ userId, name: renameValue.trim() }) });
      setActivityList(prev => prev.map(d => d.id === renamingId ? { ...d, name: renameValue.trim() } : d));
      if (activeActivityId === renamingId && activityData) {
        setActivityData({ ...activityData, name: renameValue.trim() });
      }
    } catch (err) {
      console.error("Failed to rename activity diagram:", err);
    }
    setRenamingId(null);
  };

  // Editor view — mermaid code (must be before any conditional return to satisfy Rules of Hooks)
  const mermaidCode = useMemo(() => activityData ? generateActivityMermaid(activityData) : "", [activityData]);

  // List view — no active diagram
  if (!activeActivityId || !activityData) {
    return (
      <div className="activity-list-container">
        <div className="activity-create-row">
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") createActivity(); }}
            placeholder={t("activity.diagramName")} className="activity-name-input" />
          <button className="btn-primary" onClick={createActivity} disabled={!newName.trim()}>
            <Plus size={14} /> {t("activity.createNew")}
          </button>
        </div>
        {activityList.length === 0 && <div className="activity-empty-hint">{t("activity.empty")}</div>}
        {activityList.map(d => (
          <div key={d.id} className="activity-list-item">
            {renamingId === d.id ? (
              <input type="text" value={renameValue} onChange={e => setRenameValue(e.target.value)}
                onBlur={commitRename} onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenamingId(null); }}
                autoFocus className="activity-name-input" />
            ) : (
              <span className="activity-list-name" onClick={() => loadActivity(d.id)}>{d.name}</span>
            )}
            <div className="activity-list-actions">
              <button onClick={() => { setRenamingId(d.id); setRenameValue(d.name); }} title={t("activity.rename")}><Pencil size={12} /></button>
              <button className="danger" onClick={() => deleteActivity(d.id)} title={t("activity.delete")}><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
        <div className="usecase-actions" style={{ marginTop: 16 }}>
          <button className="btn-secondary" onClick={() => onOpenChange(false)}><X size={14} /> {t("common.close")}</button>
        </div>
      </div>
    );
  }

  const addNode = (type, name = "") => {
    const id = crypto.randomUUID().slice(0, 8);
    const y = activityData.nodes.length * 90 + 80;
    setActivityData(d => ({ ...d, nodes: [...d.nodes, { id, type, name, x: 300, y }] }));
    setSelectedId(id);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setActivityData(d => ({
      ...d,
      nodes: d.nodes.filter(n => n.id !== selectedId),
      transitions: d.transitions.filter(t => t.fromNodeId !== selectedId && t.toNodeId !== selectedId && t.id !== selectedId),
    }));
    setSelectedId(null);
  };

  const saveActivity = async () => {
    try {
      await api(`/projects/${projectId}/activities/${activeActivityId}`, {
        method: "PUT",
        body: JSON.stringify({ userId, data: activityData }),
      });
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save activity diagram:", err);
    }
  };

  return (
    <>
      <div className="usecase-canvas-container">
        <div className="usecase-toolbar">
          <div className="usecase-toolbar-label">UML</div>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><MousePointer size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("activity.toolSelect")}</Tooltip.Content></Tooltip.Root>
          <div className="usecase-toolbar-separator" />
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={() => addNode("start")}><Circle size={16} fill="currentColor" /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("activity.toolStart")}</Tooltip.Content></Tooltip.Root>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={() => addNode("end")}><CircleCheck size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("activity.toolEnd")}</Tooltip.Content></Tooltip.Root>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={() => addNode("action", "Action")}><Box size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("activity.toolAction")}</Tooltip.Content></Tooltip.Root>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={() => addNode("decision")}><Hexagon size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("activity.toolDecision")}</Tooltip.Content></Tooltip.Root>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={() => addNode("fork")}><Minus size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("activity.toolFork")}</Tooltip.Content></Tooltip.Root>
          <div className="usecase-toolbar-separator" />
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={deleteSelected} disabled={!selectedId}><Trash2 size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("activity.toolDelete")}</Tooltip.Content></Tooltip.Root>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <ActivityCanvas data={activityData} setData={setActivityData}
            selectedId={selectedId} setSelectedId={setSelectedId}
            tool={tool} setTool={setTool} t={t} />
          {showMermaid && (
            <div className="usecase-mermaid-panel">
              <pre>{mermaidCode || t("activity.empty")}</pre>
            </div>
          )}
        </div>
      </div>
      <div className="usecase-actions">
        <button className="usecase-mermaid-toggle" onClick={() => setShowMermaid(m => !m)}>
          {showMermaid ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {t("activity.mermaidView")}
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn-secondary" onClick={() => { setActiveActivityId(null); setActivityData(null); }}>
          <ChevronLeft size={14} /> {t("activity.backToList")}
        </button>
        <button className="btn-primary" onClick={saveActivity} disabled={saving}>
          <Save size={14} /> {saving ? "..." : t("common.save")}
        </button>
      </div>
    </>
  );
}

// ─── ER Diagram Components ───────────────────────────────────

function EREntityShape({ entity, selected, onMouseDown, onConnectStart, onDoubleClick }) {
  const headerH = 28;
  const attrH = 20;
  const w = pickSize(entity, ER_SIZES).w;
  const h = headerH + Math.max(entity.attributes.length, 1) * attrH + 8;
  const lx = entity.x - w / 2;
  const ty = entity.y - h / 2;

  return (
    <g className={`uc-usecase-group${selected ? " selected" : ""}`} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <rect x={lx} y={ty} width={w} height={h} rx={4} fill="#f8fafc" stroke={selected ? "var(--accent)" : "#64748b"} strokeWidth={selected ? 2.5 : 1.5} />
      <rect x={lx} y={ty} width={w} height={headerH} rx={4} fill="#1e40af" stroke="none" />
      <rect x={lx} y={ty + headerH - 4} width={w} height={4} fill="#1e40af" stroke="none" />
      <text x={entity.x} y={ty + headerH / 2 + 1} textAnchor="middle" fontSize="12" fill="white" fontWeight="600" dominantBaseline="central">{entity.name || "Entity"}</text>
      <line x1={lx} y1={ty + headerH} x2={lx + w} y2={ty + headerH} stroke="#cbd5e1" strokeWidth={1} />
      {(entity.attributes || []).map((attr, i) => {
        const ay = ty + headerH + 4 + i * attrH;
        const prefix = attr.pk ? "\u{1F511}" : attr.fk ? "\u{1F517}" : "";
        return (
          <g key={i}>
            <text x={lx + 8} y={ay + attrH / 2} fontSize="10" fill="#475569" dominantBaseline="central" fontFamily="monospace">
              {prefix}{prefix ? " " : ""}{attr.name} : {attr.type}
            </text>
          </g>
        );
      })}
      {entity.attributes.length === 0 && (
        <text x={entity.x} y={ty + headerH + 16} textAnchor="middle" fontSize="10" fill="#94a3b8" dominantBaseline="central" fontStyle="italic">no attributes</text>
      )}
      <circle className="uc-connection-point" cx={lx} cy={entity.y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, entity.id); }} />
      <circle className="uc-connection-point" cx={lx + w} cy={entity.y} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, entity.id); }} />
      <circle className="uc-connection-point" cx={entity.x} cy={ty} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, entity.id); }} />
      <circle className="uc-connection-point" cx={entity.x} cy={ty + h} r={6} fill="var(--accent)" stroke="white" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e, entity.id); }} />
    </g>
  );
}

function ERCanvas({ data, setData, selectedId, setSelectedId, tool, setTool, t }) {
  const svgRef = useRef(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1800, h: 1000 });
  const [dragging, setDragging] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  const toSVG = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM().inverse();
    const svgPt = pt.matrixTransform(ctm);
    return { x: svgPt.x, y: svgPt.y };
  }, []);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    setViewBox(vb => {
      const svg = svgRef.current;
      if (!svg) return vb;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
      const nw = vb.w * factor, nh = vb.h * factor;
      return { x: svgPt.x - (svgPt.x - vb.x) * factor, y: svgPt.y - (svgPt.y - vb.y) * factor, w: nw, h: nh };
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg) svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => { if (svg) svg.removeEventListener("wheel", handleWheel); };
  }, [handleWheel]);

  const handleSvgMouseDown = (e) => {
    if (e.target === svgRef.current || e.target.tagName === "rect" && e.target.classList.contains("canvas-bg")) {
      if (tool === "entity") {
        const pos = toSVG(e);
        const id = Math.random().toString(16).slice(2, 10);
        setData(d => ({ ...d, entities: [...d.entities, { id, name: "NewEntity", attributes: [], x: pos.x, y: pos.y }] }));
        setSelectedId(id);
        setTool("select");
        return;
      }
      setSelectedId(null);
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY, vx: viewBox.x, vy: viewBox.y };
    }
  };

  const handleMouseMove = (e) => {
    const pos = toSVG(e);
    setMousePos(pos);
    if (isPanning.current) {
      const svg = svgRef.current;
      if (!svg) return;
      const scale = viewBox.w / svg.clientWidth;
      setViewBox(vb => ({ ...vb, x: panStart.current.vx - (e.clientX - panStart.current.x) * scale, y: panStart.current.vy - (e.clientY - panStart.current.y) * scale }));
      return;
    }
    if (dragging) {
      setData(d => ({ ...d, entities: d.entities.map(n => n.id === dragging ? { ...n, x: pos.x, y: pos.y } : n) }));
    }
  };

  const handleMouseUp = () => {
    if (connecting && !isPanning.current) {
      const target = findEntityAt(data, mousePos);
      if (target && target.id !== connecting) {
        const id = Math.random().toString(16).slice(2, 10);
        setData(d => ({ ...d, relationships: [...d.relationships, { id, fromEntityId: connecting, toEntityId: target.id, fromCardinality: "1", toCardinality: "0..*", label: "" }] }));
      }
    }
    setDragging(null);
    setConnecting(null);
    isPanning.current = false;
  };

  const handleEntityMouseDown = (e, entityId) => {
    e.stopPropagation();
    setSelectedId(entityId);
    if (tool === "delete") {
      setData(d => ({ ...d, entities: d.entities.filter(n => n.id !== entityId), relationships: d.relationships.filter(r => r.fromEntityId !== entityId && r.toEntityId !== entityId) }));
      setSelectedId(null);
      return;
    }
    if (tool === "select") setDragging(entityId);
  };

  const handleConnectStart = (e, entityId) => {
    e.stopPropagation();
    setConnecting(entityId);
  };

  function findEntityAt(d, pos) {
    return d.entities.find(n => Math.abs(n.x - pos.x) < 100 && Math.abs(n.y - pos.y) < 60);
  }

  // Draw relationship lines
  const relLines = (data.relationships || []).map(rel => {
    const fromE = data.entities.find(e => e.id === rel.fromEntityId);
    const toE = data.entities.find(e => e.id === rel.toEntityId);
    if (!fromE || !toE) return null;
    const isSelected = selectedId === rel.id;
    return (
      <g key={rel.id} onClick={(e) => { e.stopPropagation(); setSelectedId(rel.id); }}>
        <line x1={fromE.x} y1={fromE.y} x2={toE.x} y2={toE.y} stroke={isSelected ? "var(--accent)" : "#64748b"} strokeWidth={isSelected ? 2.5 : 1.5} />
        <text x={(fromE.x + toE.x) / 2} y={(fromE.y + toE.y) / 2 - 8} textAnchor="middle" fontSize="10" fill="#475569" fontWeight="500">{rel.label || ""}</text>
        <text x={fromE.x + (toE.x - fromE.x) * 0.15} y={fromE.y + (toE.y - fromE.y) * 0.15 - 8} textAnchor="middle" fontSize="9" fill="#1e40af" fontWeight="600">{rel.fromCardinality}</text>
        <text x={fromE.x + (toE.x - fromE.x) * 0.85} y={fromE.y + (toE.y - fromE.y) * 0.85 - 8} textAnchor="middle" fontSize="9" fill="#1e40af" fontWeight="600">{rel.toCardinality}</text>
      </g>
    );
  });

  return (
    <svg ref={svgRef} viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} className="usecase-canvas"
      onMouseDown={handleSvgMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <rect className="canvas-bg" x={viewBox.x} y={viewBox.y} width={viewBox.w} height={viewBox.h} fill="transparent" />
      {relLines}
      {connecting && (() => {
        const from = data.entities.find(n => n.id === connecting);
        return from ? <line x1={from.x} y1={from.y} x2={mousePos.x} y2={mousePos.y} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="6 3" /> : null;
      })()}
      {data.entities.map(entity => (
        <EREntityShape key={entity.id} entity={entity} selected={selectedId === entity.id}
          onMouseDown={e => handleEntityMouseDown(e, entity.id)}
          onConnectStart={handleConnectStart}
          onDoubleClick={() => { setSelectedId(entity.id); }}
        />
      ))}
    </svg>
  );
}

function ERTabContent({ projectId, userId, erList, setERList, activeERId, setActiveERId, erData, setERData, saving, handleSave, onOpenChange, t }) {
  const [showMermaid, setShowMermaid] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tool, setTool] = useState("select");
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameName, setRenameName] = useState("");

  const loadER = async (id) => {
    try {
      const data = await api(`/projects/${projectId}/er-diagrams/${id}?userId=${userId}`);
      setActiveERId(id);
      setERData(data);
      setSelectedId(null);
      setTool("select");
    } catch { /* ignore */ }
  };

  const createER = async () => {
    if (!newName.trim()) return;
    try {
      const { id } = await api(`/projects/${projectId}/er-diagrams`, {
        method: "POST",
        body: JSON.stringify({ userId, name: newName.trim() }),
      });
      setERList(l => [...l, { id, name: newName.trim() }]);
      setNewName("");
      setShowCreate(false);
      loadER(id);
    } catch { /* ignore */ }
  };

  const deleteER = async (id) => {
    try {
      await api(`/projects/${projectId}/er-diagrams/${id}?userId=${userId}`, { method: "DELETE" });
      setERList(l => l.filter(d => d.id !== id));
      if (activeERId === id) { setActiveERId(null); setERData(null); }
    } catch { /* ignore */ }
  };

  const renameER = async () => {
    if (!renameName.trim() || !renameTarget) return;
    try {
      await api(`/projects/${projectId}/er-diagrams/${renameTarget}`, {
        method: "PATCH",
        body: JSON.stringify({ userId, name: renameName.trim() }),
      });
      setERList(l => l.map(d => d.id === renameTarget ? { ...d, name: renameName.trim() } : d));
      if (activeERId === renameTarget && erData) setERData({ ...erData, name: renameName.trim() });
      setRenameTarget(null);
    } catch { /* ignore */ }
  };

  // Entity attribute editor
  const selectedEntity = erData && selectedId ? erData.entities.find(e => e.id === selectedId) : null;
  const selectedRel = erData && selectedId ? erData.relationships.find(r => r.id === selectedId) : null;

  const updateEntity = (field, value) => {
    setERData(d => ({ ...d, entities: d.entities.map(e => e.id === selectedId ? { ...e, [field]: value } : e) }));
  };

  const addAttribute = () => {
    setERData(d => ({
      ...d, entities: d.entities.map(e => e.id === selectedId
        ? { ...e, attributes: [...e.attributes, { name: "newField", type: "string" }] }
        : e)
    }));
  };

  const updateAttribute = (idx, field, value) => {
    setERData(d => ({
      ...d, entities: d.entities.map(e => e.id === selectedId
        ? { ...e, attributes: e.attributes.map((a, i) => i === idx ? { ...a, [field]: value } : a) }
        : e)
    }));
  };

  const removeAttribute = (idx) => {
    setERData(d => ({
      ...d, entities: d.entities.map(e => e.id === selectedId
        ? { ...e, attributes: e.attributes.filter((_, i) => i !== idx) }
        : e)
    }));
  };

  const updateRelationship = (field, value) => {
    setERData(d => ({ ...d, relationships: d.relationships.map(r => r.id === selectedId ? { ...r, [field]: value } : r) }));
  };

  const deleteRelationship = () => {
    setERData(d => ({ ...d, relationships: d.relationships.filter(r => r.id !== selectedId) }));
    setSelectedId(null);
  };

  const mermaidCode = erData ? generateERMermaid(erData) : "";

  // List view
  if (!activeERId || !erData) {
    return (
      <div className="activity-list-container" style={{ padding: "16px" }}>
        <div className="activity-create-row" style={{ marginBottom: 12 }}>
          {showCreate ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
              <input className="modal-input" style={{ flex: 1 }} placeholder={t("er.diagramName")} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && createER()} autoFocus />
              <button className="btn-primary" onClick={createER} disabled={!newName.trim()}><Plus size={14} /> {t("common.create")}</button>
              <button className="btn-secondary" onClick={() => { setShowCreate(false); setNewName(""); }}><X size={14} /></button>
            </div>
          ) : (
            <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={14} /> {t("er.createNew")}</button>
          )}
        </div>
        {erList.length === 0 && !showCreate && (
          <div className="skills-empty">{t("er.empty")}</div>
        )}
        {erList.map(d => (
          <div key={d.id} className="activity-list-item" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            {renameTarget === d.id ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                <input className="modal-input" style={{ flex: 1 }} value={renameName} onChange={e => setRenameName(e.target.value)} onKeyDown={e => e.key === "Enter" && renameER()} autoFocus />
                <button className="btn-primary" onClick={renameER}><Check size={14} /></button>
                <button className="btn-secondary" onClick={() => setRenameTarget(null)}><X size={14} /></button>
              </div>
            ) : (
              <>
                <span className="activity-list-name" style={{ cursor: "pointer", fontWeight: 500 }} onClick={() => loadER(d.id)}>{d.name}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="icon-btn-sm" onClick={() => { setRenameTarget(d.id); setRenameName(d.name); }} title={t("er.rename")}><Pencil size={12} /></button>
                  <button className="icon-btn-sm" onClick={() => deleteER(d.id)} title={t("er.delete")}><Trash2 size={12} /></button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    );
  }

  const addEntity = () => {
    const id = Math.random().toString(16).slice(2, 10);
    const y = erData.entities.length * 120 + 100;
    setERData(d => ({ ...d, entities: [...d.entities, { id, name: "NewEntity", attributes: [], x: 300, y }] }));
    setSelectedId(id);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    if (selectedEntity) {
      setERData(d => ({ ...d, entities: d.entities.filter(e => e.id !== selectedId), relationships: d.relationships.filter(r => r.fromEntityId !== selectedId && r.toEntityId !== selectedId) }));
    } else if (selectedRel) {
      deleteRelationship();
      return;
    }
    setSelectedId(null);
  };

  const saveER = async () => {
    try {
      await api(`/projects/${projectId}/er-diagrams/${activeERId}`, {
        method: "PUT",
        body: JSON.stringify({ userId, data: erData }),
      });
      onOpenChange(false);
    } catch { /* ignore */ }
  };

  // Editor view — matches Activity layout: vertical toolbar left, canvas center, props right, actions bottom
  return (
    <>
      <div className="usecase-canvas-container">
        <div className="usecase-toolbar">
          <div className="usecase-toolbar-label">ER</div>
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><MousePointer size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("er.toolSelect")}</Tooltip.Content></Tooltip.Root>
          <div className="usecase-toolbar-separator" />
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={addEntity}><Table size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("er.toolEntity")}</Tooltip.Content></Tooltip.Root>
          <div className="usecase-toolbar-separator" />
          <Tooltip.Root><Tooltip.Trigger asChild>
            <button onClick={deleteSelected} disabled={!selectedId}><Trash2 size={16} /></button>
          </Tooltip.Trigger><Tooltip.Content side="right" className="tooltip-content">{t("er.toolDelete")}</Tooltip.Content></Tooltip.Root>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <ERCanvas data={erData} setData={setERData} selectedId={selectedId} setSelectedId={setSelectedId} tool={tool} setTool={setTool} t={t} />
          {showMermaid && (
            <div className="usecase-mermaid-panel">
              <pre>{mermaidCode || t("er.empty")}</pre>
            </div>
          )}
        </div>

        {(selectedEntity || selectedRel) && (
          <div className="usecase-props-panel" style={{ width: 240, padding: 12, overflowY: "auto", borderLeft: "1px solid var(--border)" }}>
            {selectedEntity && (
              <>
                <label className="modal-label" style={{ fontSize: 11 }}>{t("er.entityName")}
                  <input className="modal-input" value={selectedEntity.name} onChange={e => updateEntity("name", e.target.value)} style={{ fontSize: 12 }} />
                </label>
                <div style={{ marginTop: 8, fontSize: 11, fontWeight: 600 }}>{t("er.addAttribute")}</div>
                {selectedEntity.attributes.map((attr, i) => (
                  <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                    <input className="modal-input" style={{ flex: 1, fontSize: 11, padding: "2px 4px" }} value={attr.name} onChange={e => updateAttribute(i, "name", e.target.value)} placeholder={t("er.attrName")} />
                    <input className="modal-input" style={{ width: 60, fontSize: 11, padding: "2px 4px" }} value={attr.type} onChange={e => updateAttribute(i, "type", e.target.value)} placeholder={t("er.attrType")} />
                    <label style={{ fontSize: 9, display: "flex", alignItems: "center", gap: 2 }}>
                      <input type="checkbox" checked={!!attr.pk} onChange={e => updateAttribute(i, "pk", e.target.checked || undefined)} /> {t("er.attrPK")}
                    </label>
                    <label style={{ fontSize: 9, display: "flex", alignItems: "center", gap: 2 }}>
                      <input type="checkbox" checked={!!attr.fk} onChange={e => updateAttribute(i, "fk", e.target.checked || undefined)} /> {t("er.attrFK")}
                    </label>
                    <button className="icon-btn-sm" onClick={() => removeAttribute(i)}><X size={10} /></button>
                  </div>
                ))}
                <button className="btn-secondary" onClick={addAttribute} style={{ marginTop: 6, fontSize: 11 }}>
                  <Plus size={12} /> {t("er.addAttribute")}
                </button>
              </>
            )}
            {selectedRel && (
              <>
                <label className="modal-label" style={{ fontSize: 11 }}>{t("er.relLabel")}
                  <input className="modal-input" value={selectedRel.label || ""} onChange={e => updateRelationship("label", e.target.value)} style={{ fontSize: 12 }} />
                </label>
                <label className="modal-label" style={{ fontSize: 11, marginTop: 8 }}>{t("er.relFrom")} {t("er.cardinality")}
                  <select className="modal-input" value={selectedRel.fromCardinality} onChange={e => updateRelationship("fromCardinality", e.target.value)} style={{ fontSize: 12 }}>
                    <option value="1">1 (exactly one)</option>
                    <option value="0..1">0..1 (zero or one)</option>
                    <option value="1..*">1..* (one or more)</option>
                    <option value="0..*">0..* (zero or more)</option>
                  </select>
                </label>
                <label className="modal-label" style={{ fontSize: 11, marginTop: 8 }}>{t("er.relTo")} {t("er.cardinality")}
                  <select className="modal-input" value={selectedRel.toCardinality} onChange={e => updateRelationship("toCardinality", e.target.value)} style={{ fontSize: 12 }}>
                    <option value="1">1 (exactly one)</option>
                    <option value="0..1">0..1 (zero or one)</option>
                    <option value="1..*">1..* (one or more)</option>
                    <option value="0..*">0..* (zero or more)</option>
                  </select>
                </label>
                <button className="btn-secondary" onClick={deleteRelationship} style={{ marginTop: 8, fontSize: 11, color: "#ef4444" }}>
                  <Trash2 size={12} /> {t("er.delete")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="usecase-actions">
        <button className="usecase-mermaid-toggle" onClick={() => setShowMermaid(m => !m)}>
          {showMermaid ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {t("er.mermaidView")}
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn-secondary" onClick={() => { setActiveERId(null); setERData(null); setSelectedId(null); }}>
          <ChevronLeft size={14} /> {t("er.backToList")}
        </button>
        <button className="btn-primary" onClick={saveER} disabled={saving}>
          <Save size={14} /> {saving ? "..." : t("common.save")}
        </button>
      </div>
    </>
  );
}

// ─── Requirements Tab Content ────────────────────────────────
function RequirementsTabContent({ projectId, userId, t }) {
  const [requirements, setRequirements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({ title: "", description: "", type: "functional", priority: "should", status: "draft" });

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    api(`/projects/${projectId}/requirements?userId=${userId}`)
      .then(list => setRequirements(list || []))
      .catch(() => setRequirements([]))
      .finally(() => setLoading(false));
  }, [projectId, userId]);

  const saveReq = async (req) => {
    try {
      if (req.id) {
        await api(`/projects/${projectId}/requirements/${req.id}`, { method: "PUT", body: JSON.stringify({ userId, data: req }) });
        setRequirements(prev => prev.map(r => r.id === req.id ? req : r));
      } else {
        const created = await api(`/projects/${projectId}/requirements`, { method: "POST", body: JSON.stringify({ userId, data: req }) });
        setRequirements(prev => [...prev, created]);
      }
    } catch { /* endpoint may not exist yet */ }
    setEditId(null);
  };

  const deleteReq = async (id) => {
    try {
      await api(`/projects/${projectId}/requirements/${id}`, { method: "DELETE", body: JSON.stringify({ userId }) });
      setRequirements(prev => prev.filter(r => r.id !== id));
    } catch { /* ignore */ }
  };

  const startAdd = () => {
    const newReq = { id: null, title: "", description: "", type: "functional", priority: "should", status: "draft" };
    setEditData(newReq);
    setEditId("new");
  };

  const priorities = ["must", "should", "could", "wont"];
  const statuses = ["draft", "approved", "implemented", "rejected", "deferred"];
  const types = ["functional", "non-functional"];

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>{t("diagram.tabRequirements")}</span>
        <button className="btn-primary btn-sm" onClick={startAdd}><Plus size={14} /> {t("common.add") || "Add"}</button>
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 32, color: "var(--text-muted)" }}>Loading...</div>
      ) : requirements.length === 0 && editId !== "new" ? (
        <div style={{ textAlign: "center", padding: 32, color: "var(--text-muted)" }}>
          {t("diagram.tabRequirements")} — {t("common.empty") || "No items yet"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {requirements.map(req => (
            editId === req.id ? (
              <div key={req.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg-secondary)" }}>
                <input style={{ width: "100%", marginBottom: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                  value={editData.title} onChange={e => setEditData(d => ({ ...d, title: e.target.value }))} placeholder="Title" />
                <textarea style={{ width: "100%", marginBottom: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", minHeight: 60, resize: "vertical" }}
                  value={editData.description} onChange={e => setEditData(d => ({ ...d, description: e.target.value }))} placeholder="Description" />
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <select style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                    value={editData.type || "functional"} onChange={e => setEditData(d => ({ ...d, type: e.target.value }))}>
                    {types.map(t2 => <option key={t2} value={t2}>{t2.charAt(0).toUpperCase() + t2.slice(1)}</option>)}
                  </select>
                  <select style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                    value={editData.priority} onChange={e => setEditData(d => ({ ...d, priority: e.target.value }))}>
                    {priorities.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                  </select>
                  <select style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                    value={editData.status} onChange={e => setEditData(d => ({ ...d, status: e.target.value }))}>
                    {statuses.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn-primary btn-sm" onClick={() => saveReq({ ...req, ...editData })}><Save size={14} /> {t("common.save")}</button>
                  <button className="btn-secondary btn-sm" onClick={() => setEditId(null)}><X size={14} /> {t("common.cancel")}</button>
                </div>
              </div>
            ) : (
              <div key={req.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg-secondary)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>{req.id}</span>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>{req.title}</span>
                  </div>
                  {req.description && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{req.description}</div>}
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>{(req.type || "functional").charAt(0).toUpperCase() + (req.type || "functional").slice(1)}</span>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "var(--accent)", color: "#fff" }}>{(req.priority || "should").toUpperCase()}</span>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>{req.status || "draft"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="icon-btn-sm" onClick={() => { setEditId(req.id); setEditData({ title: req.title, description: req.description || "", type: req.type || "functional", priority: req.priority || "should", status: req.status || "draft" }); }}><Pencil size={13} /></button>
                  <button className="icon-btn-sm" onClick={() => deleteReq(req.id)}><Trash2 size={13} /></button>
                </div>
              </div>
            )
          ))}
          {editId === "new" && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg-secondary)" }}>
              <input style={{ width: "100%", marginBottom: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                value={editData.title} onChange={e => setEditData(d => ({ ...d, title: e.target.value }))} placeholder="Title" autoFocus />
              <textarea style={{ width: "100%", marginBottom: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", minHeight: 60, resize: "vertical" }}
                value={editData.description} onChange={e => setEditData(d => ({ ...d, description: e.target.value }))} placeholder="Description" />
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <select style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                  value={editData.type || "functional"} onChange={e => setEditData(d => ({ ...d, type: e.target.value }))}>
                  {types.map(t2 => <option key={t2} value={t2}>{t2.charAt(0).toUpperCase() + t2.slice(1)}</option>)}
                </select>
                <select style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                  value={editData.priority} onChange={e => setEditData(d => ({ ...d, priority: e.target.value }))}>
                  {priorities.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                </select>
                <select style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
                  value={editData.status} onChange={e => setEditData(d => ({ ...d, status: e.target.value }))}>
                  {statuses.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-primary btn-sm" onClick={() => saveReq(editData)}><Save size={14} /> {t("common.save")}</button>
                <button className="btn-secondary btn-sm" onClick={() => setEditId(null)}><X size={14} /> {t("common.cancel")}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Architect View (back of flip) ──────────────────────────
function ArchitectView({ onClose }) {
  const { state, userId, useCaseMermaid, setUseCaseMermaid, deploymentMermaid, setDeploymentMermaid, componentMermaid, setComponentMermaid, devFocus, setDevFocus, serverConfig, t } = useContext(AppContext);
  const emptyData = { actors: [], useCases: [], connections: [], relationships: [], boundaries: [] };
  const [activeTab, setActiveTab] = useState("usecase");
  const [ucData, setUcData] = useState(emptyData);
  const [depData, setDepData] = useState(emptyData);
  const [compData, setCompData] = useState(emptyData);
  const [activityList, setActivityList] = useState([]);
  const [activeActivityId, setActiveActivityId] = useState(null);
  const [activityData, setActivityData] = useState(null);
  const [erList, setERList] = useState([]);
  const [activeERId, setActiveERId] = useState(null);
  const [erData, setERData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showMermaid, setShowMermaid] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tool, setTool] = useState("select");

  useEffect(() => {
    if (!state.currentProjectId) return;
    api(`/projects/${state.currentProjectId}/usecase?userId=${userId}`)
      .then(raw => setUcData(ucAutoLayout({ actors: raw.actors || [], useCases: raw.useCases || [], connections: raw.connections || [], relationships: raw.relationships || [], boundaries: raw.boundaries || [], systemBoundary: raw.systemBoundary || null })))
      .catch(() => setUcData({ ...emptyData }));
    api(`/projects/${state.currentProjectId}/deployment?userId=${userId}`)
      .then(raw => setDepData(ucAutoLayout({ actors: raw.actors || [], useCases: raw.useCases || [], connections: raw.connections || [], relationships: raw.relationships || [], boundaries: raw.boundaries || [], systemBoundary: raw.systemBoundary || null })))
      .catch(() => setDepData({ ...emptyData }));
    api(`/projects/${state.currentProjectId}/component?userId=${userId}`)
      .then(raw => setCompData(ucAutoLayout({ actors: raw.actors || [], useCases: raw.useCases || [], connections: raw.connections || [], relationships: raw.relationships || [], boundaries: raw.boundaries || [], systemBoundary: raw.systemBoundary || null })))
      .catch(() => setCompData({ ...emptyData }));
    api(`/projects/${state.currentProjectId}/activities?userId=${userId}`)
      .then(list => setActivityList(list || []))
      .catch(() => setActivityList([]));
    api(`/projects/${state.currentProjectId}/er-diagrams?userId=${userId}`)
      .then(list => setERList(list || []))
      .catch(() => setERList([]));
  }, [state.currentProjectId, userId]);

  useEffect(() => { setSelectedId(null); setTool("select"); setShowMermaid(false); }, [activeTab]);

  const data = activeTab === "component" ? compData : activeTab === "usecase" ? ucData : activeTab === "deployment" ? depData : null;
  const setData = activeTab === "component" ? setCompData : activeTab === "usecase" ? setUcData : activeTab === "deployment" ? setDepData : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      if (activeTab === "activity") {
        if (activeActivityId && activityData) {
          await api(`/projects/${state.currentProjectId}/activities/${activeActivityId}`, { method: "PUT", body: JSON.stringify({ userId, data: activityData }) });
        }
        return;
      }
      if (activeTab === "er") {
        if (activeERId && erData) {
          await api(`/projects/${state.currentProjectId}/er-diagrams/${activeERId}`, { method: "PUT", body: JSON.stringify({ userId, data: erData }) });
        }
        return;
      }
      if (activeTab === "requirements") return;
      const validConnections = data.connections.filter(c =>
        data.actors.some(a => a.id === c.actorId) && data.useCases.some(u => u.id === c.useCaseId)
      );
      const validRelationships = (data.relationships || []).filter(r =>
        data.useCases.some(u => u.id === r.fromUseCaseId) && data.useCases.some(u => u.id === r.toUseCaseId)
      );
      const saveData = { ...data, connections: validConnections, relationships: validRelationships };
      const endpoint = activeTab === "component" ? "component" : activeTab === "usecase" ? "usecase" : "deployment";
      await api(`/projects/${state.currentProjectId}/${endpoint}`, { method: "PUT", body: JSON.stringify({ userId, data: saveData }) });
      if (activeTab === "usecase") setUseCaseMermaid(generateUseCaseMermaid(saveData));
      else if (activeTab === "deployment") setDeploymentMermaid(generateUseCaseMermaid(saveData));
      else if (activeTab === "component") setComponentMermaid(generateUseCaseMermaid(saveData));
    } catch (err) {
      console.error(`Failed to save ${activeTab} diagram:`, err);
    } finally { setSaving(false); }
  };

  return (
    <div className="architect-view">
      <div className="architect-header">
        <div className="architect-header-left">
          <Hexagon size={18} />
          <span>{t("architect.title")}</span>
        </div>
        <div className="architect-header-right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        </div>
      </div>
      <div className="diagram-tabs">
        <button className={`diagram-tab${activeTab === "usecase" ? " active" : ""}`} onClick={() => setActiveTab("usecase")}>{t("diagram.tabUseCase")}</button>
        <button className={`diagram-tab${activeTab === "deployment" ? " active" : ""}`} onClick={() => setActiveTab("deployment")}>{t("diagram.tabDeployment")}</button>
        <button className={`diagram-tab${activeTab === "component" ? " active" : ""}`} onClick={() => setActiveTab("component")}>{t("diagram.tabComponent")}</button>
        <button className={`diagram-tab${activeTab === "activity" ? " active" : ""}`} onClick={() => setActiveTab("activity")}>{t("diagram.tabActivity")}</button>
        <button className={`diagram-tab${activeTab === "er" ? " active" : ""}`} onClick={() => setActiveTab("er")}>{t("diagram.tabER")}</button>
        <button className={`diagram-tab${activeTab === "requirements" ? " active" : ""}`} onClick={() => setActiveTab("requirements")}>{t("diagram.tabRequirements")}</button>
      </div>
      <div className="architect-body">
        {activeTab === "requirements" ? (
          <RequirementsTabContent projectId={state.currentProjectId} userId={userId} t={t} />
        ) : activeTab === "activity" ? (
          <ActivityTabContent
            projectId={state.currentProjectId} userId={userId}
            activityList={activityList} setActivityList={setActivityList}
            activeActivityId={activeActivityId} setActiveActivityId={setActiveActivityId}
            activityData={activityData} setActivityData={setActivityData}
            saving={saving} handleSave={handleSave}
            onOpenChange={() => onClose()} t={t}
          />
        ) : activeTab === "er" ? (
          <ERTabContent
            projectId={state.currentProjectId} userId={userId}
            erList={erList} setERList={setERList}
            activeERId={activeERId} setActiveERId={setActiveERId}
            erData={erData} setERData={setERData}
            saving={saving} handleSave={handleSave}
            onOpenChange={() => onClose()} t={t}
          />
        ) : (
          <DiagramTabContent
            activeTab={activeTab} data={data} setData={setData}
            selectedId={selectedId} setSelectedId={setSelectedId}
            tool={tool} setTool={setTool}
            showMermaid={showMermaid} setShowMermaid={setShowMermaid}
            saving={saving} handleSave={handleSave}
            onOpenChange={() => onClose()}
            devFocus={devFocus} setDevFocus={setDevFocus}
            t={t}
          />
        )}
      </div>
      <Tip label={t("architect.backToPreview")} side="top">
        <button className="architect-toggle-btn" onClick={onClose}>
          <Eye size={16} /> {t("architect.backToPreview")}
        </button>
      </Tip>
    </div>
  );
}

function UseCaseDiagramDialog({ open, onOpenChange }) {
  const { state, userId, useCaseMermaid, setUseCaseMermaid, deploymentMermaid, setDeploymentMermaid, componentMermaid, setComponentMermaid, devFocus, setDevFocus, t } = useContext(AppContext);
  const emptyData = { actors: [], useCases: [], connections: [], relationships: [], boundaries: [] };
  const [activeTab, setActiveTab] = useState("usecase");
  const [ucData, setUcData] = useState(emptyData);
  const [depData, setDepData] = useState(emptyData);
  const [compData, setCompData] = useState(emptyData);
  // Activity diagrams state
  const [activityList, setActivityList] = useState([]);
  const [activeActivityId, setActiveActivityId] = useState(null);
  const [activityData, setActivityData] = useState(null);
  // ER diagrams state
  const [erList, setERList] = useState([]);
  const [activeERId, setActiveERId] = useState(null);
  const [erData, setERData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [showMermaid, setShowMermaid] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tool, setTool] = useState("select");

  useEffect(() => {
    if (open && state.currentProjectId) {
      api(`/projects/${state.currentProjectId}/usecase?userId=${userId}`)
        .then(raw => setUcData(ucAutoLayout({ actors: raw.actors || [], useCases: raw.useCases || [], connections: raw.connections || [], relationships: raw.relationships || [], boundaries: raw.boundaries || [], systemBoundary: raw.systemBoundary || null })))
        .catch(() => setUcData({ ...emptyData }));
      api(`/projects/${state.currentProjectId}/deployment?userId=${userId}`)
        .then(raw => setDepData(ucAutoLayout({ actors: raw.actors || [], useCases: raw.useCases || [], connections: raw.connections || [], relationships: raw.relationships || [], boundaries: raw.boundaries || [], systemBoundary: raw.systemBoundary || null })))
        .catch(() => setDepData({ ...emptyData }));
      api(`/projects/${state.currentProjectId}/component?userId=${userId}`)
        .then(raw => setCompData(ucAutoLayout({ actors: raw.actors || [], useCases: raw.useCases || [], connections: raw.connections || [], relationships: raw.relationships || [], boundaries: raw.boundaries || [], systemBoundary: raw.systemBoundary || null })))
        .catch(() => setCompData({ ...emptyData }));
      api(`/projects/${state.currentProjectId}/activities?userId=${userId}`)
        .then(list => setActivityList(list || []))
        .catch(() => setActivityList([]));
      api(`/projects/${state.currentProjectId}/er-diagrams?userId=${userId}`)
        .then(list => setERList(list || []))
        .catch(() => setERList([]));
    }
    if (!open) { setMaximized(false); setShowMermaid(false); setSelectedId(null); setTool("select"); setActiveActivityId(null); setActivityData(null); setActiveERId(null); setERData(null); }
  }, [open]);

  // Reset selection when switching tabs
  useEffect(() => { setSelectedId(null); setTool("select"); setShowMermaid(false); }, [activeTab]);

  const data = activeTab === "component" ? compData : activeTab === "usecase" ? ucData : activeTab === "deployment" ? depData : null;
  const setData = activeTab === "component" ? setCompData : activeTab === "usecase" ? setUcData : activeTab === "deployment" ? setDepData : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      if (activeTab === "activity") {
        if (activeActivityId && activityData) {
          await api(`/projects/${state.currentProjectId}/activities/${activeActivityId}`, {
            method: "PUT",
            body: JSON.stringify({ userId, data: activityData }),
          });
        }
        onOpenChange(false);
        return;
      }
      if (activeTab === "er") {
        if (activeERId && erData) {
          await api(`/projects/${state.currentProjectId}/er-diagrams/${activeERId}`, {
            method: "PUT",
            body: JSON.stringify({ userId, data: erData }),
          });
        }
        onOpenChange(false);
        return;
      }
      const validConnections = data.connections.filter(c =>
        data.actors.some(a => a.id === c.actorId) && data.useCases.some(u => u.id === c.useCaseId)
      );
      const validRelationships = (data.relationships || []).filter(r =>
        data.useCases.some(u => u.id === r.fromUseCaseId) && data.useCases.some(u => u.id === r.toUseCaseId)
      );
      const saveData = { ...data, connections: validConnections, relationships: validRelationships };
      const endpoint = activeTab === "component" ? "component" : activeTab === "usecase" ? "usecase" : "deployment";
      await api(`/projects/${state.currentProjectId}/${endpoint}`, {
        method: "PUT",
        body: JSON.stringify({ userId, data: saveData }),
      });
      if (activeTab === "usecase") {
        setUseCaseMermaid(generateUseCaseMermaid(saveData));
      } else if (activeTab === "deployment") {
        setDeploymentMermaid(generateUseCaseMermaid(saveData));
      } else if (activeTab === "component") {
        setComponentMermaid(generateUseCaseMermaid(saveData));
      }
      onOpenChange(false);
    } catch (err) {
      console.error(`Failed to save ${activeTab} diagram:`, err);
    } finally { setSaving(false); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal-content usecase-dialog${maximized ? " usecase-dialog-maximized" : ""}`}
          style={maximized ? { display: "flex", flexDirection: "column" } : undefined}>
          <Dialog.Title className="modal-title" style={{ marginBottom: 8 }}>
            <div className="usecase-title-row">
              <div className="usecase-title-left">
                <BookOpen size={20} className="title-icon" />
                {t("diagrams.title")}
              </div>
              <div className="usecase-title-actions">
                <button onClick={() => setMaximized(m => !m)} title={maximized ? t("usecase.minimize") : t("usecase.maximize")}>
                  {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
              </div>
            </div>
          </Dialog.Title>

          <div className="diagram-tabs">
            <button className={`diagram-tab${activeTab === "usecase" ? " active" : ""}`} onClick={() => setActiveTab("usecase")}>{t("diagram.tabUseCase")}</button>
            <button className={`diagram-tab${activeTab === "deployment" ? " active" : ""}`} onClick={() => setActiveTab("deployment")}>{t("diagram.tabDeployment")}</button>
            <button className={`diagram-tab${activeTab === "component" ? " active" : ""}`} onClick={() => setActiveTab("component")}>{t("diagram.tabComponent")}</button>
            <button className={`diagram-tab${activeTab === "activity" ? " active" : ""}`} onClick={() => setActiveTab("activity")}>{t("diagram.tabActivity")}</button>
            <button className={`diagram-tab${activeTab === "er" ? " active" : ""}`} onClick={() => setActiveTab("er")}>{t("diagram.tabER")}</button>
          </div>

          {activeTab === "activity" ? (
            <ActivityTabContent
              projectId={state.currentProjectId} userId={userId}
              activityList={activityList} setActivityList={setActivityList}
              activeActivityId={activeActivityId} setActiveActivityId={setActiveActivityId}
              activityData={activityData} setActivityData={setActivityData}
              saving={saving} handleSave={handleSave}
              onOpenChange={onOpenChange} t={t}
            />
          ) : activeTab === "er" ? (
            <ERTabContent
              projectId={state.currentProjectId} userId={userId}
              erList={erList} setERList={setERList}
              activeERId={activeERId} setActiveERId={setActiveERId}
              erData={erData} setERData={setERData}
              saving={saving} handleSave={handleSave}
              onOpenChange={onOpenChange} t={t}
            />
          ) : (
            <DiagramTabContent
              activeTab={activeTab} data={data} setData={setData}
              selectedId={selectedId} setSelectedId={setSelectedId}
              tool={tool} setTool={setTool}
              showMermaid={showMermaid} setShowMermaid={setShowMermaid}
              saving={saving} handleSave={handleSave}
              onOpenChange={onOpenChange}
              devFocus={devFocus} setDevFocus={setDevFocus}
              t={t}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Generic row-anchored kebab menu. `items` is an array of
// `{ icon, label, onClick, disabled?, danger?, hidden? }`. Built on Radix
// DropdownMenu so it positions correctly through any transformed ancestor
// (Floating UI) and coexists with a parent Radix Dialog — its
// DismissableLayer keeps items interactive instead of being blocked by the
// dialog's outside-pointer-events guard.
function RowKebab({ items, ariaLabel, disabled }) {
  const visible = (items || []).filter(it => it && !it.hidden);
  if (visible.length === 0) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="row-kebab"
          disabled={disabled}
          aria-label={ariaLabel}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="row-menu"
          align="end"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
        >
          {visible.map((it, i) => (
            <DropdownMenu.Item
              key={i}
              disabled={it.disabled}
              onSelect={() => it.onClick()}
              asChild
            >
              <button type="button" className={it.danger ? "danger" : undefined}>
                {it.icon}
                {it.label}
              </button>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ChatTabKebab({ onRename, onClear, onDelete, onDownload, canDownload, disabled, t }) {
  return (
    <RowKebab
      ariaLabel={t("chat.tab.menu")}
      disabled={disabled}
      items={[
        { icon: <Pencil size={12} />, label: t("chat.tab.rename"), onClick: onRename },
        { icon: <Download size={12} />, label: t("chat.tab.download"), onClick: onDownload, disabled: !canDownload },
        { icon: <Trash2 size={12} />, label: t("chat.tab.clear"), onClick: onClear, disabled },
        { icon: <X size={12} />, label: t("chat.tab.delete"), onClick: onDelete, disabled, danger: true },
      ]}
    />
  );
}

function ChatTab({ chat, active, isStreaming, onSelect, onRename, onClear, onDelete, onDownload, canDownload, t }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.name);
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setDraft(chat.name); }, [chat.name, editing]);
  useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [editing]);

  const startRename = () => setEditing(true);
  const commitRename = () => {
    const next = draft.trim();
    if (next && next !== chat.name) onRename(chat.id, next);
    setEditing(false);
  };
  const cancelRename = () => { setDraft(chat.name); setEditing(false); };

  return (
    <div
      className={`chat-tab${active ? " active" : ""}`}
      onClick={() => { if (!editing) onSelect(chat.id); }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="chat-tab-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
            else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
          }}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span className="chat-tab-name" onDoubleClick={(e) => { e.stopPropagation(); startRename(); }}>{chat.name}</span>
          <ChatTabKebab
            onRename={startRename}
            onClear={onClear}
            onDelete={onDelete}
            onDownload={onDownload}
            canDownload={canDownload}
            disabled={active && isStreaming}
            t={t}
          />
        </>
      )}
    </div>
  );
}

function ChatTabs() {
  const { state, selectChat, createChat, renameChat, deleteChat, clearChat, downloadChatCsv, t } = useContext(AppContext);
  const stripRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState(null); // { kind: "clear" | "delete", chat }

  const updateScrollState = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = stripRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", updateScrollState); ro.disconnect(); };
  }, [updateScrollState, state.chats.length]);

  // Auto-scroll the active tab into view when chats change.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const active = el.querySelector(".chat-tab.active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [state.currentChatId, state.chats.length]);

  const scrollBy = (delta) => {
    if (stripRef.current) stripRef.current.scrollBy({ left: delta, behavior: "smooth" });
  };

  const onClearRequest = (chat) => setConfirmTarget({ kind: "clear", chat });
  const onDeleteRequest = (chat) => setConfirmTarget({ kind: "delete", chat });
  const closeConfirm = () => setConfirmTarget(null);
  const runConfirm = async () => {
    if (!confirmTarget) return;
    const { kind, chat } = confirmTarget;
    closeConfirm();
    if (kind === "clear") await clearChat(chat.id);
    else if (kind === "delete") await deleteChat(chat.id);
  };

  return (
    <div className="chat-tabs">
      <MessageSquare size={14} className="chat-tabs-icon" />
      <button
        className="chat-tab-scroll"
        onClick={() => scrollBy(-160)}
        disabled={!canScrollLeft}
        aria-label={t("chat.tab.scrollLeft")}
      >
        <ChevronLeft size={14} />
      </button>
      <div className="chat-tab-strip" ref={stripRef}>
        {state.chats.map(chat => (
          <ChatTab
            key={chat.id}
            chat={chat}
            active={chat.id === state.currentChatId}
            isStreaming={state.isStreaming}
            onSelect={selectChat}
            onRename={renameChat}
            onClear={() => onClearRequest(chat)}
            onDelete={() => onDeleteRequest(chat)}
            onDownload={() => downloadChatCsv(chat)}
            canDownload={chat.id === state.currentChatId ? (state.messages?.length > 0) : true}
            t={t}
          />
        ))}
      </div>
      <button
        className="chat-tab-scroll"
        onClick={() => scrollBy(160)}
        disabled={!canScrollRight}
        aria-label={t("chat.tab.scrollRight")}
      >
        <ChevronRight size={14} />
      </button>
      <Tip label={t("chat.tab.new")} side="bottom">
        <button className="chat-tab-new" onClick={() => createChat()} aria-label={t("chat.tab.new")}>
          <Plus size={13} />
        </button>
      </Tip>

      <Dialog.Root open={!!confirmTarget} onOpenChange={(o) => { if (!o) closeConfirm(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <AlertTriangle size={18} style={{ color: "var(--error)" }} />
              {confirmTarget?.kind === "delete" ? t("confirm.deleteChatTitle") : t("confirm.clearChatTitle")}
            </Dialog.Title>
            <div className="alert-description">
              {confirmTarget?.kind === "delete"
                ? t("confirm.deleteChat", { name: confirmTarget?.chat?.name || "" })
                : t("confirm.clearChat", { name: confirmTarget?.chat?.name || "" })}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={closeConfirm}>{t("common.cancel")}</button>
              <button className="btn-danger" onClick={runConfirm}>
                {confirmTarget?.kind === "delete"
                  ? <><X size={14} /> {t("chat.tab.delete")}</>
                  : <><Trash2 size={14} /> {t("chat.tab.clear")}</>}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function ChatSummaryRow() {
  const { state, userId, t } = useContext(AppContext);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");

  // Reset whenever the chat changes.
  useEffect(() => {
    setOpen(false);
    setSummary("");
    setError("");
  }, [state.currentChatId]);

  const fetchSummary = useCallback(async () => {
    if (!state.currentProjectId || !state.currentChatId) return;
    setLoading(true);
    setError("");
    try {
      const { summary } = await api(`/projects/${state.currentProjectId}/chats/${state.currentChatId}/summary`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setSummary(summary || "");
    } catch (err) {
      setError(err?.message || t("chat.summary.error"));
    } finally {
      setLoading(false);
    }
  }, [state.currentProjectId, state.currentChatId, userId, t]);

  const toggle = () => {
    if (!open) {
      setOpen(true);
      fetchSummary();
    } else {
      setOpen(false);
    }
  };

  if (!state.currentChatId) return null;

  const hasMessages = state.messages.length > 0;

  return (
    <div className={`chat-summary-row${open ? " open" : ""}`}>
      <button className="chat-summary-header" onClick={toggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{t("chat.summary.label")}</span>
        {open && hasMessages && (
          <span className="chat-summary-refresh" onClick={(e) => { e.stopPropagation(); fetchSummary(); }} title={t("chat.summary.refresh")}>
            <RefreshCw size={11} />
          </span>
        )}
      </button>
      {open && (
        <div className="chat-summary-body">
          {!hasMessages ? (
            <div className="chat-summary-empty">{t("chat.summary.empty")}</div>
          ) : loading ? (
            <div className="chat-summary-loading"><Loader size={12} className="spin" /> {t("chat.summary.loading")}</div>
          ) : error ? (
            <div className="chat-summary-error">{t("chat.summary.error")}</div>
          ) : summary ? (
            <MarkdownChunk text={summary} streaming={false} />
          ) : (
            <div className="chat-summary-empty">{t("chat.summary.empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-day LLM spend for the current project, fetched from the cost state
// file on open. Days appear once tracking has recorded them; spend accrued
// before daily tracking shows as a single "earlier" remainder row.
function CostListDialog({ open, onOpenChange, projectId, projectName, userId, t, lang }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    api(`/projects/${encodeURIComponent(projectId)}/cost?userId=${encodeURIComponent(userId)}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, userId]);

  const days = data ? Object.entries(data.byDay || {}).sort((a, b) => b[0].localeCompare(a[0])) : [];
  const bucketSum = days.reduce((sum, [, b]) => sum + (b.totalUsd || 0), 0);
  const earlier = data ? data.totalUsd - bucketSum : 0;
  const hasAny = !!data && (days.length > 0 || data.totalUsd > 0);
  // Parse as local midnight — a bare YYYY-MM-DD would parse as UTC and can
  // render as the previous day in negative-offset timezones.
  const dayLabel = (day) => new Date(`${day}T00:00:00`).toLocaleDateString(lang || undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  const tokenNote = (tokens) => `↑${formatTokenCount(tokens?.input) || 0} ↓${formatTokenCount(tokens?.output) || 0}`;
  // Per-model input/output/cached split: token count beside the USD each cost.
  // Only rendered when the bucket carries pi's cost split (new data); legacy
  // buckets have none and fall back to the plain total row.
  const costBreakdown = (tokens, cost) => {
    if (!cost) return null;
    const rows = [
      ["projectCost.input", tokens?.input || 0, cost.input || 0],
      ["projectCost.output", tokens?.output || 0, cost.output || 0],
      ["projectCost.cached", (tokens?.cacheRead || 0) + (tokens?.cacheWrite || 0), (cost.cacheRead || 0) + (cost.cacheWrite || 0)],
    ];
    return (
      <div className="cost-breakdown">
        {rows.map(([key, tok, usd]) => (
          <React.Fragment key={key}>
            <span className="cost-bd-label">{t(key)}</span>
            <span className="cost-bd-tokens">{formatTokenCount(tok) || "0"}</span>
            <span className="cost-bd-amount">{formatProjectCost(usd) || "$0.00"}</span>
          </React.Fragment>
        ))}
      </div>
    );
  };

  // Flatten the same day/model rows the dialog renders into a spreadsheet-friendly
  // CSV, using raw numbers (no "$"/"k" formatting). The project name rides in the
  // first line (the "header") and the filename.
  const buildCsv = () => {
    const tk = (tok) => [tok?.input || 0, tok?.output || 0, tok?.cacheRead || 0, tok?.cacheWrite || 0];
    const row = (cells) => cells.map(csvField).join(",");
    const lines = [
      row(["Project", projectName || "project"]),
      row(["Generated", new Date().toISOString()]),
      "",
      row(["Date", "Type", "Provider", "Model", "Input tokens", "Output tokens", "Cache read", "Cache write", "Total USD"]),
    ];
    for (const [day, bucket] of days) {
      const models = Object.entries(bucket.byModel || {}).sort((a, b) => b[1].totalUsd - a[1].totalUsd);
      const modelSum = models.reduce((sum, [, m]) => sum + (m.totalUsd || 0), 0);
      const dayRemainder = bucket.totalUsd - modelSum;
      lines.push(row([day, "day", "", "", ...tk(bucket.tokens), bucket.totalUsd || 0]));
      for (const [modelId, m] of models) {
        lines.push(row([day, "model", m.provider || "", modelId, ...tk(m.tokens), m.totalUsd || 0]));
      }
      if (models.length > 0 && dayRemainder > 0.005) {
        lines.push(row([day, "unknown-model", "", "", "", "", "", "", dayRemainder]));
      }
    }
    if (earlier > 0.005) {
      lines.push(row(["", "earlier", "", "", "", "", "", "", earlier]));
    }
    lines.push(row(["", "total", "", "", ...tk(data.tokens), data.totalUsd || 0]));
    return lines.join("\r\n");
  };

  const handleDownload = () => {
    if (!hasAny) return;
    downloadTextFile(`${csvSlug(projectName)}-costs-${yyyymmdd(new Date())}.csv`, buildCsv(), "text/csv;charset=utf-8");
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <Coins size={18} className="title-icon" />
            {t("projectCost.listTitle")}
          </Dialog.Title>
          {loading ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 0" }}>{t("common.loading") || "Loading…"}</div>
          ) : error ? (
            <div style={{ fontSize: 12, color: "var(--error)", padding: "8px 0" }}>{error}</div>
          ) : !hasAny ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", padding: "8px 0" }}>{t("projectCost.empty")}</div>
          ) : (
            <div className="cost-list">
              {days.map(([day, bucket]) => {
                const models = Object.entries(bucket.byModel || {}).sort((a, b) => b[1].totalUsd - a[1].totalUsd);
                const modelSum = models.reduce((sum, [, m]) => sum + (m.totalUsd || 0), 0);
                const dayRemainder = bucket.totalUsd - modelSum;
                return (
                  <React.Fragment key={day}>
                    <div className="cost-row">
                      <span className="cost-row-label">{dayLabel(day)}</span>
                      <span className="cost-row-tokens">{tokenNote(bucket.tokens)}</span>
                      <span className="cost-row-amount">{formatProjectCost(bucket.totalUsd) || "$0.00"}</span>
                    </div>
                    {models.map(([modelId, m]) => (
                      <React.Fragment key={`${day}:${modelId}`}>
                        <div className="cost-row model">
                          <span className="cost-row-label">{m.provider ? `${m.provider} / ${modelId}` : modelId}</span>
                          <span className="cost-row-tokens">{m.cost ? "" : tokenNote(m.tokens)}</span>
                          <span className="cost-row-amount">{formatProjectCost(m.totalUsd) || "$0.00"}</span>
                        </div>
                        {costBreakdown(m.tokens, m.cost)}
                      </React.Fragment>
                    ))}
                    {models.length > 0 && dayRemainder > 0.005 && (
                      <div className="cost-row model">
                        <span className="cost-row-label cost-row-earlier">{t("projectCost.unknownModel")}</span>
                        <span className="cost-row-tokens" />
                        <span className="cost-row-amount">{formatProjectCost(dayRemainder) || "$0.00"}</span>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
              {earlier > 0.005 && (
                <div className="cost-row">
                  <span className="cost-row-label cost-row-earlier">{t("projectCost.earlier")}</span>
                  <span className="cost-row-tokens" />
                  <span className="cost-row-amount">{formatProjectCost(earlier) || "$0.00"}</span>
                </div>
              )}
              <div className="cost-row total">
                <span className="cost-row-label">{t("projectCost.total")}</span>
                <span className="cost-row-tokens">{tokenNote(data.tokens)}</span>
                <span className="cost-row-amount">{formatProjectCost(data.totalUsd) || "$0.00"}</span>
              </div>
            </div>
          )}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={handleDownload} disabled={!hasAny}>
              <Download size={14} /> {t("projectCost.downloadCsv")}
            </button>
            <Dialog.Close asChild>
              <button className="btn-secondary">{t("common.close") || "Close"}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ChatSection() {
  const { state, agentBusy, userId, isAdmin, loadProjects, setShowCommits, setShowGit, setShowDeploy, gitRemoteConfigured, userdataNotesRef, devFocus, setDevFocus, closeProject, captureScreenshotRef, pendingScreenshot, clearPendingScreenshot, t, lang } = useContext(AppContext);
  const [showChatSkills, setShowChatSkills] = useState(false);
  const [showUserData, setShowUserData] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showCostList, setShowCostList] = useState(false);
  const [inputHeight, setInputHeight] = useState(160);
  const [attachments, setAttachments] = useState([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputDragging = useRef(false);
  const sectionRef = useRef(null);

  const addFile = useCallback((file) => {
    if (!file) return;
    if (file.type && file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = async () => {
        const { dataUrl } = await compressImageDataUrl(reader.result);
        setAttachments(prev => [...prev, { type: "image", name: file.name || "pasted-image.png", dataUrl }]);
      };
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments(prev => [...prev, { type: "text", name: file.name || "file.txt", content: reader.result }]);
      };
      reader.readAsText(file);
    }
  }, []);

  const removeAttachment = useCallback((idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  useEffect(() => {
    if (!pendingScreenshot) return;
    let cancelled = false;
    (async () => {
      const { dataUrl } = await compressImageDataUrl(pendingScreenshot);
      if (cancelled) return;
      setAttachments(prev => [...prev, { type: "image", name: "screenshot.png", dataUrl }]);
      clearPendingScreenshot();
    })();
    return () => { cancelled = true; };
  }, [pendingScreenshot, clearPendingScreenshot]);

  const onDragOver = (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      setIsDragOver(true);
    }
  };
  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOver(false);
  };
  const onDrop = (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    setIsDragOver(false);
    Array.from(e.dataTransfer.files).forEach(addFile);
  };

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!inputDragging.current) return;
      const section = sectionRef.current;
      if (!section) return;
      const rect = section.getBoundingClientRect();
      const nameEl = section.querySelector(".chat-project-name");
      const nameH = nameEl ? nameEl.offsetHeight : 0;
      const header = section.querySelector(".chat-header");
      const headerH = header ? header.offsetHeight : 0;
      const tabsEl = section.querySelector(".chat-tabs");
      const tabsH = tabsEl ? tabsEl.offsetHeight : 0;
      const summaryEl = section.querySelector(".chat-summary-row");
      const summaryH = summaryEl ? summaryEl.offsetHeight : 0;
      const bannerEl = section.querySelector(".dev-focus-banner");
      const bannerH = bannerEl ? bannerEl.offsetHeight : 0;
      const attachBar = section.querySelector(".attachments-bar");
      const attachBarH = attachBar ? attachBar.offsetHeight : 0;
      const handleH = 5;
      const available = rect.height - nameH - headerH - tabsH - summaryH - bannerH - handleH;
      const newInput = Math.max(100, Math.min(available * 0.7, rect.bottom - e.clientY - attachBarH));
      setInputHeight(newInput);
    };
    const onMouseUp = () => {
      if (inputDragging.current) {
        inputDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => { document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
  }, []);

  if (!state.currentProjectId) return <div className="chat-section" />;

  const currentProject = state.projects.find(p => p.id === state.currentProjectId);
  const projectHasIcon = !!currentProject && !!currentProject.settings?.hasIcon;

  return (
    <div className="chat-section" ref={sectionRef}>
      {state.currentProjectName && (
        <div className="chat-project-name" title={state.currentProjectName}>
          <span className="chat-project-name-icon">
            <RowIcon projectId={state.currentProjectId} hasIcon={projectHasIcon} />
          </span>
          <span className="chat-project-name-text">{state.currentProjectName}</span>
        </div>
      )}
      <div className="chat-header">
        <div className="chat-header-actions">
          <Tip label={t("projectSettings.openTitle")} side="bottom">
            <button className="icon-btn-sm" onClick={() => setShowProjectSettings(true)}>
              <Settings size={13} />
            </button>
          </Tip>
          <Tip label={t("projectCost.listTitle")} side="bottom">
            <button className="icon-btn-sm" onClick={() => setShowCostList(true)}>
              <Coins size={13} />
            </button>
          </Tip>
          <Tip label={t("userdata.title")} side="bottom">
            <button
              className="icon-btn-sm"
              onClick={() => {
                // Desktop app: the workspace is a real local folder — open
                // userdata/ in the OS file explorer instead of the in-app
                // dialog. (Older desktop builds without the bridge method,
                // and the browser build, keep the dialog.)
                if (window.vcaDesktop?.openUserdataFolder && state.currentProjectId) {
                  window.vcaDesktop.openUserdataFolder({ userId, projectId: state.currentProjectId });
                  return;
                }
                setShowUserData(true);
              }}
            >
              <FolderOpen size={13} />
            </button>
          </Tip>
          <Tip label={t("chat.skills")} side="bottom">
            <button className="icon-btn-sm" onClick={() => setShowChatSkills(true)}>
              <Zap size={13} />
            </button>
          </Tip>
          <Tip label={t("chat.deploy") || "Deploy"} side="bottom">
            <button className="icon-btn-sm" onClick={() => setShowDeploy(true)}>
              <Globe size={13} />
            </button>
          </Tip>
          <Tip label={t("chat.commits")} side="bottom">
            <button className="icon-btn-sm" onClick={() => setShowCommits(true)}>
              <History size={13} />
            </button>
          </Tip>
          <Tip label={gitRemoteConfigured ? t("chat.gitConfigured") : t("chat.gitRemote")} side="bottom">
            <button className={`icon-btn-sm${gitRemoteConfigured ? " deployed" : ""}`} onClick={() => setShowGit(true)}>
              <GitBranch size={13} />
            </button>
          </Tip>
          <Tip label={t("preview.screenshot")} side="bottom">
            <button className="icon-btn-sm" onClick={() => captureScreenshotRef.current?.()}>
              <Camera size={13} />
            </button>
          </Tip>
        </div>
        <span className="chat-header-title" />
        {/* Closing mid-turn would release the project lock while the agent keeps
            writing, so block it. aria-disabled rather than disabled: a disabled
            button gets no pointer events, so the Tip explaining WHY would never
            open — which makes the onClick guard the thing that actually blocks
            (it covers Enter/Space too). */}
        <Tip label={agentBusy ? t("sidebar.closeProjectBusy") : t("sidebar.closeProject")} side="bottom">
          <button
            className="icon-btn-sm"
            aria-disabled={agentBusy || undefined}
            onClick={() => { if (!agentBusy) closeProject(); }}
          >
            <X size={13} />
          </button>
        </Tip>
      </div>
      <ChatTabs />
      <ChatSummaryRow />
      {devFocus && (
        <div className="dev-focus-banner">
          <Crosshair size={12} />
          <span className="dev-focus-label">{t("diagram.focusLabel")}</span>
          <span className="dev-focus-name">{devFocus.name}</span>
          <button className="dev-focus-clear" onClick={() => setDevFocus(null)}><X size={12} /></button>
        </div>
      )}
      <MessageList />
      <div className="input-resize-handle" onMouseDown={(e) => { e.preventDefault(); inputDragging.current = true; document.body.style.cursor = "row-resize"; document.body.style.userSelect = "none"; }} />
      <div
        className={`input-section${isDragOver ? " drag-over" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <div className="attachments-bar">
            {attachments.map((a, i) => (
              <div key={i} className="attachment-chip">
                {a.type === "image" ? (
                  <img src={a.dataUrl} alt={a.name} className="attachment-thumb" />
                ) : (
                  <FileText size={14} className="attachment-file-icon" />
                )}
                <span className="attachment-name">{a.name}</span>
                <button className="attachment-remove" onClick={() => removeAttachment(i)}>
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <InputArea
          height={inputHeight}
          attachments={attachments}
          addFile={addFile}
          clearAttachments={clearAttachments}
        />
      </div>
      <ChatSkillsModal open={showChatSkills} onOpenChange={setShowChatSkills} />
      <UserDataModal open={showUserData} onOpenChange={setShowUserData} userdataNotesRef={userdataNotesRef} />
      <ProjectSettingsDialog
        projectId={state.currentProjectId}
        project={state.projects.find(p => p.id === state.currentProjectId) || null}
        userId={userId}
        isAdmin={isAdmin}
        open={showProjectSettings}
        onOpenChange={setShowProjectSettings}
        onSaved={() => loadProjects()}
        t={t}
      />
      <CostListDialog
        open={showCostList}
        onOpenChange={setShowCostList}
        projectId={state.currentProjectId}
        projectName={state.currentProjectName || currentProject?.name || "project"}
        userId={userId}
        t={t}
        lang={lang}
      />
    </div>
  );
}

// Horizontal tricolor (top-mid-bottom)
const hFlag = (c1, c2, c3) => () => (
  <svg width="18" height="13" viewBox="0 0 6 4" style={{ borderRadius: 2, display: "block" }}>
    <rect width="6" height="1.34" y="0" fill={c1}/><rect width="6" height="1.34" y="1.33" fill={c2}/><rect width="6" height="1.34" y="2.66" fill={c3}/>
  </svg>
);
// Vertical tricolor (left-mid-right)
const vFlag = (c1, c2, c3) => () => (
  <svg width="18" height="13" viewBox="0 0 6 4" style={{ borderRadius: 2, display: "block" }}>
    <rect width="2" height="4" x="0" fill={c1}/><rect width="2" height="4" x="2" fill={c2}/><rect width="2" height="4" x="4" fill={c3}/>
  </svg>
);

const FLAG_SVG = {
  en: () => (
    <svg width="18" height="13" viewBox="0 0 60 30" style={{ borderRadius: 2, display: "block" }}>
      <clipPath id="s"><path d="M0,0 v30 h60 v-30 z"/></clipPath>
      <clipPath id="t"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath>
      <g clipPath="url(#s)">
        <path d="M0,0 v30 h60 v-30 z" fill="#012169"/>
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6"/>
        <path d="M0,0 L60,30 M60,0 L0,30" clipPath="url(#t)" stroke="#C8102E" strokeWidth="4"/>
        <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10"/>
        <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6"/>
      </g>
    </svg>
  ),
  de: hFlag("#000", "#D00", "#FFCE00"),
  fr: vFlag("#002395", "#fff", "#ED2939"),
  es: () => (
    <svg width="18" height="13" viewBox="0 0 6 4" style={{ borderRadius: 2, display: "block" }}>
      <rect width="6" height="1" y="0" fill="#AA151B"/><rect width="6" height="2" y="1" fill="#F1BF00"/><rect width="6" height="1" y="3" fill="#AA151B"/>
    </svg>
  ),
  it: vFlag("#009246", "#fff", "#CE2B37"),
  pt: () => (
    <svg width="18" height="13" viewBox="0 0 6 4" style={{ borderRadius: 2, display: "block" }}>
      <rect width="2.4" height="4" x="0" fill="#006600"/><rect width="3.6" height="4" x="2.4" fill="#FF0000"/>
      <circle cx="2.4" cy="2" r="0.7" fill="#FF0" strokeWidth="0"/>
    </svg>
  ),
  nl: hFlag("#AE1C28", "#fff", "#21468B"),
  pl: hFlag("#fff", "#fff", "#DC143C"),
  cs: () => (
    <svg width="18" height="13" viewBox="0 0 6 4" style={{ borderRadius: 2, display: "block" }}>
      <rect width="6" height="2" y="0" fill="#fff"/><rect width="6" height="2" y="2" fill="#D7141A"/>
      <polygon points="0,0 3,2 0,4" fill="#11457E"/>
    </svg>
  ),
  sv: () => (
    <svg width="18" height="13" viewBox="0 0 16 10" style={{ borderRadius: 2, display: "block" }}>
      <rect width="16" height="10" fill="#006AA7"/><rect x="5" width="2" height="10" fill="#FECC00"/><rect y="4" width="16" height="2" fill="#FECC00"/>
    </svg>
  ),
  da: () => (
    <svg width="18" height="13" viewBox="0 0 37 28" style={{ borderRadius: 2, display: "block" }}>
      <rect width="37" height="28" fill="#C8102E"/><rect x="12" width="4" height="28" fill="#fff"/><rect y="12" width="37" height="4" fill="#fff"/>
    </svg>
  ),
  fi: () => (
    <svg width="18" height="13" viewBox="0 0 18 11" style={{ borderRadius: 2, display: "block" }}>
      <rect width="18" height="11" fill="#fff"/><rect x="5" width="3" height="11" fill="#003580"/><rect y="4" width="18" height="3" fill="#003580"/>
    </svg>
  ),
  el: () => (
    <svg width="18" height="13" viewBox="0 0 27 18" style={{ borderRadius: 2, display: "block" }}>
      {[0,1,2,3,4,5,6,7,8].map(i => <rect key={i} y={i*2} width="27" height="2" fill={i%2===0?"#0D5EAF":"#fff"}/>)}
      <rect width="10" height="10" fill="#0D5EAF"/><rect x="4" width="2" height="10" fill="#fff"/><rect y="4" width="10" height="2" fill="#fff"/>
    </svg>
  ),
  ro: vFlag("#002B7F", "#FCD116", "#CE1126"),
  hu: hFlag("#CE2939", "#fff", "#477050"),
  bg: hFlag("#fff", "#00966E", "#D62612"),
  hr: hFlag("#FF0000", "#fff", "#171796"),
  sk: hFlag("#fff", "#0B4EA2", "#EE1C25"),
  sl: hFlag("#fff", "#003DA5", "#ED1C24"),
  lt: hFlag("#FDB913", "#006A44", "#C1272D"),
  lv: () => (
    <svg width="18" height="13" viewBox="0 0 6 4" style={{ borderRadius: 2, display: "block" }}>
      <rect width="6" height="1.6" y="0" fill="#9E3039"/><rect width="6" height="0.8" y="1.6" fill="#fff"/><rect width="6" height="1.6" y="2.4" fill="#9E3039"/>
    </svg>
  ),
  et: hFlag("#0072CE", "#000", "#fff"),
};

const LANGS = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "pl", label: "Polski" },
];

const THINKING_LEVELS = [
  { value: "off",     labelKey: "settings.thinkingOff",     Icon: CircleX,   disabled: true },
  { value: "minimal", labelKey: "settings.thinkingMinimal", Icon: Circle,    disabled: true },
  { value: "low",     labelKey: "settings.thinkingLow",     Icon: Lightbulb, disabled: true },
  { value: "medium",  labelKey: "settings.thinkingMedium",  Icon: Brain },
  { value: "high",    labelKey: "settings.thinkingHigh",    Icon: Sparkles },
  { value: "xhigh",   labelKey: "settings.thinkingXhigh",   Icon: Zap },
  { value: "max",     labelKey: "settings.thinkingMax",     Icon: Flame },
];

function ThinkingEffortDropdown({ openUpward = false }) {
  const { agentBusy, thinkingLevel, setThinkingLevel, sessionConfig, setSessionConfig, userId, serverConfig, t } = useContext(AppContext);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  // Show what THIS chat's session is actually running: the agent may have
  // raised the effort mid-run via set_llm_config. Falls back to the global pref.
  const effectiveLevel = sessionConfig?.thinkingLevel || thinkingLevel;
  const current = THINKING_LEVELS.find(l => l.value === effectiveLevel) || THINKING_LEVELS[3];
  // Active provider/model for the dropdown header. After the agent switched
  // this chat's profile, show the session's live model; otherwise serverConfig.llm,
  // the authoritative deployment config (Azure env vars or admin Settings).
  // Gated on a real profile switch so an unchanged chat keeps the deployment
  // label (session.model.provider is pi's internal id, not the VCA provider).
  const switched = !!sessionConfig?.activeProfileId;
  const activeProvider = (switched && sessionConfig?.provider) || serverConfig?.llm?.provider || "";
  const activeModelId = (switched && sessionConfig?.modelId) || serverConfig?.llm?.modelId || "";
  const TriggerIcon = current.Icon;
  // Changing the level calls reset-sessions, which would kill the in-flight
  // agent run. Lock the picker while any chat in the project is processing.
  const locked = agentBusy;

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => { if (locked) setOpen(false); }, [locked]);

  const choose = (value) => {
    setOpen(false);
    // No-op if the session already runs this level (whether from the global
    // pref or an agent switch) — avoids a needless global change + rebuild.
    if (value === effectiveLevel) return;
    setThinkingLevel(value);       // new global default
    // reset-sessions rebuilds this chat's session from the new global, so any
    // per-chat override the agent set no longer holds — drop the overlay.
    setSessionConfig(null);
    if (userId) {
      api(`/users/${userId}/reset-sessions`, { method: "POST", body: JSON.stringify({}) }).catch(() => {});
    }
  };

  return (
    <div ref={ref} className="thinking-dropdown-wrap">
      <Tip label={`${t("settings.thinkingLevel")}: ${t(current.labelKey)}`} side={openUpward ? "top" : "bottom"}>
        <button
          className={openUpward ? "" : "icon-btn-sm"}
          onClick={() => setOpen(o => !o)}
          disabled={locked}
        >
          <TriggerIcon size={14} />
        </button>
      </Tip>
      {open && (
        <div className={`thinking-dropdown${openUpward ? " up" : ""}`}>
          <div className="thinking-dropdown-header">
            <div className="thinking-dropdown-header-row">
              <span className="thinking-dropdown-header-label">{t("settings.llmProvider")}</span>
              <span className="thinking-dropdown-header-value">{activeProvider || "—"}</span>
            </div>
            <div className="thinking-dropdown-header-row">
              <span className="thinking-dropdown-header-label">{t("settings.modelId")}</span>
              <span className="thinking-dropdown-header-value" title={activeModelId}>{activeModelId || "—"}</span>
            </div>
          </div>
          {THINKING_LEVELS.map(l => {
            const ItemIcon = l.Icon;
            return (
              <button
                key={l.value}
                className={`thinking-dropdown-item${l.value === effectiveLevel ? " active" : ""}`}
                onClick={() => choose(l.value)}
                disabled={l.disabled}
              >
                <ItemIcon size={13} />
                <span>{t(l.labelKey)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The Settings dialog mutates the profile store (profile CRUD, config import)
// while ProfileSwitcherDropdown below keeps its own copy of the list — this
// event tells the switcher to re-fetch so changes show without a page reload.
function notifyLlmProfilesChanged() {
  window.dispatchEvent(new CustomEvent("vca-llm-profiles-changed"));
}

// Quick AI-profile switcher (sidebar footer, next to the effort control).
// Applies an LLM profile globally, then — because a chat session is built from
// vca-settings at build time and holds its old model until rebuilt — resets the
// user's sessions and auto-closes/reopens the open project so the new provider/
// model is live. Admin-only and hidden when the LLM is env-configured; switching
// is blocked while the agent is processing (mirrors the effort control).
function ProfileSwitcherDropdown() {
  const { state, agentBusy, userId, isAdmin, serverManaged, serverConfig, sessionConfig, setSessionConfig, reloadServerConfig, selectProject, closeProject, t } = useContext(AppContext);
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);

  const enabled = isAdmin && !serverManaged;
  // Block switching while any chat in the project is processing.
  const locked = agentBusy;

  const loadProfiles = useCallback(() => {
    if (!enabled) return;
    api("/admin/llm-profiles")
      .then((r) => {
        setProfiles(Array.isArray(r?.profiles) ? r.profiles : []);
        setActiveProfileId(typeof r?.activeProfileId === "string" ? r.activeProfileId : "");
      })
      .catch(() => setProfiles([]));
  }, [enabled]);

  // Load on mount and each time the menu opens (picks up profiles created or
  // renamed in Settings since last time).
  useEffect(() => { loadProfiles(); }, [loadProfiles]);
  useEffect(() => { if (open) loadProfiles(); }, [open, loadProfiles]);

  // Re-fetch when Settings mutates the store (profile CRUD, config import).
  // The switcher renders nothing while its list is empty, so without this an
  // import that introduces the first profiles could never surface the button.
  useEffect(() => {
    window.addEventListener("vca-llm-profiles-changed", loadProfiles);
    return () => window.removeEventListener("vca-llm-profiles-changed", loadProfiles);
  }, [loadProfiles]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Don't hold the menu open once the agent starts processing.
  useEffect(() => { if (locked) setOpen(false); }, [locked]);

  const switchProfile = async (id) => {
    // No-op if this chat already runs the profile (global pointer or an agent
    // override) — clicking the active item shouldn't trigger a global rebuild.
    if (locked || busy || id === (sessionConfig?.activeProfileId || activeProfileId)) { setOpen(false); return; }
    setBusy(true);
    setError(null);
    try {
      // 1. Apply globally (rewrites vca-settings.json, records activeProfileId).
      await api(`/admin/llm-profiles/${id}/apply`, { method: "POST", body: JSON.stringify({}) });
      setActiveProfileId(id);
      // The project is rebuilt from the new global config below, so any per-chat
      // override the agent set no longer holds — drop the overlay.
      setSessionConfig(null);
      // 2. Capture the open project BEFORE closing (closeProject nulls these).
      const pid = state.currentProjectId;
      const pname = state.currentProjectName;
      // 3. Close it, drop the stale agent sessions so the next run is built from
      //    the new config, and refresh the resolved server config...
      if (pid) await closeProject();
      if (userId) { try { await api(`/users/${userId}/reset-sessions`, { method: "POST", body: JSON.stringify({}) }); } catch {} }
      try { await reloadServerConfig(); } catch {}
      // 4. ...then reopen the same project so the change is live.
      if (pid) await selectProject(pid, pname);
      setOpen(false);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!enabled || profiles.length === 0) return null;

  // Highlight the profile THIS chat is actually running: the agent may have
  // switched it mid-run via set_llm_config. Falls back to the deployment's
  // active profile when there is no per-chat override.
  const effectiveProfileId = sessionConfig?.activeProfileId || activeProfileId;
  const activeName = profiles.find((p) => p.id === effectiveProfileId)?.name || "";
  // Show the live session model only after a per-chat switch; else the
  // deployment default (session.model.provider is pi's internal id).
  const switched = !!sessionConfig?.activeProfileId;
  const activeProvider = (switched && sessionConfig?.provider) || serverConfig?.llm?.provider || "";
  const activeModelId = (switched && sessionConfig?.modelId) || serverConfig?.llm?.modelId || "";

  return (
    <div ref={ref} className="profile-switcher-wrap">
      <Tip label={`${t("footer.aiProfile")}: ${activeName || "—"}`} side="top">
        <button onClick={() => setOpen((o) => !o)} disabled={locked || busy}>
          {busy ? <Loader size={14} className="spin" /> : <ArrowRightLeft size={14} />}
        </button>
      </Tip>
      {open && (
        <div className="thinking-dropdown up profile-switcher-menu">
          <div className="thinking-dropdown-header">
            <div className="thinking-dropdown-header-row">
              <span className="thinking-dropdown-header-label">{t("settings.llmProvider")}</span>
              <span className="thinking-dropdown-header-value">{activeProvider || "—"}</span>
            </div>
            <div className="thinking-dropdown-header-row">
              <span className="thinking-dropdown-header-label">{t("settings.modelId")}</span>
              <span className="thinking-dropdown-header-value" title={activeModelId}>{activeModelId || "—"}</span>
            </div>
          </div>
          {profiles.map((p) => (
            <button
              key={p.id}
              className={`thinking-dropdown-item${p.id === effectiveProfileId ? " active" : ""}`}
              onClick={() => switchProfile(p.id)}
              disabled={busy}
            >
              <ArrowRightLeft size={13} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
            </button>
          ))}
          {error && (
            <div style={{ fontSize: 11, color: "var(--error)", padding: "6px 8px", whiteSpace: "normal" }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function LangDropdown({ lang, setLang }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const currentLang = LANGS.find(l => l.code === lang) || LANGS[0];
  const FlagIcon = FLAG_SVG[currentLang.code] || FLAG_SVG.en;

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="lang-dropdown-wrap">
      <Tip label={currentLang.label} side="top">
        <button onClick={() => setOpen(o => !o)} className="lang-toggle-btn">
          <FlagIcon />
        </button>
      </Tip>
      {open && (
        <div className="lang-dropdown">
          {LANGS.map(l => {
            const F = FLAG_SVG[l.code] || FLAG_SVG.en;
            return (
              <button key={l.code} className={`lang-dropdown-item${l.code === lang ? " active" : ""}`} onClick={() => { setLang(l.code); setOpen(false); }}>
                <F /> <span>{l.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SidebarFooter() {
  const { setShowSkills, setShowSettings, theme, toggleTheme, t, lang, setLang, authEnabled, authUser, isAdmin } = useContext(AppContext);
  const [activeUsers, setActiveUsers] = useState(null);
  // The desktop (Electron) app is single-user — an active-users counter is
  // meaningless there, so skip both the polling and the icon.
  const isDesktop = typeof window !== "undefined" && !!window.vcaDesktop;

  useEffect(() => {
    if (!isAdmin || isDesktop) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        const data = await api("/admin/active-users");
        if (!cancelled) {
          setActiveUsers({
            count: data?.count ?? 0,
            names: Array.isArray(data?.users) ? data.users.map(u => u.displayName) : [],
          });
        }
      } catch { /* silent */ }
    };
    poll();
    const id = setInterval(poll, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isAdmin, isDesktop]);

  return (
    <div className="sidebar-footer">
      <Tip label={t("footer.skills")} side="top">
        <button onClick={() => setShowSkills(true)}>
          <Zap size={14} /> {t("footer.skills")}
        </button>
      </Tip>
      {isAdmin && (
        <Tip label={t("footer.settings")} side="top">
          <button onClick={() => setShowSettings(true)}>
            <Settings size={14} /> {t("footer.settings")}
          </button>
        </Tip>
      )}
      <ThinkingEffortDropdown openUpward />
      <ProfileSwitcherDropdown />
      {isAdmin && !isDesktop && activeUsers != null && (
        <Tip
          label={
            activeUsers.names.length === 0
              ? "No active users"
              : (
                <div style={{ textAlign: "left", maxWidth: 240 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Active users</div>
                  {activeUsers.names.map((name, i) => (
                    <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {name}
                    </div>
                  ))}
                </div>
              )
          }
          side="top"
          avoidCollisions={false}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
            <Users size={13} /> {activeUsers.count}
          </span>
        </Tip>
      )}
      <LangDropdown lang={lang} setLang={setLang} />
      <Tip label={theme === "dark" ? t("footer.lightMode") : t("footer.darkMode")} side="top">
        <button onClick={toggleTheme} className="theme-toggle-btn">
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </Tip>
      {authEnabled && authUser && (
        <Tip label={`Logout (${authUser.email})`} side="top">
          <button onClick={() => { window.location.href = "/auth/logout"; }} aria-label="Logout">
            <LogOut size={14} />
          </button>
        </Tip>
      )}
    </div>
  );
}

function Sidebar() {
  const { state, sidebarWidth, setSidebarWidth } = useContext(AppContext);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const MIN_WIDTH = 380;

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current) return;
      const maxWidth = Math.min(900, window.innerWidth * 0.8);
      setSidebarWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, e.clientX)));
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        setIsDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        const shell = document.querySelector(".app-shell");
        if (shell) shell.classList.remove("sidebar-resizing");
      }
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [setSidebarWidth]);

  const startResize = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const shell = document.querySelector(".app-shell");
    if (shell) shell.classList.add("sidebar-resizing");
  };

  return (
    <>
      <aside className={`sidebar${state.sidebarOpen ? " open" : ""}`}>
        <SidebarHeader />
        <ChatSection />
        <SidebarFooter />
      </aside>
      {state.sidebarOpen && (
        <div
          className="sidebar-resize-handle"
          onMouseDown={startResize}
          style={{ left: `${sidebarWidth - 4}px` }}
        />
      )}
      {isDragging && <div className="sidebar-resize-overlay" />}
    </>
  );
}

// ─── Right Sidebar (Server Log) ─────────────────────────────

function RightSidebar() {
  const { state, userId, refreshPreview, serverLogLines, setServerLogLines, previewState, applyPreviewState, t } = useContext(AppContext);
  const logContainerRef = useRef(null);
  const [processLogs, setProcessLogs] = useState("");

  const clearLogs = useCallback(async () => {
    if (!state.currentProjectId || !userId) return;
    setProcessLogs("");
    setServerLogLines([]);
    try {
      await api(`/projects/${state.currentProjectId}/server-logs/clear`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
    } catch (err) {
      console.error("clear logs failed", err);
    }
  }, [state.currentProjectId, userId, setServerLogLines]);

  useEffect(() => {
    if (!state.rightSidebarOpen || !state.currentProjectId || !userId) return;
    (async () => {
      try {
        const data = await api(`/projects/${state.currentProjectId}/process-status?userId=${encodeURIComponent(userId)}`);
        const { logs, ...nextState } = data;
        applyPreviewState(nextState);
        setProcessLogs(data.logs || "");
      } catch { /* ignore */ }
    })();
  }, [state.rightSidebarOpen, state.currentProjectId, userId, applyPreviewState]);

  useEffect(() => {
    const el = logContainerRef.current;
    if (!el || !state.rightSidebarOpen) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [serverLogLines, state.rightSidebarOpen]);

  const restartProcess = useCallback(async () => {
    if (!state.currentProjectId || !userId) return;
    try {
      const res = await api(`/projects/${state.currentProjectId}/restart-process?userId=${userId}`, { method: "POST" });
      const { logs, ...nextState } = res;
      applyPreviewState(nextState);
      setProcessLogs("");
    } catch (err) {
      console.error("restart failed", err);
    }
  }, [state.currentProjectId, userId, applyPreviewState]);

  return (
    <aside className={`right-sidebar${state.rightSidebarOpen ? " open" : ""}`}>
      <div className="right-sidebar-header">
        <div className="process-info-status">
          <span className={`process-info-status-dot${previewState.running ? " running" : ""}`} />
          {previewState.running
            ? t("preview.processRunning").replace("{port}", previewState.port)
            : t("preview.processStopped")}
        </div>
        <div className="right-sidebar-actions">
          <Tip label={t("preview.reload")} side="left">
            <button className="preview-action-btn" onClick={refreshPreview}>
              <RefreshCw size={15} />
            </button>
          </Tip>
          <Tip label={t("preview.restart")} side="left">
            <button className="preview-action-btn" onClick={restartProcess}>
              <RotateCcw size={15} />
            </button>
          </Tip>
          <Tip label={t("preview.clearLogs")} side="left">
            <button className="preview-action-btn" onClick={clearLogs}>
              <Trash2 size={15} />
            </button>
          </Tip>
        </div>
      </div>
      <div className="right-sidebar-logs" ref={logContainerRef}>
        {serverLogLines.length === 0 && !processLogs
          ? <div className="process-info-no-logs">{t("preview.noLogs")}</div>
          : <>
              {processLogs && processLogs.split("\n").map((rawLine, i) => {
                const parsed = parseHistoricalLogLine(rawLine);
                const ts = parsed?.ts ?? null;
                const line = parsed?.line ?? rawLine;
                const stream = line.startsWith("[stderr]") ? "stderr" : "stdout";
                const sev = classifyServerLogLine(stream, line);
                const cls = sev ? ` ${sev}` : "";
                return (
                  <div key={`h${i}`} className={`process-info-log-line${cls}`}>
                    {ts !== null && <span className="log-ts" title={new Date(ts).toISOString()}>{formatLogTime(ts)} </span>}
                    {line}
                  </div>
                );
              })}
              {serverLogLines.map((entry, i) => {
                const sev = classifyServerLogLine(entry.stream, entry.line);
                const cls = sev ? ` ${sev}` : "";
                return (
                  <div key={`l${i}`} className={`process-info-log-line${cls}`}>
                    <span className="log-ts" title={new Date(entry.ts).toISOString()}>{formatLogTime(entry.ts)} </span>
                    {`[${entry.stream}] ${entry.line}`}
                  </div>
                );
              })}
            </>
        }
      </div>
    </aside>
  );
}

function RightSidebarToggle() {
  const { state, dispatch, t, serverLogPulse } = useContext(AppContext);
  const pulseClass = serverLogPulse === "error" ? " pulse-error" : serverLogPulse === "warn" ? " pulse-warn" : "";
  return (
    <Tip label={state.rightSidebarOpen ? t("sidebar.closeServerLog") : t("sidebar.openServerLog")} side="left">
      <button
        className={`right-sidebar-toggle-btn${state.rightSidebarOpen ? " open" : ""}${pulseClass}`}
        onClick={() => dispatch({ type: "TOGGLE_RIGHT_SIDEBAR" })}
      >
        {state.rightSidebarOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
      </button>
    </Tip>
  );
}

// ─── Dialogs ─────────────────────────────────────────────────

const AUTH_SECRET_SENTINEL = "<unchanged>";

function AuthenticationTab({ t, userId, onAuthFlip, registerSave }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [config, setConfig] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [secretDirty, setSecretDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [testResult, setTestResult] = useState(null);

  const redirectUri = typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : "";

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await api("/admin/auth-config");
      const cfg = data?.config || {};
      setConfig(cfg);
      setEnabled(cfg.enabled === true);
      setTenantId(cfg.tenantId || "");
      setClientId(cfg.clientId || "");
      setClientSecret(cfg.clientSecretSet ? AUTH_SECRET_SENTINEL : "");
      setSecretDirty(false);
      setError("");
      setSuccess("");
      setTestResult(null);
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const copyRedirect = async () => {
    try { await navigator.clipboard.writeText(redirectUri); setSuccess("Redirect URI copied"); setTimeout(() => setSuccess(""), 1500); } catch { /* ignore */ }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      const body = { tenantId, clientId };
      if (secretDirty) body.clientSecret = clientSecret;
      const data = await api("/admin/auth-config/test-connection", { method: "POST", body: JSON.stringify(body) });
      setTestResult(data);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setTesting(false);
    }
  };

  const save = async (nextEnabled) => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const body = {
        enabled: !!nextEnabled,
        tenantId,
        clientId,
        clientSecret: secretDirty ? clientSecret : AUTH_SECRET_SENTINEL,
      };
      const data = await api("/admin/auth-config", { method: "PUT", body: JSON.stringify(body) });
      const cfg = data?.config || {};
      setConfig(cfg);
      setEnabled(cfg.enabled === true);
      setTenantId(cfg.tenantId || "");
      setClientId(cfg.clientId || "");
      setClientSecret(cfg.clientSecretSet ? AUTH_SECRET_SENTINEL : "");
      setSecretDirty(false);
      const justEnabledFromDisabled = nextEnabled && (config?.enabled !== true);
      const justDisabledFromEnabled = !nextEnabled && (config?.enabled === true);
      if (justEnabledFromDisabled) {
        setSuccess("OAuth enabled — redirecting to sign-in…");
        setTimeout(() => { window.location.href = "/auth/login"; }, 600);
        return;
      }
      if (justDisabledFromEnabled) {
        setSuccess("OAuth disabled — reloading in anonymous mode…");
        setTimeout(() => { window.location.reload(); }, 600);
        return;
      }
      setSuccess(nextEnabled ? "Saved (OAuth on)" : "Saved (OAuth off)");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  // Footer save wiring: dirty vs the last-loaded config; the settings dialog
  // renders the actual Save button bottom-right.
  const dirty = !!config && (
    enabled !== (config.enabled === true) ||
    tenantId !== (config.tenantId || "") ||
    clientId !== (config.clientId || "") ||
    secretDirty
  );
  useEffect(() => {
    if (!registerSave) return;
    registerSave({ dirty, busy: saving || testing, save: () => save(enabled) });
    return () => registerSave(null);
  }, [dirty, saving, testing, enabled, tenantId, clientId, clientSecret, secretDirty, config]);

  if (loading) {
    return <div className="modal-label" style={{ color: "var(--text-muted)" }}>Loading…</div>;
  }

  const showEnableWarning = !config?.enabled && enabled;
  const showDisableWarning = config?.enabled && !enabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="modal-label">
        Redirect URI
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <input type="text" readOnly value={redirectUri} className="modal-input" style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }} />
          <button type="button" className="btn-secondary" onClick={copyRedirect}>Copy</button>
        </div>
        <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Register this exact URI as a redirect URI on the Entra app.
        </span>
      </div>

      <label className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enable Entra OAuth</span>
        {config?.source === "env" && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>
            (current values come from env vars; saving here writes auth-config.json)
          </span>
        )}
      </label>

      <label className="modal-label">
        Tenant ID
        <input
          type="text"
          className="modal-input"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="11111111-2222-3333-4444-555555555555"
          autoComplete="off"
        />
      </label>

      <label className="modal-label">
        Client ID
        <input
          type="text"
          className="modal-input"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="66666666-7777-8888-9999-000000000000"
          autoComplete="off"
        />
      </label>

      <label className="modal-label">
        Client Secret
        <input
          type="password"
          className="modal-input"
          value={clientSecret}
          onChange={(e) => { setClientSecret(e.target.value); setSecretDirty(true); }}
          onFocus={() => {
            if (!secretDirty && clientSecret === AUTH_SECRET_SENTINEL) {
              setClientSecret("");
              setSecretDirty(true);
            }
          }}
          placeholder={config?.clientSecretSet && !secretDirty ? "•••• (set; click to change)" : "Client secret value"}
          autoComplete="new-password"
        />
      </label>

      {showEnableWarning && (
        <div style={{ background: "#fff7ed", border: "1px solid #fdba74", color: "#9a3412", fontSize: 12, padding: 8 }}>
          Enabling OAuth will sign you out of this tab and redirect to Entra. Make sure the redirect URI above is registered on the Entra app and that you can sign in.
        </div>
      )}
      {showDisableWarning && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b", fontSize: 12, padding: 8 }}>
          Disabling OAuth drops everyone to anonymous-cookie mode. Any visitor of this site will be treated as an administrator until OAuth is re-enabled.
        </div>
      )}

      <div className="modal-actions" style={{ marginTop: 8, justifyContent: "flex-start" }}>
        <button type="button" className="btn-secondary" disabled={testing || saving || !tenantId.trim()} onClick={runTest}>
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      {testResult && testResult.ok && (
        <div style={{ color: "#166534", fontSize: 12 }}>
          Connection OK — token endpoint reachable.
        </div>
      )}
      {testResult && !testResult.ok && (
        <div style={{ color: "#dc2626", fontSize: 12 }}>
          Test failed at {testResult.stage}: {testResult.message}
        </div>
      )}
      {error && (
        <div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>
      )}
      {success && (
        <div style={{ color: "#166534", fontSize: 12 }}>{success}</div>
      )}
      {loadError && (
        <div style={{ color: "#dc2626", fontSize: 12 }}>{loadError}</div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)" }}>
        Config persists to <code>{`${"${WORKSPACES_ROOT}"}/admin/auth-config.json`}</code>. Recovery: edit that file on disk and set <code>enabled: false</code>.
      </div>
    </div>
  );
}

function NetworkTab({ t, registerSave }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tlsVerify, setTlsVerify] = useState(true);
  const [savedTlsVerify, setSavedTlsVerify] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await api("/admin/network-settings");
      const v = data?.tlsVerificationEnabled !== false;
      setTlsVerify(v);
      setSavedTlsVerify(v);
      setError("");
      setSuccess("");
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const data = await api("/admin/network-settings", {
        method: "PUT",
        body: JSON.stringify({ tlsVerificationEnabled: tlsVerify }),
      });
      const v = data?.tlsVerificationEnabled !== false;
      setTlsVerify(v);
      setSavedTlsVerify(v);
      setSuccess(v
        ? (t("settings.network.savedOn") || "Saved — TLS verification enabled")
        : (t("settings.network.savedOff") || "Saved — TLS verification disabled"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  // Footer save wiring — the settings dialog renders the Save button.
  const dirty = tlsVerify !== savedTlsVerify;
  useEffect(() => {
    if (!registerSave) return;
    registerSave({ dirty, busy: saving, save });
    return () => registerSave(null);
  }, [dirty, saving, tlsVerify]);

  if (loading) {
    return <div className="modal-label" style={{ color: "var(--text-muted)" }}>Loading…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="settings-section-title">
        <ShieldCheck size={14} /> {t("settings.network.tlsSection") || "TLS certificate verification"}
      </div>

      <label className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={tlsVerify}
          onChange={(e) => setTlsVerify(e.target.checked)}
        />
        <span>{t("settings.network.tlsToggle") || "Verify TLS certificates on outbound connections"}</span>
      </label>
      <span style={{ marginLeft: 24, color: "var(--text-muted)", fontSize: 11 }}>
        {t("settings.network.tlsHint") || "Applies globally to the server and the apps and tools it launches. Keep enabled unless a trusted TLS-intercepting proxy requires it off."}
      </span>

      {!tlsVerify && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b", fontSize: 12, padding: 8, marginTop: 8 }}>
          {t("settings.network.tlsWarning") || "Disabling verification turns off certificate checks for ALL outbound HTTPS — Entra token exchange, Microsoft Graph, LLM providers, and git/npm — exposing them to man-in-the-middle interception. Only disable behind a trusted corporate proxy."}
        </div>
      )}

      {error && (<div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>)}
      {success && (<div style={{ color: "#166534", fontSize: 12 }}>{success}</div>)}
      {loadError && (<div style={{ color: "#dc2626", fontSize: 12 }}>{loadError}</div>)}

      <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)" }}>
        {t("settings.network.tlsPersistNote") || "Persists to"} <code>{`${"${WORKSPACES_ROOT}"}/admin/vca-settings.json`}</code>{t("settings.network.tlsApplyNote") || " and applies immediately to new connections."}
      </div>
    </div>
  );
}

// Settings → Storage (desktop app only): choose the physical folder where VCA
// keeps all workspaces and settings. The workspace root is fixed at startup
// (src/paths.ts), so a change is STAGED via the window.vcaDesktop bridge and the
// Electron main process applies it on the next launch — either moving the current
// data into the new folder or starting fresh there. This tab is rendered only
// when the desktop bridge is present.
function StorageTab({ t }) {
  const bridge = (typeof window !== "undefined" && window.vcaDesktop) || null;
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null); // { root, defaultRoot, pending }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(null); // folder awaiting move/new/existing choice
  const [volume, setVolume] = useState(null); // { kind, uncTarget, driveLetterPath, syncProvider }
  const [accepted, setAccepted] = useState(false); // "I understand" for network/cloud roots
  const [uncShare, setUncShare] = useState(null); // share to offer a drive mapping for

  const load = async () => {
    if (!bridge) { setLoading(false); return; }
    setLoading(true);
    setError("");
    try {
      const data = await bridge.getStorageInfo();
      setInfo(data || null);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Map the main-process validation codes to friendly, translatable messages.
  const errorText = (code) => {
    switch (code) {
      case "empty": return t("settings.storage.errEmpty") || "Please choose a folder.";
      case "same": return t("settings.storage.errSame") || "That is already your current workspace folder.";
      case "nested": return t("settings.storage.errNested") || "Choose a folder that isn't inside the current workspace folder (or the other way around).";
      case "notEmpty": return t("settings.storage.errNotEmpty") || "To move your workspace, choose an empty folder.";
      case "hasData": return t("settings.storage.errHasData") || "That folder already contains VCA data. Choose an empty folder to start fresh.";
      case "noData": return t("settings.storage.errNoData") || "That folder doesn't contain a VCA workspace. Choose the folder that already holds your VCA data.";
      case "notWritable": return t("settings.storage.errNotWritable") || "That folder can't be written to. Choose another location.";
      case "uncPath": return t("settings.storage.errUnc") || "VCA can't use a \\\\server\\share path directly — the Windows build tools don't support it. Map it to a drive letter (for example Y:) and choose that instead.";
      case "unacknowledged": return t("settings.storage.errUnacknowledged") || "Please confirm you understand the warning before continuing.";
      default: return t("settings.storage.errGeneric") || "That folder can't be used. Choose another location.";
    }
  };

  // Hazards that don't block, but must be acknowledged. Mirrors the main
  // process's validateRootChange so the dialog can show them before staging.
  const warningsFor = (vol) => {
    if (!vol) return [];
    if (vol.kind === "networkMapped" || vol.kind === "networkUnc") return ["networkDrive"];
    if (vol.kind === "cloudSync") return ["cloudSync"];
    return [];
  };

  const warningText = (code) => {
    switch (code) {
      case "networkDrive":
        return t("settings.storage.warnNetworkDrive") || "This folder is on a network drive. VCA will work, but builds and dependency installs will be noticeably slower, and each project's dependencies have to stay on the share. Only one person can work on a project at a time.";
      case "cloudSync":
        return t("settings.storage.warnCloudSync") || "This folder is synced to the cloud. VCA will keep each project's dependencies in a local cache instead, so the sync doesn't have to handle tens of thousands of files.";
      default:
        return "";
    }
  };

  const chooseFolder = async () => {
    setError("");
    setUncShare(null);
    try {
      const folder = await bridge.pickFolder();
      if (!folder) return;
      let vol = null;
      try {
        vol = bridge.inspectFolder ? await bridge.inspectFolder(folder) : null;
      } catch { /* classification is advisory — fall through unclassified */ }

      // A raw \\server\share root can never build. Don't offer the mode choice;
      // surface the remedy (map it to a drive letter) instead.
      if (vol && vol.kind === "networkUnc" && !vol.driveLetterPath) {
        setUncShare(vol.uncTarget || folder);
        setError(errorText("uncPath"));
        return;
      }
      setVolume(vol);
      setAccepted(false);
      setPicked(folder);
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const mapDrive = async () => {
    if (!uncShare || !bridge.mapNetworkDrive) return;
    setBusy(true);
    setError("");
    try {
      const res = await bridge.mapNetworkDrive(uncShare);
      if (!res || !res.ok) {
        setError(t("settings.storage.mapDriveFailed") || "Couldn't map that share to a drive letter. Map it in File Explorer, then choose the drive letter here.");
      } else {
        setUncShare(null);
        setError("");
        setVolume({ kind: "networkMapped" });
        setAccepted(false);
        setPicked(res.path);
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const stage = async (mode) => {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const res = await bridge.stageRootChange({ newRoot: picked, mode, acceptedWarnings: warningsFor(volume) });
      if (!res || !res.ok) {
        setError(errorText(res && res.error));
        setPicked(null);
      } else {
        setPicked(null);
        await load();
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelPending = async () => {
    setBusy(true);
    setError("");
    try {
      await bridge.cancelPendingChange();
      await load();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!bridge) return null;
  if (loading) {
    return <div className="modal-label" style={{ color: "var(--text-muted)" }}>{t("common.loading") || "Loading…"}</div>;
  }

  const pending = info?.pending || null;
  const codeStyle = { display: "block", padding: "6px 8px", background: "var(--code-bg, rgba(127,127,127,0.12))", borderRadius: 4, wordBreak: "break-all", fontSize: 12, marginTop: 4 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="settings-section-title">
        <HardDrive size={14} /> {t("settings.storage.section") || "Workspace storage"}
      </div>
      <div className="modal-label" style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 4 }}>
        {t("settings.storage.intro") || "The folder on this computer where VCA keeps all your projects and settings."}
      </div>

      <label className="modal-label">
        {t("settings.storage.currentFolder") || "Current folder"}
        <code style={codeStyle}>{info?.root || ""}</code>
      </label>

      {pending ? (
        <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", fontSize: 13, padding: 10, borderRadius: 6, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t("settings.storage.pendingTitle") || "Restart VCA to apply"}</div>
              <div>
                {pending.mode === "move"
                  ? (t("settings.storage.pendingMove") || "Next time you start VCA, your workspace will be moved to:")
                  : pending.mode === "existing"
                    ? (t("settings.storage.pendingExisting") || "Next time you start VCA, it will switch to the existing workspace at:")
                    : (t("settings.storage.pendingNew") || "Next time you start VCA, it will switch to a fresh, empty workspace at:")}
              </div>
              <code style={{ display: "block", marginTop: 4, wordBreak: "break-all", fontSize: 12 }}>{pending.newRoot}</code>
            </div>
          </div>
          <div className="modal-actions" style={{ marginTop: 0 }}>
            <button type="button" className="btn-secondary" disabled={busy} onClick={cancelPending}>
              <RotateCcw size={14} /> {t("settings.storage.cancelPending") || "Cancel change"}
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button type="button" className="btn-primary" disabled={busy} onClick={chooseFolder}>
            <FolderOpen size={14} /> {t("settings.storage.changeBtn") || "Change folder…"}
          </button>
        </div>
      )}

      {error && <div style={{ color: "var(--error, #dc2626)", fontSize: 12 }}>{error}</div>}

      {/* A rejected UNC root is a dead end unless we offer the way out. */}
      {uncShare && (
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button type="button" className="btn-secondary" disabled={busy} onClick={mapDrive}>
            <HardDrive size={14} /> {t("settings.storage.mapDriveBtn") || "Map a drive letter"}
          </button>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>
        {t("settings.storage.restartNote") || "A folder change takes effect the next time you start VCA."}
      </div>

      {/* Move vs. start-fresh choice for the picked folder. */}
      <AlertDialog.Root open={!!picked} onOpenChange={(o) => { if (!o && !busy) setPicked(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="alert-overlay" />
          <AlertDialog.Content className="alert-content">
            <AlertDialog.Title className="alert-title">
              <HardDrive size={18} style={{ color: "var(--accent)" }} />
              {t("settings.storage.choiceTitle") || "Use this folder"}
            </AlertDialog.Title>
            <AlertDialog.Description className="alert-description">
              {t("settings.storage.choiceMessage") || "What should happen with your current projects and settings?"}
            </AlertDialog.Description>
            <code style={codeStyle}>{picked || ""}</code>

            {/* Network / cloud-synced targets work, but with consequences the
                user only discovers much later — the change applies at the next
                boot. Show them here and require an explicit acknowledgement,
                which stageRootChange re-checks before writing anything. */}
            {warningsFor(volume).length > 0 && (
              <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", fontSize: 12, padding: 10, borderRadius: 6, marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {warningsFor(volume).map((code) => (
                  <div key={code} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>{warningText(code)}</span>
                  </div>
                ))}
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 600, cursor: "pointer" }}>
                  <input type="checkbox" checked={accepted} disabled={busy} onChange={(e) => setAccepted(e.target.checked)} />
                  {t("settings.storage.warnAccept") || "I understand"}
                </label>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              <button type="button" className="btn-primary" disabled={busy || (warningsFor(volume).length > 0 && !accepted)} onClick={() => stage("move")}>
                {t("settings.storage.moveOption") || "Move my current workspace here"}
              </button>
              <span style={{ marginLeft: 2, color: "var(--text-muted)", fontSize: 11 }}>
                {t("settings.storage.moveHint") || "Copies everything to the new folder and switches to it."}
              </span>
              <button type="button" className="btn-secondary" disabled={busy || (warningsFor(volume).length > 0 && !accepted)} onClick={() => stage("existing")} style={{ marginTop: 4 }}>
                {t("settings.storage.existingOption") || "Use the workspace already in this folder"}
              </button>
              <span style={{ marginLeft: 2, color: "var(--text-muted)", fontSize: 11 }}>
                {t("settings.storage.existingHint") || "Points VCA at data already here, copying nothing. Your current data stays where it is."}
              </span>
              <button type="button" className="btn-secondary" disabled={busy || (warningsFor(volume).length > 0 && !accepted)} onClick={() => stage("new")} style={{ marginTop: 4 }}>
                {t("settings.storage.newOption") || "Start a fresh, empty workspace here"}
              </button>
              <span style={{ marginLeft: 2, color: "var(--text-muted)", fontSize: 11 }}>
                {t("settings.storage.newHint") || "Leaves your current data where it is and begins new here."}
              </span>
            </div>
            <div className="modal-actions">
              <AlertDialog.Cancel asChild>
                <button type="button" className="btn-secondary" disabled={busy}>{t("common.cancel")}</button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

// Settings → Version Control: manage named global VCS profiles (GitHub or
// Azure DevOps). The PAT is encrypted at rest and round-trips as the sentinel.
function VersionControlTab({ t }) {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(null); // draft: {id?, name, provider, host, organization, project, username, pat}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await api("/admin/vcs-profiles");
      setProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const blankDraft = () => ({ name: "", provider: "github", host: "", organization: "", project: "", username: "", pat: "" });
  const providerLabel = (pr) =>
    pr === "azure-devops" ? (t("settings.vcs.providerAzure") || "Azure DevOps") : (t("settings.vcs.providerGithub") || "GitHub");

  const saveEditing = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setError(t("settings.vcs.nameRequired") || "Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const body = {
        name: editing.name.trim(),
        provider: editing.provider,
        host: editing.host.trim(),
        organization: editing.organization.trim(),
        project: editing.project.trim(),
        username: editing.username.trim(),
        pat: editing.pat,
      };
      const data = editing.id
        ? await api(`/admin/vcs-profiles/${editing.id}`, { method: "PUT", body: JSON.stringify(body) })
        : await api("/admin/vcs-profiles", { method: "POST", body: JSON.stringify(body) });
      setProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
      setEditing(null);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    setError("");
    try {
      const data = await api(`/admin/vcs-profiles/${pendingDelete.id}`, { method: "DELETE" });
      setProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
      if (editing && editing.id === pendingDelete.id) setEditing(null);
      setPendingDelete(null);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="modal-label" style={{ color: "var(--text-muted)" }}>Loading…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="settings-section-title">
        <GitBranch size={14} /> {t("settings.vcs.section") || "Version control profiles"}
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
        {t("settings.vcs.hint") || "Named GitHub or Azure DevOps credentials. Projects choose a profile in their settings; the PAT is encrypted at rest."}
      </span>
      {loadError && <div style={{ color: "var(--error)", fontSize: 12 }}>{loadError}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {profiles.length === 0 && !editing && (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("settings.vcs.empty") || "No profiles yet."}</span>
        )}
        {profiles.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border, #333)", borderRadius: 6, padding: "6px 8px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {providerLabel(p.provider)} · {p.host || "—"}{p.organization ? ` / ${p.organization}` : ""}
              </div>
            </div>
            <button type="button" className="btn-secondary" style={{ padding: "4px 8px" }} onClick={() => { setError(""); setEditing({ ...p }); }}>
              <Pencil size={14} />
            </button>
            <button type="button" className="btn-secondary" style={{ padding: "4px 8px" }} onClick={() => setPendingDelete(p)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {!editing && (
        <div>
          <button type="button" className="btn-secondary" onClick={() => { setError(""); setEditing(blankDraft()); }}>
            <Plus size={14} /> {t("settings.vcs.add") || "Add profile"}
          </button>
        </div>
      )}

      {editing && (
        <div style={{ border: "1px solid var(--border, #333)", borderRadius: 6, padding: 10, display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          <label className="modal-label">
            {t("settings.vcs.name") || "Name"}
            <input className="modal-input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>
          <label className="modal-label">
            {t("settings.vcs.provider") || "Provider"}
            <select className="modal-input" value={editing.provider} onChange={(e) => setEditing({ ...editing, provider: e.target.value })}>
              <option value="github">{t("settings.vcs.providerGithub") || "GitHub"}</option>
              <option value="azure-devops">{t("settings.vcs.providerAzure") || "Azure DevOps"}</option>
            </select>
          </label>
          <label className="modal-label">
            {t("settings.vcs.host") || "Host"}
            <input
              className="modal-input"
              value={editing.host}
              placeholder={editing.provider === "azure-devops" ? "dev.azure.com" : "github.com"}
              onChange={(e) => setEditing({ ...editing, host: e.target.value })}
            />
          </label>
          <label className="modal-label">
            {t("settings.vcs.organization") || "Organization / owner"}
            <input className="modal-input" value={editing.organization} onChange={(e) => setEditing({ ...editing, organization: e.target.value })} />
          </label>
          {editing.provider === "azure-devops" && (
            <label className="modal-label">
              {t("settings.vcs.project") || "Project"}
              <input className="modal-input" value={editing.project} onChange={(e) => setEditing({ ...editing, project: e.target.value })} />
            </label>
          )}
          <label className="modal-label">
            {t("settings.vcs.username") || "Username (optional)"}
            <input className="modal-input" value={editing.username} autoComplete="off" onChange={(e) => setEditing({ ...editing, username: e.target.value })} />
          </label>
          <label className="modal-label">
            {t("settings.vcs.pat") || "Password / PAT"}
            <input
              type="password"
              className="modal-input"
              value={editing.pat}
              autoComplete="new-password"
              placeholder={editing.id && editing.pat === AUTH_SECRET_SENTINEL ? (t("settings.vcs.patPlaceholder") || "leave unchanged") : ""}
              onFocus={() => { if (editing.pat === AUTH_SECRET_SENTINEL) setEditing((e2) => ({ ...e2, pat: "" })); }}
              onChange={(e) => setEditing({ ...editing, pat: e.target.value })}
            />
          </label>
          {error && <div style={{ color: "var(--error)", fontSize: 12 }}>{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-primary" disabled={busy} onClick={saveEditing}>
              <Save size={14} /> {t("common.save")}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setEditing(null); setError(""); }}>
              <X size={14} /> {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
      {!editing && error && <div style={{ color: "var(--error)", fontSize: 12 }}>{error}</div>}

      <AlertDialog.Root open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="alert-overlay" />
          <AlertDialog.Content className="alert-content">
            <AlertDialog.Title className="alert-title">{t("settings.vcs.deleteTitle") || "Delete profile"}</AlertDialog.Title>
            <AlertDialog.Description className="alert-description">
              {(t("settings.vcs.deleteMessage") || 'Delete profile "{name}"? Projects using it will need a new profile.').replace("{name}", pendingDelete?.name || "")}
            </AlertDialog.Description>
            <div className="modal-actions">
              <button type="button" className="btn-danger" disabled={busy} onClick={confirmDelete}>
                <Trash2 size={14} /> {t("common.delete") || "Delete"}
              </button>
              <AlertDialog.Cancel asChild>
                <button type="button" className="btn-secondary" disabled={busy}>{t("common.cancel")}</button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function EnvironmentTab({ t, registerSave }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rows, setRows] = useState([]); // { key, value, secret }
  // Last-loaded/saved rows as a comparable string — drives the footer Save's
  // dirty highlight.
  const [savedRowsJson, setSavedRowsJson] = useState("[]");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const toRows = (vars) =>
    (Array.isArray(vars) ? vars : []).map((v) => ({
      key: v.key || "",
      value: v.value ?? "",
      secret: v.secret === true,
    }));

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await api("/admin/env-vars");
      const loaded = toRows(data?.vars);
      setRows(loaded);
      setSavedRowsJson(JSON.stringify(loaded));
      setError("");
      setSuccess("");
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const update = (i, patch) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { key: "", value: "", secret: false }]);
  const removeRow = (i) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  // Toggling secret clears the value so a stale sentinel is never mis-sent.
  const toggleSecret = (i) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, secret: !r.secret, value: "" } : r)));

  const save = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const payload = rows.map((r) => ({ key: r.key.trim(), secret: r.secret, value: r.value }));
      const data = await api("/admin/env-vars", { method: "PUT", body: JSON.stringify({ vars: payload }) });
      const savedRows = toRows(data?.vars);
      setRows(savedRows);
      setSavedRowsJson(JSON.stringify(savedRows));
      setSuccess(t("settings.environment.saved") || "Saved");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  // Footer save wiring — the settings dialog renders the Save button.
  const dirty = JSON.stringify(rows) !== savedRowsJson;
  useEffect(() => {
    if (!registerSave) return;
    registerSave({ dirty, busy: saving, save });
    return () => registerSave(null);
  }, [dirty, saving, rows]);

  if (loading) {
    return <div className="modal-label" style={{ color: "var(--text-muted)" }}>Loading…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="settings-section-title">
        <Terminal size={14} /> {t("settings.environment.title") || "Environment variables"}
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
        {t("settings.environment.hint") || "Available to VCA, the preview process, and deployed apps. Mark sensitive values as Secret — they are encrypted at rest and never shown again."}
      </span>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
        {rows.length === 0 && (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("settings.environment.empty") || "No variables yet."}</span>
        )}
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="text"
              className="modal-input"
              style={{ flex: "0 0 34%", fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
              placeholder="NAME"
              value={r.key}
              autoComplete="off"
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <input
              type={r.secret ? "password" : "text"}
              className="modal-input"
              style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
              placeholder={r.secret ? "secret value" : "value"}
              value={r.value}
              autoComplete="off"
              onFocus={() => { if (r.secret && r.value === AUTH_SECRET_SENTINEL) update(i, { value: "" }); }}
              onChange={(e) => update(i, { value: e.target.value })}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={r.secret} onChange={() => toggleSecret(i)} />
              {t("settings.environment.secret") || "Secret"}
            </label>
            <button type="button" className="btn-secondary" title="Remove" style={{ padding: "4px 8px" }} onClick={() => removeRow(i)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <div>
        <button type="button" className="btn-secondary" onClick={addRow}>
          <Plus size={14} /> {t("settings.environment.add") || "Add variable"}
        </button>
      </div>

      <div style={{ background: "#fff7ed", border: "1px solid #fdba74", color: "#9a3412", fontSize: 12, padding: 8 }}>
        {t("settings.environment.deployNote") || "Secrets are encrypted at rest and injected into the server, preview, and deployed apps. For Azure (git-tag) deployments only secret NAMES are written to vca-env.yaml — their values must be supplied by your pipeline (Key Vault / variable group)."}
      </div>

      {error && (<div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>)}
      {success && (<div style={{ color: "#166534", fontSize: 12 }}>{success}</div>)}
      {loadError && (<div style={{ color: "#dc2626", fontSize: 12 }}>{loadError}</div>)}
    </div>
  );
}

// Compact display for context-window sizes: 200000 → "200k", 1000000 → "1M".
function formatTokenCount(n) {
  if (!n || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
}

// Price as a bare number string (the i18n key supplies the "$" prefix).
function formatModelPrice(n) {
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return String(+n.toFixed(2));
  return String(+n.toFixed(4));
}

// Lifetime project spend: "<$0.01", "$1.23", "$123" — null when nothing to show.
function formatProjectCost(usd) {
  if (usd == null || !(usd > 0)) return null;
  if (usd < 0.01) return "<$0.01";
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

// One CSV cell: quote-wrap and double any internal quotes when the value
// contains a comma, quote or newline (RFC-4180 style). Empty/null → "".
function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Turn a project name into a filename-safe slug for exports: only keep
// [A-Za-z0-9-_], collapse runs to one "-", trim edge "-", fall back to "project".
function csvSlug(name) {
  const slug = String(name || "").replace(/[^A-Za-z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

// Local-date YYYYMMDD for export filenames.
function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// Flattens a chat's persisted messages into CSV — one row per event (user
// message, assistant message, each assistant tool call, each tool result), so
// the export carries every attribute (datetime, model, delta cost, tool calls).
function buildChatCsv(messages, chatName) {
  const row = (cells) => cells.map(csvField).join(",");
  const lines = [
    row(["Chat", chatName || "chat"]),
    row(["Generated", new Date().toISOString()]),
    "",
    row(["Datetime", "Role", "User", "Model", "Reasoning", "DeltaCostUSD", "Message", "ToolName", "ToolArgs", "ToolResult", "IsError"]),
  ];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const ts = msg.ts || "";
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      lines.push(row([ts, "user", msg.author || "User", "", "", "", msg.displayText || text, "", "", "", ""]));
    } else if (msg.role === "assistant") {
      const content = msg.content && typeof msg.content === "object" ? msg.content : {};
      lines.push(row([ts, "assistant", "", msg.model || "", msg.reasoning || "", msg.costUsd ?? "", content.text || "", "", "", "", ""]));
      for (const call of Array.isArray(content.toolCalls) ? content.toolCalls : []) {
        lines.push(row([ts, "toolCall", "", "", "", "", "", call?.name || "", call?.args != null ? JSON.stringify(call.args) : "", "", ""]));
      }
    } else if (msg.role === "toolResult") {
      const content = msg.content && typeof msg.content === "object" ? msg.content : {};
      lines.push(row([ts, "toolResult", "", "", "", "", "", content.toolName || "", "", content.resultText || "", content.isError ? "true" : ""]));
    }
    // compaction markers carry no user-facing content — skip.
  }
  return lines.join("\r\n");
}

// Model search for the LLM settings: fetches the provider's model list via
// the server-side proxy (the stored API key never reaches the browser — the
// "<unchanged>" sentinel is resolved server-side), filters client-side, and
// writes the chosen id back through onSelect. Provider/endpoint/key can't
// change while this modal is open, so the list can't go stale mid-search.
function ModelPickerDialog({ open, onOpenChange, provider, endpoint, apiKey, apiVersion, currentModelId, onSelect, images = false }) {
  const { t } = useContext(AppContext);
  const [models, setModels] = useState([]);
  const [source, setSource] = useState("live");
  const [warning, setWarning] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [fetchNonce, setFetchNonce] = useState(0);
  const noCacheRef = useRef(false);
  const rowRefs = useRef([]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setExpandedId(null);
    setActiveIndex(-1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setModels([]);
    setWarning(null);
    const noCache = noCacheRef.current;
    noCacheRef.current = false;
    api("/admin/llm-models", {
      method: "POST",
      body: JSON.stringify({
        provider,
        endpoint: (endpoint || "").trim() || undefined,
        apiKey: apiKey || undefined,
        ...(apiVersion && apiVersion.trim() ? { apiVersion: apiVersion.trim() } : {}),
        ...(images ? { images: true } : {}),
        ...(noCache ? { noCache: true } : {}),
      }),
    })
      .then((r) => {
        if (cancelled) return;
        setModels(Array.isArray(r?.models) ? r.models : []);
        setSource(r?.source || "live");
        setWarning(r?.warning || null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError({ message: e?.message || String(e), code: e?.code });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, fetchNonce]);

  const filtered = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return models;
    return models.filter((m) => {
      const hay = `${m.id} ${m.name} ${m.description || ""}`.toLowerCase();
      return tokens.every((tk) => hay.includes(tk));
    });
  }, [models, query]);
  const visible = filtered.slice(0, 100);

  useEffect(() => {
    if (activeIndex >= 0) rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const warningText = warning?.code === "CATALOG_ONLY" ? t("settings.modelPicker.catalogNote")
    : warning?.code === "KEY_MISSING" ? t("settings.modelPicker.catalogNoKey")
    : warning ? t("settings.modelPicker.catalogUpstreamFailed")
    : null;
  const errorText = error?.code === "ENDPOINT_REQUIRED" ? t("settings.modelPicker.endpointRequired")
    : error?.code === "UPSTREAM_AUTH" ? t("settings.modelPicker.authFailed")
    : error?.code === "UPSTREAM_UNREACHABLE" || error?.code === "UPSTREAM_ERROR" ? t("settings.modelPicker.unreachable")
    : error?.message;

  const onSearchKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIndex >= 0 && visible[activeIndex]) {
      e.preventDefault();
      onSelect(visible[activeIndex].id);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content model-picker-content">
          <Dialog.Title className="modal-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Search size={18} className="title-icon" />
            {t("settings.modelPicker.title")}
            <button
              className="mcp-server-icon-btn"
              style={{ marginLeft: "auto" }}
              title={t("settings.modelPicker.refresh")}
              disabled={loading}
              onClick={() => { noCacheRef.current = true; setFetchNonce((n) => n + 1); }}
            >
              <RefreshCw size={14} />
            </button>
          </Dialog.Title>
          <div style={{ position: "relative" }}>
            <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
            <input
              type="text"
              className="modal-input"
              style={{ paddingLeft: 32, width: "100%", boxSizing: "border-box" }}
              autoFocus
              value={query}
              placeholder={t("settings.modelPicker.searchPlaceholder")}
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(-1); setExpandedId(null); }}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          {!loading && !error && source === "catalog" && warningText && (
            <div className="model-picker-warning">
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              {warningText}
            </div>
          )}
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", padding: "12px 0" }}>
              <Loader size={14} className="spin" /> {t("settings.modelPicker.loading")}
            </div>
          ) : error ? (
            <div style={{ padding: "12px 0" }}>
              <div style={{ fontSize: 12, color: "var(--error)", marginBottom: 8 }}>{errorText}</div>
              <button className="btn-secondary" onClick={() => setFetchNonce((n) => n + 1)}>
                {t("settings.modelPicker.retry")}
              </button>
            </div>
          ) : (
            <>
              <div className="model-picker-list">
                {visible.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", padding: "8px 0" }}>
                    {t("settings.modelPicker.empty")}
                  </div>
                )}
                {visible.map((m, i) => {
                  const expanded = expandedId === m.id;
                  const ctx = formatTokenCount(m.contextWindow);
                  const maxOut = formatTokenCount(m.maxTokens);
                  return (
                    <div
                      key={m.id}
                      ref={(el) => { rowRefs.current[i] = el; }}
                      className={`model-card${i === activeIndex ? " active" : ""}`}
                      onClick={() => { setExpandedId(expanded ? null : m.id); setActiveIndex(i); }}
                    >
                      <div className="model-card-header">
                        {expanded ? <ChevronDown size={14} style={{ color: "var(--text-muted)" }} /> : <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />}
                        <div style={{ minWidth: 0 }}>
                          <div className="model-card-name">
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                            {m.id === currentModelId && (
                              <span className="mcp-server-badge"><Check size={10} /> {t("settings.modelPicker.current")}</span>
                            )}
                          </div>
                          <div className="model-card-id">{m.id}</div>
                          <div className="model-card-badges">
                            {ctx && <span className="mcp-server-badge mcp-server-badge-muted">{ctx} {t("settings.modelPicker.context")}</span>}
                            {m.pricing && (
                              <span className="mcp-server-badge mcp-server-badge-muted">
                                {t("settings.modelPicker.pricing", { input: formatModelPrice(m.pricing.input), output: formatModelPrice(m.pricing.output) })}
                              </span>
                            )}
                            {m.reasoning && <span className="mcp-server-badge">{t("settings.modelPicker.reasoning")}</span>}
                            {m.inputModalities?.includes("image") && <span className="mcp-server-badge">{t("settings.modelPicker.vision")}</span>}
                          </div>
                        </div>
                        <button
                          className="btn-primary"
                          style={{ padding: "4px 10px", fontSize: 12, alignSelf: "start" }}
                          onClick={(e) => { e.stopPropagation(); onSelect(m.id); }}
                        >
                          {t("settings.modelPicker.select")}
                        </button>
                      </div>
                      {expanded && (m.description || maxOut) && (
                        <div className="model-card-desc">
                          {m.description}
                          {maxOut && (
                            <div style={{ marginTop: m.description ? 4 : 0 }}>
                              {t("settings.modelPicker.maxOutput", { count: maxOut })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {filtered.length > visible.length && (
                <div className="model-picker-footer-note">
                  {t("settings.modelPicker.moreResults", { count: filtered.length - visible.length })}
                </div>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Provider subscription sign-in card (Settings → AI Model Config) ─────
// Shared OAuth sign-in UI for the subscription/OAuth LLM providers. Shown in
// place of the API-key field for ChatGPT/Codex and Kimi Code, and as an
// alternative credential source (in addition to the API-key field) for
// OpenRouter. Drives the server-side OAuth flow via /api/admin/<slug>-auth*:
// the server runs the PKCE browser flow (codex: localhost:1455 callback +
// paste-the-redirect fallback; openrouter: ephemeral loopback) or the
// device-code flow (codex, kimi), and stores tokens encrypted. The browser
// only ever sees URLs, device codes and status flags.
//
//   apiBase          "/admin/codex-auth" | "/admin/kimi-auth" | "/admin/openrouter-auth"
//   keyPrefix        i18n key prefix, e.g. "settings.codex"
//   methods          supported login methods; the first is primary
//                    (["browser","device_code"] | ["device_code"] | ["browser"])
//   allowManualPaste show the paste-the-redirect-URL box (codex only)
//   note             render a keyPrefix.note line (OpenRouter's desktop-only caveat)
//   onStatusChange   optional; called with { signedIn, healthy, pending } on every
//                    status refresh so a parent (the setup wizard) can gate its
//                    own Continue button on the sign-in outcome
function ProviderSignInCard({ t, active, reloadServerConfig, apiBase, keyPrefix, methods, allowManualPaste = false, note = false, onStatusChange }) {
  const tk = (suffix, params) => t(`${keyPrefix}.${suffix}`, params);
  const primaryMethod = methods[0];
  const secondaryMethods = methods.slice(1);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [copied, setCopied] = useState(false);

  // verify=true actively probes the credential server-side (refreshes an
  // expired access token, flags a dead refresh token as healthy:false). Used
  // when the card opens and after a completed sign-in; the 2 s pending poll
  // stays on the cheap path.
  const refresh = useCallback(async (verify = false) => {
    try {
      const s = await api(`${apiBase}${verify ? "?verify=1" : ""}`);
      setStatus(s);
      return s;
    } catch (err) {
      setError(err?.message || String(err));
      return null;
    }
  }, [apiBase]);

  useEffect(() => {
    if (active) { setError(""); setManualCode(""); refresh(true); }
  }, [active, refresh]);

  const login = status?.login;
  const pending = login?.status === "pending";

  // Report the sign-in outcome upward. Held in a ref so an unstable parent
  // callback can't invalidate `refresh`'s deps and restart the poll below.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    if (!status) return;
    onStatusChangeRef.current?.({
      signedIn: status.signedIn === true,
      healthy: status.healthy !== false,
      pending: status.login?.status === "pending",
    });
  }, [status]);

  // Poll while a sign-in runs server-side; the flow completes out-of-band
  // (browser callback, pasted code, or device-code approval).
  useEffect(() => {
    if (!active || !pending) return undefined;
    const id = setInterval(async () => {
      const s = await refresh();
      if (s?.login?.status === "success") {
        setManualCode("");
        reloadServerConfig?.();
        // Freshly signed in — re-probe so a stale healthy:false clears.
        refresh(true);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [active, pending, refresh, reloadServerConfig]);

  const start = async (method) => {
    setBusy(true);
    setError("");
    try {
      const state = await api(`${apiBase}/login`, { method: "POST", body: JSON.stringify({ method }) });
      // Web deployments open the auth page from this user gesture; the
      // packaged desktop server already opened the system browser
      // (browserOpened) — don't spawn a second window there.
      if (state?.status === "pending" && state.authUrl && !state.browserOpened) {
        try { window.open(state.authUrl, "_blank", "noopener"); } catch { /* popup blocked — the link below still works */ }
      }
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    const code = manualCode.trim();
    if (!code) return;
    setBusy(true);
    setError("");
    try {
      await api(`${apiBase}/login/code`, { method: "POST", body: JSON.stringify({ code }) });
      setManualCode("");
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await api(`${apiBase}/login/cancel`, { method: "POST", body: JSON.stringify({}) });
      setManualCode("");
      await refresh();
    } catch { /* state poll will catch up */ } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`${apiBase}/logout`, { method: "POST", body: JSON.stringify({}) });
      await refresh();
      reloadServerConfig?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(login?.authUrl || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const mutedStyle = { color: "var(--text-muted)", fontSize: 13 };
  const rowStyle = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
  const signedInDetail = status?.signedIn
    ? [status.email || status.accountId, status.planType].filter(Boolean).join(" — ")
    : "";

  return (
    <div className="modal-label" style={{ gap: 8 }}>
      {tk("title")}
      {note && <span style={mutedStyle}>{tk("note")}</span>}
      {!status && !error && <span style={mutedStyle}>…</span>}

      {status?.signedIn && !pending && (
        <>
          {status.healthy === false ? (
            // Stored credential exists but its refresh failed (revoked or
            // expired refresh token) — the only fix is signing in again.
            <div className="skill-editor-error" role="alert">
              <AlertTriangle size={14} />
              <span>
                {tk("signInExpired")}
                {status.authError ? ` (${status.authError})` : ""}
              </span>
            </div>
          ) : (
            <div style={rowStyle}>
              <CircleCheck size={14} style={{ color: "var(--success, #22a06b)" }} />
              <span style={{ fontSize: 13 }}>
                {signedInDetail
                  ? tk("signedIn", { detail: signedInDetail })
                  : tk("signedInNoDetail")}
              </span>
            </div>
          )}
          <div style={rowStyle}>
            {status.healthy === false && (
              <button className="btn-primary" onClick={() => start(primaryMethod)} disabled={busy}>
                <Key size={14} /> {tk("signIn")}
              </button>
            )}
            <button className="btn-secondary" onClick={signOut} disabled={busy}>
              <LogOut size={14} /> {tk("signOut")}
            </button>
          </div>
        </>
      )}

      {status && !status.signedIn && !pending && (
        <>
          <span style={mutedStyle}>{tk("notSignedIn")}</span>
          <div style={rowStyle}>
            <button className="btn-primary" onClick={() => start(primaryMethod)} disabled={busy}>
              <Key size={14} /> {tk("signIn")}
            </button>
            {secondaryMethods.includes("device_code") && (
              <button className="btn-secondary" onClick={() => start("device_code")} disabled={busy}>
                {tk("signInDevice")}
              </button>
            )}
          </div>
          {login?.status === "error" && (
            <div className="skill-editor-error" role="alert">
              <AlertTriangle size={14} />
              <span>{tk("loginFailed", { message: login.message || "" })}</span>
            </div>
          )}
        </>
      )}

      {pending && (
        <>
          <div style={rowStyle}>
            <Loader size={14} className="spin" />
            <span style={mutedStyle}>{tk("pending")}</span>
            <button className="btn-secondary" onClick={cancel} disabled={busy}>
              {t("common.cancel")}
            </button>
          </div>
          {login.method === "device_code" && login.userCode && (
            <div style={{ ...rowStyle, fontSize: 13 }}>
              <span>
                {tk("deviceCodeHint")}{" "}
                <a href={login.verificationUri} target="_blank" rel="noopener noreferrer">
                  {login.verificationUri} <ExternalLink size={12} style={{ verticalAlign: "-2px" }} />
                </a>
              </span>
              <code style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 15, letterSpacing: 1, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 4 }}>
                {login.userCode}
              </code>
            </div>
          )}
          {login.method === "browser" && (
            <>
              {login.authUrl && (
                <div style={{ ...rowStyle, fontSize: 13 }}>
                  <span style={mutedStyle}>{tk("openUrl")}</span>
                  <a href={login.authUrl} target="_blank" rel="noopener noreferrer" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {login.authUrl}
                  </a>
                  <button className="btn-secondary" onClick={copyUrl} style={{ whiteSpace: "nowrap" }}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {tk("copyUrl")}
                  </button>
                </div>
              )}
              {/* Codex only: covers remote servers, Docker, and port-1455
                  conflicts where the localhost callback can't reach us. The
                  OpenRouter loopback flow has no manual-paste path. */}
              {allowManualPaste && (
                <div style={rowStyle}>
                  <input
                    type="text"
                    className="modal-input"
                    style={{ flex: 1, minWidth: 220 }}
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitCode(); } }}
                    placeholder={tk("pasteCode")}
                    disabled={busy}
                  />
                  <button className="btn-secondary" onClick={submitCode} disabled={busy || !manualCode.trim()}>
                    {tk("submitCode")}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {error && (
        <div className="skill-editor-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// ─── Encrypted config export/import (Settings > AI Model Config) ─────
// The browser never sees the real secrets: the server assembles the chosen
// categories and encrypts them with a password-derived key (scrypt +
// AES-256-GCM); the client only turns the returned JSON envelope into a
// downloaded file, and sends it back (plus password) on import.

// Category checkboxes, grouped for the export dialog. The flat order also
// drives the import preview. Keys must match src/config-transfer.ts.
const CONFIG_TRANSFER_GROUPS = [
  { key: "modelTools", cats: ["aiModelConfig", "profiles", "vcsProfiles", "network"] },
  { key: "platform", cats: ["authentication", "mcpServers", "environment"] },
  { key: "content", cats: ["systemPrompt", "appTemplates", "skills"] },
  { key: "people", cats: ["usersGroups"] },
];
const CONFIG_TRANSFER_CATEGORIES = CONFIG_TRANSFER_GROUPS.flatMap((g) => g.cats);
// Categories whose import replaces (not merges) the whole store — surfaced in
// the export dialog so the admin knows before building the file.
const CONFIG_TRANSFER_LIST_SUMMARY = new Set(["profiles", "vcsProfiles", "mcpServers", "appTemplates", "skills", "environment"]);

function configProviderLabel(t, provider, image = false) {
  const key = image
    ? {
        "google": "settings.image.google",
        "openai": "settings.image.openai",
        "openrouter": "settings.image.openrouter",
      }[provider]
    : {
        "anthropic": "settings.anthropic",
        "azure-ai-foundry": "settings.azureFoundry",
        "azure-openai": "settings.azureOpenai",
        "openai": "settings.openai",
        "google": "settings.google",
        "openai-codex": "settings.openaiCodex",
        "kimi-coding": "settings.kimiCoding",
        "openrouter": "settings.openrouter",
        "openai-compatible": "settings.openaiCompatible",
      }[provider];
  return key ? t(key) : (provider || "—");
}

// One-line, non-secret summary of a category in the import preview, built from
// the structured facts the server returns (values are language-neutral tokens).
function configSummaryLine(t, entry) {
  const p = entry.params || {};
  const names = (entry.names || []).join(", ");
  switch (entry.key) {
    case "aiModelConfig":
      return t("settings.transfer.sum.aiModelConfig", { provider: configProviderLabel(t, p.provider), model: p.model || "—" });
    case "authentication":
      return t("settings.transfer.sum.authentication", { tenant: p.tenant || "—", client: p.client || "—" });
    case "systemPrompt":
      return t("settings.transfer.sum.systemPrompt", { chars: p.chars || "0" });
    case "usersGroups":
      return t("settings.transfer.sum.usersGroups", { users: p.users || "0", groups: p.groups || "0", names: names || "—" });
    case "network":
      return "";
    default:
      return t("settings.transfer.sum.list", { count: entry.count ?? 0, names: names || "—" });
  }
}

function ConfigExportDialog({ open, onOpenChange, t }) {
  const [cats, setCats] = useState({});
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setCats({});
      setPw("");
      setPw2("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const selected = CONFIG_TRANSFER_CATEGORIES.filter((c) => cats[c]);
  const allSelected = selected.length === CONFIG_TRANSFER_CATEGORIES.length;
  const canExport = !busy && selected.length > 0 && pw.length >= 8 && pw === pw2;

  const toggleAll = () => {
    if (allSelected) setCats({});
    else setCats(Object.fromEntries(CONFIG_TRANSFER_CATEGORIES.map((c) => [c, true])));
  };

  const doExport = async () => {
    if (selected.length === 0) { setError(t("settings.transfer.noCategories")); return; }
    if (pw.length < 8) { setError(t("settings.transfer.passwordTooShort")); return; }
    if (pw !== pw2) { setError(t("settings.transfer.passwordMismatch")); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api("/admin/vca-settings/export", {
        method: "POST",
        body: JSON.stringify({ password: pw, categories: selected }),
      });
      downloadJsonFile(r?.filename || "vca-config.json", r?.envelope);
      onOpenChange(false);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <Download size={18} className="title-icon" /> {t("settings.transfer.exportTitle")}
          </Dialog.Title>
          <Dialog.Description className="alert-description">
            {t("settings.transfer.exportIntro")}
          </Dialog.Description>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <div className="modal-label" style={{ margin: 0 }}>{t("settings.transfer.categories")}</div>
            <button
              type="button"
              onClick={toggleAll}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent-hover, var(--accent))", fontSize: 12 }}
            >
              {allSelected ? t("settings.transfer.selectNone") : t("settings.transfer.selectAll")}
            </button>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto", paddingRight: 4, marginBottom: 4 }}>
            {CONFIG_TRANSFER_GROUPS.map((g) => (
              <div key={g.key} style={{ marginBottom: 6 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", margin: "4px 0" }}>
                  {t(`settings.transfer.group.${g.key}`)}
                </div>
                {g.cats.map((c) => (
                  <label key={c} className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 8, margin: "2px 0" }}>
                    <input
                      type="checkbox"
                      checked={!!cats[c]}
                      onChange={(e) => setCats((prev) => ({ ...prev, [c]: e.target.checked }))}
                    />
                    <span>{t(`settings.transfer.category.${c}`)}</span>
                    {CONFIG_TRANSFER_LIST_SUMMARY.has(c) && (
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>· {t("settings.transfer.replacesTag")}</span>
                    )}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <label className="modal-label" style={{ marginTop: 8 }}>
            {t("settings.transfer.password")}
            <input
              type="password"
              className="modal-input"
              value={pw}
              autoComplete="new-password"
              onChange={(e) => setPw(e.target.value)}
            />
          </label>
          <label className="modal-label">
            {t("settings.transfer.passwordConfirm")}
            <input
              type="password"
              className="modal-input"
              value={pw2}
              autoComplete="new-password"
              onChange={(e) => setPw2(e.target.value)}
            />
          </label>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>
            {t("settings.transfer.passwordHint")}
          </div>
          {error && (
            <div className="skill-editor-error" role="alert">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
          <div className="modal-actions">
            <button className="btn-primary" disabled={!canExport} onClick={doExport}>
              <Download size={14} /> {busy ? t("settings.transfer.exporting") : t("settings.transfer.export")}
            </button>
            <Dialog.Close asChild>
              <button className="btn-secondary" disabled={busy}>
                <X size={14} /> {t("common.cancel")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Opens when `envelope` is non-null (a parsed, still-encrypted config file).
// Steps: password (dry-run decrypt) → preview (what the file contains, what
// gets overwritten). A successful apply closes the dialog — the result
// feedback lives in the settings transfer tab behind it (`onApplied` runs
// first and records it); a failed apply shows the error here and mirrors it
// to the tab via `onFailed` so it survives cancelling the dialog.
function ConfigImportDialog({ envelope, onClose, t, onApplied, onFailed }) {
  const [step, setStep] = useState("password");
  const [pw, setPw] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = envelope != null;

  useEffect(() => {
    if (envelope != null) {
      setStep("password");
      setPw("");
      setPreview(null);
      setBusy(false);
      setError(null);
    }
  }, [envelope]);

  const mapError = (err) =>
    err?.code === "CONFIG_FILE_WRONG_PASSWORD" ? t("settings.transfer.wrongPassword")
    : err?.code === "CONFIG_FILE_VERSION_UNSUPPORTED" ? t("settings.transfer.versionUnsupported")
    : err?.code === "CONFIG_FILE_INVALID" ? t("settings.transfer.fileInvalid")
    : (err?.message || String(err));

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api("/admin/vca-settings/import", {
        method: "POST",
        body: JSON.stringify({ password: pw, envelope, dryRun: true }),
      });
      setPreview(r?.preview || null);
      setStep("preview");
    } catch (err) {
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api("/admin/vca-settings/import", {
        method: "POST",
        body: JSON.stringify({ password: pw, envelope }),
      });
      await onApplied(r);
      onClose();
    } catch (err) {
      const msg = mapError(err);
      setError(msg);
      if (onFailed) onFailed(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <Upload size={18} className="title-icon" /> {t("settings.transfer.importTitle")}
          </Dialog.Title>
          {step === "password" && (
            <>
              <Dialog.Description className="alert-description">
                {t("settings.transfer.importIntro")}
              </Dialog.Description>
              <label className="modal-label">
                {t("settings.transfer.password")}
                <input
                  type="password"
                  className="modal-input"
                  value={pw}
                  autoComplete="current-password"
                  autoFocus
                  onChange={(e) => setPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && pw && !busy) check(); }}
                />
              </label>
            </>
          )}
          {step === "preview" && preview && (
            <>
              <div className="modal-label" style={{ marginBottom: 2 }}>{t("settings.transfer.previewTitle")}</div>
              <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6 }}>
                {t("settings.transfer.previewExportedAt", {
                  date: preview.exportedAt ? preview.exportedAt.slice(0, 10) : "?",
                  version: preview.appVersion || "?",
                })}
              </div>
              <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 4 }}>
                {(preview.entries || []).map((entry) => {
                  const line = configSummaryLine(t, entry);
                  return (
                    <div key={entry.key} style={{ borderLeft: "2px solid var(--border, #444)", paddingLeft: 8 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{t(`settings.transfer.category.${entry.key}`)}</div>
                      {line && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{line}</div>}
                      {entry.secretCount > 0 && (
                        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                          {t("settings.transfer.secretsIncluded", { n: entry.secretCount })}
                        </div>
                      )}
                      {(entry.warn || []).map((w) => (
                        <div key={w} style={{ display: "flex", gap: 6, alignItems: "flex-start", color: "var(--error)", fontSize: 12, marginTop: 2 }}>
                          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>{t(`settings.transfer.warn.${w}`)}</span>
                        </div>
                      ))}
                      {(entry.note || []).map((n) => (
                        <div key={n} style={{ display: "flex", gap: 6, alignItems: "flex-start", color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>
                          <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>{t(`settings.transfer.note.${n}`)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
              {Array.isArray(preview.unknownCategories) && preview.unknownCategories.length > 0 && (
                <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
                  {t("settings.transfer.previewUnknown", { names: preview.unknownCategories.join(", ") })}
                </div>
              )}
              <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
                {t("settings.transfer.previewOverwrite")}
              </div>
            </>
          )}
          {error && (
            <div className="skill-editor-error" role="alert">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
          <div className="modal-actions">
            {step === "password" && (
              <>
                <button className="btn-primary" disabled={!pw || busy} onClick={check}>
                  <ChevronRight size={14} /> {busy ? t("settings.transfer.checking") : t("settings.transfer.check")}
                </button>
                <Dialog.Close asChild>
                  <button className="btn-secondary" disabled={busy}>
                    <X size={14} /> {t("common.cancel")}
                  </button>
                </Dialog.Close>
              </>
            )}
            {step === "preview" && (
              <>
                <button className="btn-primary" disabled={busy} onClick={doImport}>
                  <Upload size={14} /> {busy ? t("settings.transfer.applying") : t("settings.transfer.apply")}
                </button>
                <button className="btn-secondary" disabled={busy} onClick={() => { setError(null); setStep("password"); }}>
                  <ChevronLeft size={14} /> {t("settings.transfer.back")}
                </button>
                <Dialog.Close asChild>
                  <button className="btn-secondary" disabled={busy}>
                    <X size={14} /> {t("common.cancel")}
                  </button>
                </Dialog.Close>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── First-run setup wizard ──────────────────────────────────
// Shown instead of the Settings dialog when no LLM is configured yet. The
// AI Model Config tab is an admin tool — nine providers in a bare <select>,
// free-text endpoint/api-version/model fields, a profile dropdown that hides
// its own name field until you pick "+ New profile…", and no validation at
// all. This walks a first-time user through the same four decisions in plain
// language, verifies the result with a real request, and creates the first
// profile silently.
//
// It writes through exactly the same endpoints as SettingsDialog.save(), so
// there is one persistence path, not two.

// Provider catalogue. `id` must match the <option value> list in the AI Model
// Config tab and UserLLMConfig["provider"] on the server.
//   group          "signin" | "key" | "advanced" — grouping and order on step 1
//   label          i18n key for the tile heading (reuses the Settings strings,
//                  already translated in all five locales)
//   shortLabel     brand name used to build the generated profile name; not
//                  translated, because these are product names
//   auth           "oauth" | "key" | "key-optional"
//   oauth          the props ProviderSignInCard takes, verbatim
//   defaultModel   preselected, and the re-baseline when the provider changes
//   needsEndpoint  "required" | "optional" | undefined
//   endpointKind   which plain-language endpoint copy to use
const WIZARD_PROVIDERS = [
  {
    id: "openai-codex", group: "signin", auth: "oauth", label: "settings.openaiCodex", shortLabel: "ChatGPT",
    oauth: { apiBase: "/admin/codex-auth", keyPrefix: "settings.codex", methods: ["browser", "device_code"], allowManualPaste: true },
    defaultModel: "gpt-5.5", canListModels: true,
  },
  {
    id: "kimi-coding", group: "signin", auth: "oauth", label: "settings.kimiCoding", shortLabel: "Kimi Code",
    oauth: { apiBase: "/admin/kimi-auth", keyPrefix: "settings.kimi", methods: ["device_code"] },
    defaultModel: "k3", canListModels: true,
  },
  {
    id: "openrouter", group: "signin", auth: "key-optional", label: "settings.openrouter", shortLabel: "OpenRouter",
    oauth: { apiBase: "/admin/openrouter-auth", keyPrefix: "settings.openrouter.oauth", methods: ["browser"], note: true },
    oauthDesktopOnly: true,
    keyPlaceholder: "sk-or-...", keyPrefixHint: "sk-or-", getKeyUrl: "https://openrouter.ai/keys",
    needsEndpoint: "optional", endpointKind: "optional", endpointPlaceholder: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-5", canListModels: true,
  },
  {
    id: "anthropic", group: "key", auth: "key", label: "settings.anthropic", shortLabel: "Claude",
    keyPlaceholder: "sk-ant-...", keyPrefixHint: "sk-ant-", getKeyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-5", canListModels: true,
  },
  {
    id: "openai", group: "key", auth: "key", label: "settings.openai", shortLabel: "OpenAI",
    keyPlaceholder: "sk-...", keyPrefixHint: "sk-", getKeyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.5", canListModels: true,
  },
  {
    id: "google", group: "key", auth: "key", label: "settings.google", shortLabel: "Gemini",
    keyPlaceholder: "AIza...", keyPrefixHint: "AIza", getKeyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-2.5-pro", canListModels: true,
  },
  {
    id: "azure-ai-foundry", group: "advanced", auth: "key", label: "settings.azureFoundry", shortLabel: "Azure AI Foundry",
    keyPlaceholder: "Azure API Key",
    needsEndpoint: "required", endpointKind: "azure", endpointPlaceholder: "https://...services.ai.azure.com/anthropic",
    defaultModel: "claude-sonnet-5", canListModels: true, freeTextModel: "azure",
  },
  {
    id: "azure-openai", group: "advanced", auth: "key", label: "settings.azureOpenai", shortLabel: "Azure OpenAI",
    keyPlaceholder: "Azure API Key",
    needsEndpoint: "required", endpointKind: "azure", endpointPlaceholder: "https://...azure-api.net/apim-openai/openai/",
    needsApiVersion: true, defaultApiVersion: "2025-04-01-preview",
    defaultModel: "gpt-5.5", canListModels: true, freeTextModel: "azure",
  },
  {
    id: "openai-compatible", group: "advanced", auth: "key-optional", label: "settings.openaiCompatible", shortLabel: "Local",
    keyPlaceholder: "settings.apiKeyOptional",
    needsEndpoint: "required", endpointKind: "local", endpointPlaceholder: "http://localhost:1234/v1",
    defaultModel: "", canListModels: true, freeTextModel: "local",
  },
];

const SETUP_STEPS = ["provider", "credential", "model", "verify"];

// Which of the three verify rows a failure code belongs to. Rows before it
// render as passed, rows after stay pending.
const SETUP_ERROR_ROW = {
  NETWORK_UNREACHABLE: 0, TLS_ERROR: 0, TIMEOUT: 0, ENDPOINT_REQUIRED: 0, ENDPOINT_INVALID: 0,
  AUTH_INVALID: 1, AUTH_FORBIDDEN: 1, OAUTH_NOT_SIGNED_IN: 1,
  MODEL_NOT_FOUND: 2, NO_CREDIT: 2, RATE_LIMITED: 2, BUSY: 2, UNKNOWN: 2,
};
// Which step can fix each failure, for the "Back" button on the verify screen.
const SETUP_ERROR_STEP = {
  ENDPOINT_REQUIRED: "credential", ENDPOINT_INVALID: "credential",
  AUTH_INVALID: "credential", AUTH_FORBIDDEN: "credential", OAUTH_NOT_SIGNED_IN: "credential",
  MODEL_NOT_FOUND: "model",
};

function isHttpUrl(value) {
  const v = (value || "").trim();
  return /^https?:\/\/.+/i.test(v);
}

function SetupWizard({ onDone, onSkip, onOpenSettings }) {
  const {
    t, userId, reloadServerConfig,
    setApiKey, setLlmProvider, setLlmModelId, setLlmEndpoint, setLlmApiVersion,
    setImageProvider, setImageModelId, setImageApiKey,
  } = useContext(AppContext);
  const isDesktop = typeof window !== "undefined" && !!window.vcaDesktop;

  const [step, setStep] = useState("provider");
  const [draft, setDraft] = useState({ providerId: "", apiKey: "", endpoint: "", apiVersion: "", modelId: "", modelName: "" });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [oauthState, setOauthState] = useState({ signedIn: false, healthy: true, pending: false });
  // A key is already stored for this provider (re-run from Settings). Until the
  // user chooses to replace it, draft.apiKey carries the UNCHANGED sentinel.
  const [storedKeyProvider, setStoredKeyProvider] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [existingNames, setExistingNames] = useState([]);
  const [test, setTest] = useState(null);   // null | { running: true } | result
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [profileWarning, setProfileWarning] = useState(null);
  const [leaveOpen, setLeaveOpen] = useState(false);

  const provider = WIZARD_PROVIDERS.find((p) => p.id === draft.providerId) || null;
  const patch = (fields) => setDraft((d) => ({ ...d, ...fields }));

  // Re-run from Settings: seed the form from the live configuration so the
  // user isn't retyping what's already there. Secrets arrive redacted as the
  // UNCHANGED sentinel, which the server resolves back on save.
  useEffect(() => {
    let cancelled = false;
    api("/admin/vca-settings")
      .then((r) => {
        const s = r?.settings;
        if (cancelled || !s || !s.llmProvider) return;
        if (!WIZARD_PROVIDERS.some((p) => p.id === s.llmProvider)) return;
        setDraft({
          providerId: s.llmProvider,
          apiKey: s.apiKey || "",
          endpoint: s.llmEndpoint || "",
          apiVersion: s.llmApiVersion || "",
          modelId: s.llmModelId || "",
          modelName: "",
        });
        if (s.apiKey === AUTH_SECRET_SENTINEL) setStoredKeyProvider(s.llmProvider);
      })
      .catch(() => { /* first run — nothing stored yet, keep the blank draft */ });
    api("/admin/llm-profiles")
      .then((r) => { if (!cancelled) setExistingNames((Array.isArray(r?.profiles) ? r.profiles : []).map((p) => p.name)); })
      .catch(() => { /* name dedupe is cosmetic */ });
    return () => { cancelled = true; };
  }, []);

  const pickProvider = (p) => {
    // Re-baseline the model id: an id carried over from another provider (an
    // Azure deployment name reaching the Codex backend, say) fails upstream.
    // Same guard the provider <select> in Settings applies.
    const keepStoredKey = storedKeyProvider === p.id && !replacingKey;
    setDraft({
      providerId: p.id,
      apiKey: keepStoredKey ? AUTH_SECRET_SENTINEL : "",
      endpoint: p.id === draft.providerId ? draft.endpoint : "",
      apiVersion: p.needsApiVersion ? (p.id === draft.providerId && draft.apiVersion ? draft.apiVersion : p.defaultApiVersion || "") : "",
      modelId: p.defaultModel,
      modelName: "",
    });
    setOauthState({ signedIn: false, healthy: true, pending: false });
    setTest(null);
    setStep("credential");
  };

  const usingStoredKey = storedKeyProvider === draft.providerId && !replacingKey;
  const keyOk = !provider || provider.auth !== "key" || usingStoredKey || draft.apiKey.trim().length > 0;
  const oauthOk = !provider || provider.auth !== "oauth" || (oauthState.signedIn && oauthState.healthy);
  const endpointOk = !provider || provider.needsEndpoint !== "required" || isHttpUrl(draft.endpoint);
  const canLeaveCredential = keyOk && oauthOk && endpointOk && !oauthState.pending;

  const runTest = useCallback(async () => {
    setTest({ running: true });
    try {
      const r = await api("/admin/llm-test-connection", {
        method: "POST",
        body: JSON.stringify({
          provider: draft.providerId,
          modelId: draft.modelId,
          apiKey: draft.apiKey,
          endpoint: draft.endpoint,
          apiVersion: draft.apiVersion,
        }),
      });
      setTest(r);
    } catch (err) {
      // Non-2xx only happens when the test couldn't be run at all.
      setTest({ ok: false, code: "UNKNOWN", detail: err?.message || String(err), latencyMs: 0 });
    }
  }, [draft]);

  useEffect(() => { if (step === "verify" && test === null) runTest(); }, [step, test, runTest]);

  // Named after the model where the list gave us a display name ("Claude
  // Sonnet 5"), otherwise brand + id ("Local · llama-3.3-70b"). Never the full
  // provider label — "OpenAI-compatible (LM Studio, vLLM, Ollama…)" makes a
  // terrible profile name.
  const generateProfileName = () => {
    const base = (draft.modelName || `${provider.shortLabel} · ${draft.modelId}`).slice(0, 64);
    if (!existingNames.includes(base)) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base.slice(0, 58)} (${n})`;
      if (!existingNames.includes(candidate)) return candidate;
    }
    return base;
  };

  const finishSetup = async () => {
    setSaving(true);
    setSaveError(null);
    setProfileWarning(null);
    // An empty llmProvider makes the backend fall through to env-var defaults,
    // so `configured` would stay false and the wizard would reopen forever.
    if (!provider) { setSaveError(t("setup.error.noProvider")); setSaving(false); return; }

    // Image generation piggybacks on the LLM key where the provider does both.
    // An OAuth token is not a reusable API key, so codex/kimi never qualify.
    const imageCapable = provider.id === "google" || provider.id === "openai" || provider.id === "openrouter";
    const imageModelId = imageCapable
      ? { google: "gemini-3.1-flash-image-preview", openai: "gpt-image-1", openrouter: "google/gemini-2.5-flash-image-preview" }[provider.id]
      : "gemini-3.1-flash-image-preview";
    const payload = {
      apiKey: draft.apiKey,
      llmProvider: provider.id,
      llmModelId: draft.modelId.trim(),
      llmEndpoint: draft.endpoint.trim(),
      llmApiVersion: draft.apiVersion.trim(),
      // The wizard never sets token overrides — auto-detect from the catalog.
      llmContextWindow: 0,
      llmMaxTokens: 0,
      // Web tools follow the provider automatically; write the same defaults
      // SettingsDialog.save() writes.
      webSearchEnabled: true,
      webFetchEnabled: true,
      webSearchModelId: "",
      webSearchContextSize: "",
      webSearchEngine: "",
      webSearchMaxResults: 0,
      webFetchEngine: "",
      imageProvider: imageCapable ? provider.id : "google",
      imageModelId,
      imageApiKey: "",
      imageUseLlmKey: imageCapable,
    };
    try {
      await api("/admin/vca-settings", { method: "PUT", body: JSON.stringify(payload) });
    } catch (err) {
      // Nothing else has run yet — safe to stay put and retry.
      setSaveError(t("setup.saveFailed", { message: err?.message || String(err) }));
      setSaving(false);
      return;
    }

    // First profile, created silently. Send the sentinel rather than the real
    // key: the PUT above already persisted it and createLlmProfile resolves the
    // sentinel server-side, so the secret doesn't ride a second request.
    try {
      await api("/admin/llm-profiles", {
        method: "POST",
        body: JSON.stringify({ ...payload, name: generateProfileName(), apiKey: AUTH_SECRET_SENTINEL, imageApiKey: AUTH_SECRET_SENTINEL }),
      });
      notifyLlmProfilesChanged();
    } catch {
      // Profiles are bookkeeping — the deployment is already usable. Warn and
      // carry on rather than rolling back a working configuration.
      setProfileWarning(t("setup.profileWarning"));
    }

    // Mirror SettingsDialog.save()'s context updates. AppContext holds
    // non-secret display values only — never the real keys.
    setApiKey("");
    setLlmProvider(provider.id);
    setLlmModelId(payload.llmModelId);
    setLlmEndpoint(payload.llmEndpoint);
    setLlmApiVersion(payload.llmApiVersion);
    setImageProvider(payload.imageProvider);
    setImageModelId(payload.imageModelId);
    setImageApiKey("");

    if (userId) {
      try { await api(`/users/${userId}/reset-sessions`, { method: "POST", body: JSON.stringify({}) }); } catch { /* best effort */ }
    }
    // This is the call that flips llmConfigured and unmounts the wizard.
    try { await reloadServerConfig(); } catch { /* the next /config poll settles it */ }
    setSaving(false);
    onDone();
  };

  const requestLeave = () => {
    if (step === "provider") { onSkip(); return; }
    setLeaveOpen(true);
  };

  const stepIndex = SETUP_STEPS.indexOf(step);

  return (
    <div className="setup-overlay" role="dialog" aria-modal="true" aria-label={t("setup.title")}>
      <div className="setup-panel">
        <button className="settings-close-x" onClick={requestLeave} aria-label={t("common.close")}>
          <X size={16} />
        </button>
        <div className="setup-header">
          <div className="modal-title" style={{ margin: 0 }}>
            <Sparkles size={20} className="title-icon" />
            {t("setup.title")}
          </div>
          <div className="setup-subtitle">{t("setup.subtitle")}</div>
          <div className="setup-progress">
            {SETUP_STEPS.map((s, i) => (
              <div key={s} className={`setup-progress-step${i < stepIndex ? " done" : ""}${i === stepIndex ? " active" : ""}`}>
                <div className="setup-progress-bar" />
                <span>{t(`setup.step.${s}`)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="setup-body">
          {step === "provider" && (
            <SetupProviderStep t={t} isDesktop={isDesktop} selectedId={draft.providerId} onPick={pickProvider} advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen} />
          )}
          {step === "credential" && provider && (
            <SetupCredentialStep
              t={t} provider={provider} draft={draft} patch={patch} isDesktop={isDesktop}
              onOauthStatus={setOauthState}
              usingStoredKey={usingStoredKey}
              onReplaceKey={() => { setReplacingKey(true); patch({ apiKey: "" }); }}
            />
          )}
          {step === "model" && provider && (
            <SetupModelStep
              t={t} provider={provider} draft={draft}
              onSelect={(id, name) => patch({ modelId: id, modelName: name || "" })}
            />
          )}
          {step === "verify" && provider && (
            <SetupVerifyStep
              t={t} provider={provider} draft={draft} test={test}
              saveError={saveError} profileWarning={profileWarning}
            />
          )}
        </div>

        <div className="modal-actions">
          {step === "provider" ? (
            <div className="setup-footer-links">
              <button className="setup-link" onClick={onSkip}>{t("setup.action.later")}</button>
              <button className="setup-link" onClick={onOpenSettings}>{t("setup.action.haveConfig")}</button>
            </div>
          ) : (
            <button
              className="btn-secondary"
              disabled={saving}
              onClick={() => {
                // On the verify screen, go straight to the step that owns the
                // failure rather than one step back.
                const owner = step === "verify" && test && !test.running && !test.ok ? SETUP_ERROR_STEP[test.code] : null;
                setTest(null);
                setStep(owner || SETUP_STEPS[Math.max(0, stepIndex - 1)]);
              }}
            >
              <ChevronLeft size={14} /> {t("setup.action.back")}
            </button>
          )}
          {step === "credential" && (
            <button className="btn-primary" disabled={!canLeaveCredential} onClick={() => setStep("model")}>
              {oauthState.pending ? t("setup.action.waitingSignIn") : t("setup.action.continue")}
              {!oauthState.pending && <ChevronRight size={14} />}
            </button>
          )}
          {step === "model" && (
            <button className="btn-primary" disabled={!draft.modelId.trim()} onClick={() => { setTest(null); setStep("verify"); }}>
              {t("setup.action.continue")} <ChevronRight size={14} />
            </button>
          )}
          {step === "verify" && (
            <>
              {test && !test.running && !test.ok && (
                <>
                  <button className="btn-secondary" disabled={saving} onClick={runTest}>
                    <RefreshCw size={14} /> {t("setup.action.tryAgain")}
                  </button>
                  <button className="btn-faded" disabled={saving} onClick={finishSetup}>
                    {t("setup.action.saveAnyway")}
                  </button>
                </>
              )}
              <button className="btn-primary" disabled={saving || !test || test.running || !test.ok} onClick={finishSetup}>
                {saving ? <Loader size={14} className="spin" /> : <Check size={14} />}
                {saving ? t("setup.verify.saving") : t("setup.action.finish")}
              </button>
            </>
          )}
        </div>
      </div>

      <AlertDialog.Root open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="alert-overlay" />
          <AlertDialog.Content className="alert-content">
            <AlertDialog.Title className="alert-title">
              <AlertTriangle size={18} style={{ color: "var(--error)" }} />
              {t("setup.leave.title")}
            </AlertDialog.Title>
            <AlertDialog.Description className="alert-description">{t("setup.leave.body")}</AlertDialog.Description>
            <div className="modal-actions">
              <AlertDialog.Cancel asChild>
                <button className="btn-secondary">{t("common.cancel")}</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button className="btn-danger" onClick={onSkip}>{t("setup.leave.confirm")}</button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function SetupProviderStep({ t, isDesktop, selectedId, onPick, advancedOpen, setAdvancedOpen }) {
  const card = (p) => (
    <button
      key={p.id}
      className={`setup-provider-card${selectedId === p.id ? " selected" : ""}`}
      onClick={() => onPick(p)}
    >
      <span className="setup-provider-name">{t(p.label)}</span>
      <span className="setup-provider-blurb">{t(`setup.blurb.${p.id}`)}</span>
      {p.oauthDesktopOnly && !isDesktop && (
        <span className="setup-provider-blurb" style={{ fontStyle: "italic" }}>{t("setup.desktopOnlySignIn")}</span>
      )}
    </button>
  );
  const group = (name) => WIZARD_PROVIDERS.filter((p) => p.group === name);

  return (
    <>
      <div className="setup-group-title">{t("setup.group.signin")}</div>
      <div className="setup-group-hint">{t("setup.group.signinHint")}</div>
      <div className="setup-provider-grid">{group("signin").map(card)}</div>

      <div className="setup-group-title">{t("setup.group.key")}</div>
      <div className="setup-group-hint">{t("setup.group.keyHint")}</div>
      <div className="setup-provider-grid">{group("key").map(card)}</div>

      <Collapsible.Root open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <Collapsible.Trigger className="inline-collapse-trigger">
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t("setup.group.advanced")}
        </Collapsible.Trigger>
        <Collapsible.Content className="inline-collapse-content">
          <div className="setup-group-hint" style={{ marginTop: 8 }}>{t("setup.group.advancedHint")}</div>
          <div className="setup-provider-grid" style={{ marginTop: 8 }}>{group("advanced").map(card)}</div>
        </Collapsible.Content>
      </Collapsible.Root>
    </>
  );
}

function SetupCredentialStep({ t, provider, draft, patch, isDesktop, onOauthStatus, usingStoredKey, onReplaceKey }) {
  const { reloadServerConfig } = useContext(AppContext);
  const signInCard = provider.oauth ? (
    <ProviderSignInCard
      t={t} active reloadServerConfig={reloadServerConfig}
      {...provider.oauth}
      onStatusChange={onOauthStatus}
    />
  ) : null;

  const keyField = provider.auth === "oauth" ? null : (
    <label className="modal-label">
      {t("settings.apiKey")}
      {usingStoredKey ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("setup.credential.keyOnFile")}</span>
          <button className="btn-secondary btn-sm" onClick={onReplaceKey}>{t("setup.credential.replaceKey")}</button>
        </div>
      ) : (
        <>
          <input
            type="password"
            className="modal-input"
            autoFocus
            value={draft.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value })}
            placeholder={provider.keyPlaceholder === "settings.apiKeyOptional" ? t("settings.apiKeyOptional") : provider.keyPlaceholder}
          />
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            {provider.auth === "key-optional"
              ? t("setup.credential.keyOptional")
              : t("setup.credential.keyHint", { prefix: provider.keyPrefixHint })}
          </span>
          {provider.getKeyUrl && (
            <a
              className="btn-secondary"
              style={{ alignSelf: "flex-start", width: "fit-content", marginTop: 8, textDecoration: "none" }}
              href={provider.getKeyUrl} target="_blank" rel="noopener noreferrer"
            >
              <Key size={14} /> {t("setup.credential.getKey")} <ExternalLink size={12} />
            </a>
          )}
        </>
      )}
    </label>
  );

  return (
    <>
      <div className="setup-group-title">
        {provider.auth === "oauth" ? t("setup.credential.titleOauth")
          /* key-optional means the key isn't the point — a local server needs
             an endpoint, OpenRouter takes a key OR a sign-in. */
          : provider.auth === "key-optional" ? t("setup.credential.titleConnect")
          : t("setup.credential.titleKey")}
      </div>

      {provider.needsEndpoint && (
        <label className="modal-label">
          {provider.endpointKind === "azure" ? t("setup.credential.endpointAzure")
            : provider.endpointKind === "local" ? t("setup.credential.endpointLocal")
            : t("setup.credential.endpointOptional")}
          <input
            type="text"
            className="modal-input"
            value={draft.endpoint}
            onChange={(e) => patch({ endpoint: e.target.value })}
            placeholder={provider.endpointPlaceholder}
          />
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            {provider.endpointKind === "azure" ? t("setup.credential.endpointAzureHint")
              : provider.endpointKind === "local" ? t("setup.credential.endpointLocalHint")
              : t("setup.credential.endpointOptionalHint")}
          </span>
          {provider.needsEndpoint === "required" && draft.endpoint.trim() && !isHttpUrl(draft.endpoint) && (
            <span style={{ fontSize: 12, color: "var(--error)", marginTop: 4 }}>{t("setup.credential.endpointInvalid")}</span>
          )}
        </label>
      )}

      {provider.needsApiVersion && (
        <label className="modal-label">
          {t("setup.credential.apiVersion")}
          <input
            type="text"
            className="modal-input"
            value={draft.apiVersion}
            onChange={(e) => patch({ apiVersion: e.target.value })}
            placeholder={provider.defaultApiVersion}
          />
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{t("setup.credential.apiVersionHint")}</span>
        </label>
      )}

      {/* OpenRouter takes either credential. Sign-in is the nicer path on the
          desktop build; in the browser its loopback redirect can't complete,
          so the key field leads there. */}
      {provider.oauthDesktopOnly && !isDesktop
        ? (<>{keyField}{signInCard}</>)
        : (<>{signInCard}{keyField}</>)}
    </>
  );
}

function SetupModelStep({ t, provider, draft, onSelect }) {
  const [models, setModels] = useState([]);
  const [warning, setWarning] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");

  // Same request the Settings model picker makes — one server-side proxy, so
  // the stored key never reaches the browser.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setModels([]);
    setWarning(null);
    api("/admin/llm-models", {
      method: "POST",
      body: JSON.stringify({
        provider: provider.id,
        endpoint: draft.endpoint.trim() || undefined,
        apiKey: draft.apiKey || undefined,
        ...(draft.apiVersion.trim() ? { apiVersion: draft.apiVersion.trim() } : {}),
      }),
    })
      .then((r) => {
        if (cancelled) return;
        setModels(Array.isArray(r?.models) ? r.models : []);
        setWarning(r?.warning || null);
      })
      .catch((e) => { if (!cancelled) setError({ message: e?.message || String(e), code: e?.code }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Fetch once per visit to this step. The step only mounts after the
    // credential step is complete, and re-fetching on every keystroke of the
    // free-text model field below would be wrong.
  }, [provider.id]);

  const filtered = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = tokens.length
      ? models.filter((m) => tokens.every((tk) => `${m.id} ${m.name} ${m.description || ""}`.toLowerCase().includes(tk)))
      : models;
    // Pin the recommended default to the top so the obvious choice is first.
    const idx = list.findIndex((m) => m.id === provider.defaultModel);
    if (idx > 0) return [list[idx], ...list.slice(0, idx), ...list.slice(idx + 1)];
    return list;
  }, [models, query, provider.defaultModel]);
  const visible = filtered.slice(0, 60);

  const warningText = warning?.code === "CATALOG_ONLY" ? t("settings.modelPicker.catalogNote")
    : warning?.code === "KEY_MISSING" ? t("settings.modelPicker.catalogNoKey")
    : warning ? t("settings.modelPicker.catalogUpstreamFailed")
    : null;
  const errorText = error?.code === "ENDPOINT_REQUIRED" ? t("settings.modelPicker.endpointRequired")
    : error?.code === "UPSTREAM_AUTH" ? t("settings.modelPicker.authFailed")
    : error?.code === "UPSTREAM_UNREACHABLE" || error?.code === "UPSTREAM_ERROR" ? t("settings.modelPicker.unreachable")
    : error?.message;

  return (
    <>
      <div className="setup-group-title">{t("setup.model.title")}</div>
      <div className="setup-group-hint">{t("setup.model.subtitle")}</div>

      {/* Azure deployments and local servers use names no catalog can know, so
          the text field leads and the list is demoted to suggestions. */}
      {provider.freeTextModel && (
        <label className="modal-label">
          {t("setup.model.deploymentLabel")}
          <input
            type="text"
            className="modal-input"
            autoFocus
            value={draft.modelId}
            onChange={(e) => onSelect(e.target.value, "")}
            placeholder={provider.defaultModel}
          />
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            {provider.freeTextModel === "azure" ? t("setup.model.deploymentHintAzure") : t("setup.model.deploymentHintLocal")}
          </span>
        </label>
      )}

      {provider.freeTextModel && <div className="setup-group-title">{t("setup.model.suggestions")}</div>}

      {!provider.freeTextModel && (
        <div style={{ position: "relative" }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
          <input
            type="text"
            className="modal-input"
            style={{ paddingLeft: 32, width: "100%", boxSizing: "border-box" }}
            value={query}
            placeholder={t("settings.modelPicker.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {warningText && !loading && !error && (
        <div className="model-picker-warning">
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          {warningText}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", padding: "12px 0" }}>
          <Loader size={14} className="spin" /> {t("settings.modelPicker.loading")}
        </div>
      ) : error ? (
        <div style={{ fontSize: 12, color: "var(--error)" }}>{errorText}</div>
      ) : (
        <div className="model-picker-list">
          {visible.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", padding: "8px 0" }}>
              {t("settings.modelPicker.empty")}
            </div>
          )}
          {visible.map((m) => {
            const ctx = formatTokenCount(m.contextWindow);
            return (
              <div
                key={m.id}
                className={`model-card${m.id === draft.modelId ? " active" : ""}`}
                onClick={() => onSelect(m.id, m.name)}
              >
                <div className="model-card-header">
                  {m.id === draft.modelId ? <CircleCheck size={14} style={{ color: "var(--accent)" }} /> : <Circle size={14} style={{ color: "var(--text-muted)" }} />}
                  <div style={{ minWidth: 0 }}>
                    <div className="model-card-name">
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                      {m.id === provider.defaultModel && (
                        <span className="mcp-server-badge">{t("setup.model.recommended")}</span>
                      )}
                    </div>
                    <div className="model-card-id">{m.id}</div>
                    <div className="model-card-badges">
                      {ctx && <span className="mcp-server-badge mcp-server-badge-muted">{ctx} {t("settings.modelPicker.context")}</span>}
                      {m.pricing && (
                        <span className="mcp-server-badge mcp-server-badge-muted">
                          {t("settings.modelPicker.pricing", { input: formatModelPrice(m.pricing.input), output: formatModelPrice(m.pricing.output) })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function SetupVerifyStep({ t, provider, draft, test, saveError, profileWarning }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const running = !test || test.running;
  const failedRow = test && !running && !test.ok ? (SETUP_ERROR_ROW[test.code] ?? 2) : -1;

  const rowIcon = (i) => {
    if (running) return <Loader size={14} className="spin" style={{ color: "var(--accent)" }} />;
    if (test.ok) return <CircleCheck size={14} style={{ color: "var(--success)" }} />;
    if (i < failedRow) return <CircleCheck size={14} style={{ color: "var(--success)" }} />;
    if (i === failedRow) return <CircleX size={14} style={{ color: "var(--error)" }} />;
    return <Circle size={14} style={{ color: "var(--text-muted)" }} />;
  };

  return (
    <>
      <div className="setup-group-title">{t("setup.verify.title")}</div>
      <div className="setup-group-hint">{t("setup.verify.subtitle")}</div>

      {["reach", "credentials", "message"].map((row, i) => (
        <div key={row} className={`setup-check-row${!running && !test.ok && i > failedRow ? " pending" : ""}`}>
          {rowIcon(i)} <span>{t(`setup.verify.${row}`)}</span>
        </div>
      ))}

      {test && !running && test.ok && (
        <div className="setup-success">
          <CircleCheck size={16} />
          {t("setup.verify.success", {
            model: draft.modelName || draft.modelId,
            seconds: (test.latencyMs / 1000).toFixed(1),
          })}
        </div>
      )}

      {test && !running && !test.ok && (
        <>
          <div className="skill-editor-error" role="alert">
            <AlertTriangle size={14} />
            <span>{t(`setup.error.${test.code}`)}</span>
          </div>
          {provider.getKeyUrl && (test.code === "AUTH_INVALID" || test.code === "NO_CREDIT") && (
            <a className="btn-secondary" style={{ alignSelf: "flex-start", width: "fit-content", textDecoration: "none" }} href={provider.getKeyUrl} target="_blank" rel="noopener noreferrer">
              <Key size={14} /> {t("setup.credential.getKey")} <ExternalLink size={12} />
            </a>
          )}
          {test.detail && (
            <Collapsible.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
              <Collapsible.Trigger className="inline-collapse-trigger">
                {detailsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t("setup.verify.details")}
              </Collapsible.Trigger>
              <Collapsible.Content className="inline-collapse-content">
                <pre className="setup-details-pre">{test.detail}</pre>
              </Collapsible.Content>
            </Collapsible.Root>
          )}
        </>
      )}

      {profileWarning && (
        <div className="settings-info-banner"><Info size={14} /> {profileWarning}</div>
      )}
      {saveError && (
        <div className="skill-editor-error" role="alert">
          <AlertTriangle size={14} />
          <span>{saveError}</span>
        </div>
      )}
    </>
  );
}

// Non-admins can't configure an LLM, and the Settings dialog force-closes for
// them — without this their first message would vanish with no explanation.
function LlmNotConfiguredNotice({ open, onOpenChange }) {
  const { t } = useContext(AppContext);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <Info size={20} className="title-icon" />
            {t("setup.notAdmin.title")}
          </Dialog.Title>
          <div className="alert-description">{t("setup.notAdmin.body")}</div>
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-primary"><X size={14} /> {t("common.close")}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Sentinel value of the profile dropdown's "New profile…" entry.
const NEW_PROFILE_ID = "__new__";

// Human-readable summary of a template's deploymentOption manifest value
// (scalar = both runtimes, or a per-runtime { container, electron } map).
function formatTemplateDeployDefault(t, dep) {
  const label = (v) =>
    v === "electron" ? t("projectSettings.deploymentOption.electron")
    : v === "git-tag" ? t("projectSettings.deploymentOption.gitTag")
    : v === "web-export" ? t("projectSettings.deploymentOption.webExport")
    : t("projectSettings.deploymentOption.none");
  if (typeof dep === "string") return label(dep);
  const parts = [];
  if (dep.container !== undefined) parts.push(`${t("skills.appTemplateDeploy.containerShort")} → ${label(dep.container)}`);
  if (dep.electron !== undefined) parts.push(`${t("skills.appTemplateDeploy.electronShort")} → ${label(dep.electron)}`);
  return parts.join(" · ");
}

function SettingsDialog({ open, onOpenChange }) {
  const { apiKey, setApiKey, llmProvider, setLlmProvider, llmModelId, setLlmModelId, llmEndpoint, setLlmEndpoint, llmApiVersion, setLlmApiVersion, imageProvider, setImageProvider, imageModelId, setImageModelId, imageApiKey, setImageApiKey, serverManaged, serverConfig, imageServerManaged, userId, isAdmin, authEnabled, llmConfigured, reloadServerConfig, openSetup, t, lang, setLang } = useContext(AppContext);
  // Anchors the "configure an LLM provider" onboarding tooltip when the
  // dialog opens with no provider set yet (first run, or admin cancelled
  // out of the initial Settings auto-open and then tried to create a
  // project). The tooltip auto-clears once `llmConfigured` flips to true.
  const llmHintRef = useRef(null);
  // Storage tab is desktop-only: the physical workspace root is a real local
  // folder there, relocatable via the preload bridge. Absent in the browser build.
  const isDesktop = typeof window !== "undefined" && !!window.vcaDesktop;

  // Settings is an admin-only screen. Force-close for non-admins so any
  // code path that still calls setShowSettings(true) (e.g. the "missing
  // API key" auto-open or the deploy modal's "Open settings" button) is
  // a no-op instead of leaking the dialog. The actual `return null` lives
  // at the bottom of this component so the hook-call order stays stable
  // when isAdmin flips between renders.
  useEffect(() => {
    if (open && !isAdmin) onOpenChange(false);
  }, [open, isAdmin, onOpenChange]);
  // Reset the "configure an LLM provider" tooltip every time the dialog
  // reopens, so a user who dismissed it then bounced through the gallery
  // sees it again on the next try.
  const [llmHintDismissed, setLlmHintDismissed] = useState(false);
  useEffect(() => {
    if (open) {
      setLlmHintDismissed(false);
      setImportResult(null); // stale import feedback from a previous visit
    }
  }, [open]);
  const [tempKey, setTempKey] = useState(apiKey);
  // The provider <select> shows "Anthropic" visually when the bound value
  // is "", but its actual state stays "". Saving in that state writes
  // llmProvider="" to vca-settings.json, which the backend treats as
  // "fall through to env-var defaults" — so the next /config sees
  // configured=false even though the user just entered an API key.
  // Default to anthropic whenever there's no stored provider yet so the
  // form value matches what the user visually selected.
  const [tempProvider, setTempProvider] = useState(llmProvider || "anthropic");
  const [tempModelId, setTempModelId] = useState(llmModelId);
  const [tempEndpoint, setTempEndpoint] = useState(llmEndpoint);
  const [tempApiVersion, setTempApiVersion] = useState(llmApiVersion);
  // Context/output token overrides. Held as strings so the fields can be blank
  // (= auto-detect from pi's catalog); "" and "0" both mean "no override".
  const [tempContextWindow, setTempContextWindow] = useState("");
  const [tempMaxTokens, setTempMaxTokens] = useState("");
  const [tempImageProvider, setTempImageProvider] = useState(imageProvider);
  const [tempImageModelId, setTempImageModelId] = useState(imageModelId);
  const [tempImageKey, setTempImageKey] = useState(imageApiKey);
  const [tempImageUseLlmKey, setTempImageUseLlmKey] = useState(false);
  // SettingsDialog stays mounted across opens — don't leave the model picker
  // open when the settings dialog closes.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [imageModelPickerOpen, setImageModelPickerOpen] = useState(false);
  useEffect(() => { if (!open) setModelPickerOpen(false); }, [open]);

  // Configuration profiles: named snapshots of the AI Model Config form
  // (LLM + image config; web tools follow the provider automatically).
  // Applying happens server-side so stored keys never reach the browser.
  const [llmProfiles, setLlmProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  // Editable name of the selected profile — always part of the config form;
  // renames apply on Save. Selecting NEW_PROFILE_ID in the dropdown starts a
  // new profile: the current form values + this name are created on Save.
  const [tempProfileName, setTempProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState(null);
  const [profileDeleteOpen, setProfileDeleteOpen] = useState(false);
  // Per-category save feedback for the AI Model Config section (the settings
  // dialog no longer has a global Save; it stays open after saving).
  const [llmSaved, setLlmSaved] = useState(false);
  const [llmSaveError, setLlmSaveError] = useState(null);
  const llmSavedTimerRef = useRef(null);
  // Dirty tracking for the AI Model Config form: the footer Save lights up
  // when the current snapshot differs from the last clean baseline. A null
  // baseline means "adopt the next snapshot as clean" — set after (async)
  // hydration, profile apply, import, and save, so the freshly loaded values
  // never count as changes.
  const [llmBaseline, setLlmBaseline] = useState(null);
  // Footer save registration for the self-contained tab components
  // (Authentication / Network / Environment): the active tab reports
  // { dirty, busy, save }; tabs without a whole-category form never register
  // and the footer Save stays faded.
  const tabSaveFnRef = useRef(null);
  const [tabSaveState, setTabSaveState] = useState(null);
  const registerTabSave = useCallback((api) => {
    tabSaveFnRef.current = api ? api.save : null;
    setTabSaveState(api ? { dirty: !!api.dirty, busy: !!api.busy } : null);
  }, []);
  // Which profile was active when the dialog opened — Save compares against
  // it to show the "reopen your project" notice after a switch.
  const initialProfileIdRef = useRef("");
  const [profileSwitchNotice, setProfileSwitchNotice] = useState(false);
  // Encrypted config export/import (general tab)
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importEnvelope, setImportEnvelope] = useState(null);
  const [importFileError, setImportFileError] = useState("");
  // Outcome of the last import this session: { ok, applied: [...] } or
  // { ok: false, error }. Rendered in the transfer tab so the user gets
  // category-by-category feedback after the import dialog closes.
  const [importResult, setImportResult] = useState(null);
  const importFileRef = useRef(null);
  // Last-saved token overrides (normalized strings, "" = unset). Save compares
  // against these so a change to the context/output override — which alters the
  // resolved model — resets sessions like a provider/model change does.
  const initialContextWindowRef = useRef("");
  const initialMaxTokensRef = useRef("");

  // Push a settings record (GET /admin/vca-settings or a profile-apply
  // response) into the form fields.
  const hydrateFormFromSettings = (s) => {
    if (typeof s.apiKey === "string") setTempKey(s.apiKey);
    if (typeof s.llmProvider === "string") setTempProvider(s.llmProvider || "anthropic");
    if (typeof s.llmModelId === "string") setTempModelId(s.llmModelId);
    if (typeof s.llmEndpoint === "string") setTempEndpoint(s.llmEndpoint);
    if (typeof s.llmApiVersion === "string") setTempApiVersion(s.llmApiVersion);
    if (typeof s.llmContextWindow === "number") {
      const cw = s.llmContextWindow > 0 ? String(s.llmContextWindow) : "";
      setTempContextWindow(cw);
      initialContextWindowRef.current = cw;
    }
    if (typeof s.llmMaxTokens === "number") {
      const mt = s.llmMaxTokens > 0 ? String(s.llmMaxTokens) : "";
      setTempMaxTokens(mt);
      initialMaxTokensRef.current = mt;
    }
    if (typeof s.imageProvider === "string") setTempImageProvider(s.imageProvider);
    if (typeof s.imageModelId === "string") setTempImageModelId(s.imageModelId);
    if (typeof s.imageApiKey === "string") setTempImageKey(s.imageApiKey);
    if (typeof s.imageUseLlmKey === "boolean") setTempImageUseLlmKey(s.imageUseLlmKey);
  };

  // Parse a token-override field: blank / non-positive → 0 ("no override").
  const toPosInt = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  // The profile-relevant slice of the current form values. Secrets may hold
  // the UNCHANGED sentinel — the server resolves it to the stored key.
  const currentProfileFields = () => ({
    apiKey: tempKey,
    llmProvider: tempProvider,
    llmModelId: tempModelId.trim(),
    llmEndpoint: tempEndpoint.trim(),
    llmApiVersion: tempApiVersion.trim(),
    llmContextWindow: toPosInt(tempContextWindow),
    llmMaxTokens: toPosInt(tempMaxTokens),
    imageProvider: tempImageProvider,
    imageModelId: tempImageModelId.trim(),
    imageApiKey: tempImageKey,
    imageUseLlmKey: !!tempImageUseLlmKey,
  });

  // Everything the AI Model Config Save persists, as a comparable string.
  const llmSnapshot = JSON.stringify({
    ...currentProfileFields(),
    profileName: tempProfileName,
    profileId: selectedProfileId,
  });
  useEffect(() => {
    if (llmBaseline === null) setLlmBaseline(llmSnapshot);
  }, [llmSnapshot, llmBaseline]);
  const llmDirty = llmBaseline !== null && llmBaseline !== llmSnapshot;

  const applyProfile = async (id, prevId) => {
    setProfileBusy(true);
    setProfileError(null);
    try {
      const r = await api(`/admin/llm-profiles/${id}/apply`, { method: "POST", body: JSON.stringify({}) });
      if (r && r.settings) {
        hydrateFormFromSettings(r.settings);
        // Applied settings are live immediately — mirror save()'s context
        // updates and session reset so open chats pick up the new provider.
        setApiKey("");
        setLlmProvider(r.settings.llmProvider);
        setLlmModelId(r.settings.llmModelId);
        setLlmEndpoint(r.settings.llmEndpoint);
        setLlmApiVersion(r.settings.llmApiVersion);
        setImageProvider(r.settings.imageProvider);
        setImageModelId(r.settings.imageModelId);
        setImageApiKey("");
      }
      if (userId) { try { await api(`/users/${userId}/reset-sessions`, { method: "POST", body: JSON.stringify({}) }); } catch {} }
      try { await reloadServerConfig(); } catch {}
      notifyLlmProfilesChanged();
      const applied = llmProfiles.find((p) => p.id === id);
      setTempProfileName(applied ? applied.name : "");
      setLlmBaseline(null); // applied profile is persisted server-side — clean
    } catch (err) {
      setProfileError(err?.message || String(err));
      setSelectedProfileId(prevId || "");
    } finally {
      setProfileBusy(false);
    }
  };

  // Encrypted config import: file pick → parse the (still encrypted) envelope
  // client-side for instant format feedback, then hand it to the import dialog.
  const onPickConfigFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || parsed.format !== "vca-config-export" || typeof parsed.data !== "string") {
          throw new Error("format");
        }
        setImportFileError("");
        setImportResult(null);
        setImportEnvelope(parsed);
      } catch {
        setImportFileError(t("settings.transfer.fileInvalid"));
      }
    };
    reader.onerror = () => setImportFileError(t("settings.transfer.fileInvalid"));
    reader.readAsText(file);
  };

  // After a successful import the server-side settings are live immediately —
  // mirror applyProfile's context updates and session reset per applied category.
  const onConfigImported = async (r) => {
    if (r && r.settings) hydrateFormFromSettings(r.settings);
    const has = (c) => Array.isArray(r?.applied) && r.applied.includes(c);
    if (has("aiModelConfig") && r?.settings) {
      setApiKey("");
      setLlmProvider(r.settings.llmProvider);
      setLlmModelId(r.settings.llmModelId);
      setLlmEndpoint(r.settings.llmEndpoint);
      setLlmApiVersion(r.settings.llmApiVersion);
      setImageProvider(r.settings.imageProvider);
      setImageModelId(r.settings.imageModelId);
      setImageApiKey("");
    }
    if (has("profiles")) {
      const profiles = Array.isArray(r?.profiles) ? r.profiles : [];
      setLlmProfiles(profiles);
      const active = typeof r?.activeProfileId === "string" ? r.activeProfileId : "";
      setSelectedProfileId(active);
      initialProfileIdRef.current = active; // no spurious switch notice on Save
      const activeProfile = profiles.find((p) => p.id === active);
      setTempProfileName(activeProfile ? activeProfile.name : "");
    } else if (has("aiModelConfig")) {
      setSelectedProfileId("");
      initialProfileIdRef.current = "";
      setTempProfileName("");
    }
    if (has("mcpServers")) reloadMcpServers();
    if (has("aiModelConfig") && userId) {
      try { await api(`/users/${userId}/reset-sessions`, { method: "POST", body: JSON.stringify({}) }); } catch {}
    }
    try { await reloadServerConfig(); } catch {}
    // aiModelConfig alone also touches the store (clears activeProfileId).
    if (has("profiles") || has("aiModelConfig")) notifyLlmProfilesChanged();
    setLlmBaseline(null); // imported values are persisted — clean
    setImportResult({ ok: true, applied: Array.isArray(r?.applied) ? r.applied : [] });
  };

  const deleteProfile = async () => {
    if (!selectedProfileId) return;
    setProfileBusy(true);
    setProfileError(null);
    try {
      const r = await api(`/admin/llm-profiles/${selectedProfileId}`, { method: "DELETE" });
      setLlmProfiles(Array.isArray(r?.profiles) ? r.profiles : []);
      setSelectedProfileId("");
      setTempProfileName("");
      setLlmBaseline(null); // deletion is persisted immediately — clean
      notifyLlmProfilesChanged();
    } catch (err) {
      setProfileError(err?.message || String(err));
    } finally {
      setProfileBusy(false);
      setProfileDeleteOpen(false);
    }
  };

  // MCP servers (admin-only)
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpEditing, setMcpEditing] = useState(null); // { id?, name, url, authType, apiKey, enabled, replaceKey } or null
  const [mcpDeleteTarget, setMcpDeleteTarget] = useState(null);
  const [mcpError, setMcpError] = useState("");
  const [mcpBusyId, setMcpBusyId] = useState(null);
  const [mcpExpandedIds, setMcpExpandedIds] = useState({});

  // Users & Groups used to open their own dialogs from inside Settings; both
  // now render as an embedded panel under activeTab === "usersGroups".

  // Admin-managed system content (system prompt, app templates, skill repos).
  // Each tab lazy-loads its own slice when first activated; mutations hit the
  // /admin/* endpoints directly (no batching through the Save button).
  const [contentBusy, setContentBusy] = useState(false);
  const [contentError, setContentError] = useState(null);
  const [promptAdmin, setPromptAdmin] = useState(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptEditing, setPromptEditing] = useState(false);
  const [promptRepoDraft, setPromptRepoDraft] = useState("");
  const [tplAdmin, setTplAdmin] = useState({ local: [] });
  const [newTplName, setNewTplName] = useState("");
  const [newTplDescription, setNewTplDescription] = useState("");
  const [newTplAppType, setNewTplAppType] = useState("node");
  // Default deployment target the template stamps into new projects — kept
  // per runtime ("unset" = no template default for that runtime).
  const [newTplDeployContainer, setNewTplDeployContainer] = useState("unset");
  const [newTplDeployElectron, setNewTplDeployElectron] = useState("unset");
  const tplZipInputRef = useRef(null);

  const [activeTab, setActiveTab] = useState("general");
  useEffect(() => {
    if (open) setActiveTab("general");
  }, [open]);

  // Settings > Skills tab: platform-wide system skills (git-synced + admin-authored).
  const [systemSkillsAdmin, setSystemSkillsAdmin] = useState([]);
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  const [skillsSyncError, setSkillsSyncError] = useState(null);
  const [editingSystemSkill, setEditingSystemSkill] = useState(null);
  const [deleteSkillTarget, setDeleteSkillTarget] = useState(null);

  const loadSystemSkillsAdmin = async () => {
    // The merged per-user skills list is the only endpoint that returns BOTH
    // git-synced and admin-authored system skills; /admin/skills alone would
    // miss the git-synced ones.
    try {
      const all = await api(`/users/${userId}/skills`);
      setSystemSkillsAdmin((Array.isArray(all) ? all : []).filter(s => (s.kind ? s.kind === "system" : s.system)));
    } catch (err) {
      setSystemSkillsAdmin([]);
      setContentError(err && err.message ? err.message : String(err));
    }
  };

  const refreshSystemSkills = async () => {
    setSkillsRefreshing(true);
    setSkillsSyncError(null);
    try {
      const result = await api("/admin/sync-all", { method: "POST", body: JSON.stringify({}) });
      if (result && result.ok === false) {
        setSkillsSyncError(result.error || t("skills.syncErrorBody"));
      }
      await loadSystemSkillsAdmin();
    } catch (err) {
      console.error("Failed to refresh:", err);
      setSkillsSyncError(err && err.message ? err.message : String(err));
    } finally {
      setSkillsRefreshing(false);
    }
  };

  const deleteSystemSkill = async (skill) => {
    try {
      if (skill.source === "git" && skill.repoUrl) {
        // Repo-sourced skill: removing the repo link is the delete. The server
        // re-syncs + reseeds on DELETE so the cloned skill disappears at once.
        const r = await api("/admin/skill-repos", { method: "DELETE", body: JSON.stringify({ url: skill.repoUrl }) });
        if (r && r.sync && r.sync.ok === false) {
          setSkillsSyncError(r.sync.error || t("skills.syncErrorBody"));
        }
      } else {
        await api(`/admin/skills/${skill.dirName || skill.name}`, { method: "DELETE" });
      }
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    }
    setDeleteSkillTarget(null);
    loadSystemSkillsAdmin();
  };

  const loadPromptAdmin = async () => {
    try {
      const p = await api("/admin/system-prompt");
      setPromptAdmin(p || null);
      setPromptDraft(p && p.local && typeof p.local.content === "string" ? p.local.content : "");
      setPromptRepoDraft(p && p.repo && typeof p.repo.url === "string" ? p.repo.url : "");
    } catch (err) {
      setPromptAdmin(null);
      setContentError(err && err.message ? err.message : String(err));
    }
  };
  const loadTemplateAdmin = async () => {
    try {
      const r = await api("/admin/app-templates");
      setTplAdmin({
        local: Array.isArray(r && r.local) ? r.local : [],
      });
    } catch (err) {
      setTplAdmin({ local: [] });
      setContentError(err && err.message ? err.message : String(err));
    }
  };
  useEffect(() => {
    if (!open || !isAdmin) return;
    setContentError(null);
    if (activeTab === "systemPrompt") loadPromptAdmin();
    else if (activeTab === "appTemplates") loadTemplateAdmin();
    else if (activeTab === "skills") loadSystemSkillsAdmin();
  }, [open, isAdmin, activeTab]);

  const savePromptLocal = async () => {
    setContentBusy(true);
    setContentError(null);
    try {
      await api("/admin/system-prompt/local", { method: "PUT", body: JSON.stringify({ content: promptDraft }) });
      setPromptEditing(false);
      await loadPromptAdmin();
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    } finally {
      setContentBusy(false);
    }
  };
  const deletePromptLocal = async () => {
    setContentBusy(true);
    setContentError(null);
    try {
      await api("/admin/system-prompt/local", { method: "DELETE" });
      setPromptEditing(false);
      setPromptDraft("");
      await loadPromptAdmin();
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    } finally {
      setContentBusy(false);
    }
  };
  const savePromptRepo = async () => {
    const url = promptRepoDraft.trim();
    if (!url) return;
    setContentBusy(true);
    setContentError(null);
    try {
      await api("/admin/system-prompt/repo", { method: "PUT", body: JSON.stringify({ url }) });
      await loadPromptAdmin();
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    } finally {
      setContentBusy(false);
    }
  };
  const clearPromptRepo = async () => {
    setContentBusy(true);
    setContentError(null);
    try {
      await api("/admin/system-prompt/repo", { method: "DELETE" });
      setPromptRepoDraft("");
      await loadPromptAdmin();
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    } finally {
      setContentBusy(false);
    }
  };

  const addLocalTemplate = async () => {
    const name = newTplName.trim();
    if (!name) return;
    setContentBusy(true);
    setContentError(null);
    try {
      const dep = {};
      if (newTplDeployContainer !== "unset") dep.container = newTplDeployContainer;
      if (newTplDeployElectron !== "unset") dep.electron = newTplDeployElectron;
      await api("/admin/app-templates", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: newTplDescription,
          appType: newTplAppType,
          ...(Object.keys(dep).length ? { deploymentOption: dep } : {}),
        }),
      });
      setNewTplName("");
      setNewTplDescription("");
      setNewTplAppType("node");
      setNewTplDeployContainer("unset");
      setNewTplDeployElectron("unset");
      await loadTemplateAdmin();
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    } finally {
      setContentBusy(false);
    }
  };
  const removeLocalTemplate = async (dirName) => {
    setContentBusy(true);
    setContentError(null);
    try {
      await api(`/admin/app-templates/${encodeURIComponent(dirName)}`, { method: "DELETE" });
      await loadTemplateAdmin();
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    } finally {
      setContentBusy(false);
    }
  };
  const installTemplateZip = async (file) => {
    if (!file) return;
    setContentBusy(true);
    setContentError(null);
    try {
      // Raw fetch: api() would force a JSON content type onto the multipart body.
      const post = (replace) => {
        const fd = new FormData();
        fd.append("file", file);
        return fetch(`/api/admin/app-templates/install${replace ? "?replace=1" : ""}`, {
          method: "POST",
          body: fd,
        });
      };
      let res = await post(false);
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        const name = body.templateName || file.name;
        if (!window.confirm(t("skills.appTemplateReplaceConfirm", { name }))) return;
        res = await post(true);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await loadTemplateAdmin();
    } catch (err) {
      setContentError(err && err.message ? err.message : String(err));
    } finally {
      setContentBusy(false);
    }
  };
  const reloadMcpServers = async () => {
    setMcpLoading(true);
    setMcpError("");
    try {
      const data = await api("/admin/mcp-servers");
      setMcpServers(Array.isArray(data?.servers) ? data.servers : []);
    } catch (err) {
      setMcpError(err?.message || String(err));
    } finally {
      setMcpLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      // Pull the full record (with secrets redacted as the UNCHANGED sentinel)
      // from the admin endpoint so the form shows the actual stored values.
      // Falls back to the AppContext non-secret values if the fetch fails.
      setTempKey(apiKey);
      setTempProvider(llmProvider || "anthropic");
      setTempModelId(llmModelId);
      setTempEndpoint(llmEndpoint);
      setTempApiVersion(llmApiVersion);
      // No AppContext mirror for these — hydrated from the admin GET below.
      setTempContextWindow("");
      setTempMaxTokens("");
      initialContextWindowRef.current = "";
      initialMaxTokensRef.current = "";
      setTempImageProvider(imageProvider);
      setTempImageModelId(imageModelId);
      setTempImageKey(imageApiKey);
      setTempImageUseLlmKey(false);
      setSelectedProfileId("");
      initialProfileIdRef.current = "";
      setTempProfileName("");
      setProfileError(null);
      setLlmSaved(false);
      setLlmSaveError(null);
      setLlmBaseline(null);
      setExportDialogOpen(false);
      setImportEnvelope(null);
      setImportFileError("");
      if (isAdmin) {
        api("/admin/vca-settings")
          .then((r) => {
            if (r && r.settings) hydrateFormFromSettings(r.settings);
            setLlmBaseline(null); // freshly loaded values are the clean state
          })
          .catch(() => { /* fall back to AppContext defaults loaded above */ });
        api("/admin/llm-profiles")
          .then((r) => {
            const profiles = Array.isArray(r?.profiles) ? r.profiles : [];
            setLlmProfiles(profiles);
            const active = typeof r?.activeProfileId === "string" ? r.activeProfileId : "";
            setSelectedProfileId(active);
            initialProfileIdRef.current = active;
            const activeProfile = profiles.find((p) => p.id === active);
            setTempProfileName(activeProfile ? activeProfile.name : "");
            setLlmBaseline(null);
          })
          .catch(() => setLlmProfiles([]));
      }
      if (isAdmin) {
        reloadMcpServers();
      }
    }
  }, [open, isAdmin]);

  const openNewMcpServer = () => {
    setMcpError("");
    setMcpEditing({
      id: null,
      name: "",
      url: "",
      authType: "none",
      apiKey: "",
      enabled: true,
      replaceKey: false,
    });
  };

  const openEditMcpServer = (server) => {
    setMcpError("");
    setMcpEditing({
      id: server.id,
      name: server.name,
      url: server.url,
      authType: server.authType,
      apiKey: "",
      enabled: !!server.enabled,
      replaceKey: false,
    });
  };

  const saveMcpServer = async () => {
    if (!mcpEditing) return;
    const draft = mcpEditing;
    if (!draft.name.trim() || !draft.url.trim()) {
      setMcpError(t("settings.mcp.errorRequired"));
      return;
    }
    if (draft.authType === "apiKey") {
      const editingExisting = !!draft.id;
      const needsKey = !editingExisting || draft.replaceKey;
      if (needsKey && !draft.apiKey.trim()) {
        setMcpError(t("settings.mcp.errorApiKeyRequired"));
        return;
      }
    }
    setMcpError("");
    try {
      const body = {
        name: draft.name.trim(),
        url: draft.url.trim(),
        authType: draft.authType,
        enabled: !!draft.enabled,
      };
      if (draft.authType === "apiKey" && (!draft.id || draft.replaceKey)) {
        body.apiKey = draft.apiKey;
      }
      if (draft.id) {
        await api(`/admin/mcp-servers/${draft.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/admin/mcp-servers", { method: "POST", body: JSON.stringify(body) });
      }
      setMcpEditing(null);
      await reloadMcpServers();
    } catch (err) {
      setMcpError(err?.message || String(err));
    }
  };

  const toggleMcpEnabled = async (server) => {
    setMcpBusyId(server.id);
    setMcpError("");
    try {
      await api(`/admin/mcp-servers/${server.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      await reloadMcpServers();
    } catch (err) {
      setMcpError(err?.message || String(err));
    } finally {
      setMcpBusyId(null);
    }
  };

  const probeMcpServer = async (server) => {
    setMcpBusyId(server.id);
    setMcpError("");
    try {
      await api(`/admin/mcp-servers/${server.id}/probe`, { method: "POST", body: JSON.stringify({}) });
      await reloadMcpServers();
    } catch (err) {
      setMcpError(err?.message || String(err));
    } finally {
      setMcpBusyId(null);
    }
  };

  const confirmDeleteMcpServer = async () => {
    if (!mcpDeleteTarget) return;
    const id = mcpDeleteTarget.id;
    setMcpBusyId(id);
    setMcpError("");
    try {
      await api(`/admin/mcp-servers/${id}`, { method: "DELETE" });
      setMcpDeleteTarget(null);
      await reloadMcpServers();
    } catch (err) {
      setMcpError(err?.message || String(err));
    } finally {
      setMcpBusyId(null);
    }
  };

  const save = async () => {
    setLlmSaveError(null);
    setProfileError(null);
    // A new profile needs its name before anything is persisted.
    if (selectedProfileId === NEW_PROFILE_ID && !tempProfileName.trim()) {
      setProfileError(t("settings.profiles.nameRequired"));
      return;
    }
    const ctxStr = toPosInt(tempContextWindow) ? String(toPosInt(tempContextWindow)) : "";
    const maxStr = toPosInt(tempMaxTokens) ? String(toPosInt(tempMaxTokens)) : "";
    const overrideChanged = ctxStr !== initialContextWindowRef.current || maxStr !== initialMaxTokensRef.current;
    const llmChanged = tempProvider !== llmProvider || tempModelId.trim() !== llmModelId || tempEndpoint.trim() !== llmEndpoint || tempApiVersion.trim() !== llmApiVersion || overrideChanged;
    if (llmChanged && userId) {
      try { await api(`/users/${userId}/reset-sessions`, { method: "POST", body: JSON.stringify({}) }); } catch {}
    }

    // Persist to admin/vca-settings.json. Secret fields untouched in the form
    // still hold the UNCHANGED sentinel returned by the GET — the backend
    // preserves the stored secret when it sees that value.
    // theme / lang / thinkingLevel are per-user (saved via /users/:id/prefs),
    // not part of the deployment-wide admin/vca-settings.json record.
    const payload = {
      apiKey: tempKey,
      llmProvider: tempProvider,
      llmModelId: tempModelId.trim(),
      llmEndpoint: tempEndpoint.trim(),
      llmApiVersion: tempApiVersion.trim(),
      llmContextWindow: toPosInt(tempContextWindow),
      llmMaxTokens: toPosInt(tempMaxTokens),
      // Web tools are auto-configured from the LLM provider — always enabled,
      // provider-default options. Writing the defaults clears any legacy
      // customization from the removed manual web-tools UI.
      webSearchEnabled: true,
      webFetchEnabled: true,
      webSearchModelId: "",
      webSearchContextSize: "",
      webSearchEngine: "",
      webSearchMaxResults: 0,
      webFetchEngine: "",
      imageProvider: tempImageProvider,
      imageModelId: tempImageModelId.trim(),
      imageApiKey: tempImageKey,
      // A ChatGPT/Kimi OAuth token is not a reusable API key — "use LLM key"
      // can't apply while an OAuth-only LLM provider is selected.
      imageUseLlmKey: !!tempImageUseLlmKey && tempProvider !== "openai-codex" && tempProvider !== "kimi-coding",
    };
    try {
      const result = await api("/admin/vca-settings", { method: "PUT", body: JSON.stringify(payload) });
      console.log("[settings] saved", result);
    } catch (err) {
      console.error("[settings] failed to persist:", err);
      setLlmSaveError(`Failed to save settings: ${err?.message || String(err)}`);
      return;
    }
    // Profile bookkeeping. "New profile…" selected → create it from the just-
    // saved form values; existing profile selected → sync the form values and
    // the (possibly renamed) profile name into it.
    let effectiveProfileId = selectedProfileId;
    if (selectedProfileId === NEW_PROFILE_ID) {
      try {
        const r = await api("/admin/llm-profiles", {
          method: "POST",
          body: JSON.stringify({ name: tempProfileName.trim(), ...currentProfileFields() }),
        });
        setLlmProfiles(Array.isArray(r?.profiles) ? r.profiles : []);
        effectiveProfileId = typeof r?.activeProfileId === "string" ? r.activeProfileId : "";
        setSelectedProfileId(effectiveProfileId);
        notifyLlmProfilesChanged();
      } catch (err) {
        setProfileError(err?.message || String(err));
        return;
      }
    } else if (selectedProfileId) {
      const currentProfile = llmProfiles.find((p) => p.id === selectedProfileId);
      if (currentProfile) {
        const newName = tempProfileName.trim() || currentProfile.name;
        try {
          const r = await api(`/admin/llm-profiles/${selectedProfileId}`, {
            method: "PUT",
            body: JSON.stringify({ name: newName, ...currentProfileFields() }),
          });
          setLlmProfiles(Array.isArray(r?.profiles) ? r.profiles : []);
          if (newName !== currentProfile.name) notifyLlmProfilesChanged();
        } catch (err) {
          console.error("[settings] failed to update profile:", err);
        }
      }
    }
    // AppContext holds non-secret display values only — never the real keys.
    setApiKey("");
    setLlmProvider(tempProvider);
    setLlmModelId(tempModelId.trim());
    setLlmEndpoint(tempEndpoint.trim());
    setLlmApiVersion(tempApiVersion.trim());
    // New baseline for the override-changed check on the next Save.
    initialContextWindowRef.current = ctxStr;
    initialMaxTokensRef.current = maxStr;
    setImageProvider(tempImageProvider);
    setImageModelId(tempImageModelId.trim());
    setImageApiKey("");

    // Refetch /config so the app-level `llmConfigured` flag flips the moment
    // a provider is saved. Without this the "Create new project" button
    // would keep routing back to Settings until a full page reload.
    try { await reloadServerConfig(); } catch {}
    // Switched to a different profile (or created one) during this dialog
    // session: tell the user open projects keep the old configuration.
    if (effectiveProfileId && effectiveProfileId !== initialProfileIdRef.current) {
      initialProfileIdRef.current = effectiveProfileId;
      setProfileSwitchNotice(true);
    }
    // Per-category save: the dialog stays open; show transient feedback.
    setLlmBaseline(null);
    setLlmSaved(true);
    clearTimeout(llmSavedTimerRef.current);
    llmSavedTimerRef.current = setTimeout(() => setLlmSaved(false), 3000);
  };

  // Which web-tools backend the (possibly unsaved) provider selection maps
  // to. When the server is env-configured the browser can't infer fallbacks
  // (e.g. Foundry chat + Azure OpenAI search), so trust /config's resolution;
  // otherwise mirror the backend mapping for the currently selected provider.
  const webToolsProvider = serverManaged
    ? (serverConfig?.webTools?.searchProvider || "none")
    : (tempProvider === "openai" || tempProvider === "azure-openai" || tempProvider === "openrouter" || tempProvider === "anthropic")
      ? tempProvider
      : "none";
  const webToolsProviderName = {
    "openai": "OpenAI",
    "azure-openai": "Azure OpenAI",
    "openrouter": "OpenRouter",
    "anthropic": "Anthropic",
  }[webToolsProvider] || "";
  // OpenRouter and Anthropic bring a native fetch tool; everyone else gets the
  // local direct-fetch path (always available).
  const webFetchViaProvider = webToolsProvider === "openrouter" || webToolsProvider === "anthropic";
  const webSearchStatusText =
    webToolsProvider === "openai" ? t("settings.webSearch.status.openai")
    : webToolsProvider === "azure-openai" ? t("settings.webSearch.status.azure")
    : webToolsProvider === "openrouter" ? t("settings.webSearch.status.openrouter")
    : webToolsProvider === "anthropic" ? t("settings.webSearch.status.anthropic")
    : t("settings.webSearch.status.unsupported");
  const webFetchStatusText =
    webToolsProvider === "openrouter" ? t("settings.webFetch.status.openrouter")
    : webToolsProvider === "anthropic" ? t("settings.webFetch.status.anthropic")
    : t("settings.webFetch.status.direct");

  // Hook-safe admin gate: every hook above this line runs every render, so
  // returning null here doesn't change the hook-call order across re-renders.
  if (!isAdmin) return null;

  // These providers authenticate with a server-side OAuth token, not a
  // reusable API key — so "reuse the LLM key" for image generation can't apply.
  const llmUsesOAuthOnly = tempProvider === "openai-codex" || tempProvider === "kimi-coding";

  return (
    <>
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content wide settings-wide">
          <Dialog.Title className="modal-title">
            <Settings size={20} className="title-icon" />
            {t("settings.title")}
          </Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" className="settings-close-x" aria-label={t("common.close")}>
              <X size={18} />
            </button>
          </Dialog.Close>
          <div className="settings-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`settings-tab${activeTab === "general" ? " settings-tab-active" : ""}`}
              aria-selected={activeTab === "general"}
              onClick={() => setActiveTab("general")}
            >
              {t("settings.tabs.general") || "AI Model Config"}
            </button>
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "authentication" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "authentication"}
                onClick={() => setActiveTab("authentication")}
              >
                {t("settings.tabs.authentication") || "Authentication"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "versionControl" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "versionControl"}
                onClick={() => setActiveTab("versionControl")}
              >
                {t("settings.tabs.versionControl") || "Version Control"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "mcpServers" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "mcpServers"}
                onClick={() => setActiveTab("mcpServers")}
              >
                {t("settings.tabs.mcpServers") || "MCP Servers"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "usersGroups" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "usersGroups"}
                onClick={() => setActiveTab("usersGroups")}
              >
                {t("settings.tabs.usersGroups") || "Users & Groups"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "systemPrompt" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "systemPrompt"}
                onClick={() => setActiveTab("systemPrompt")}
              >
                {t("settings.tabs.systemPrompt") || "System Prompt"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "appTemplates" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "appTemplates"}
                onClick={() => setActiveTab("appTemplates")}
              >
                {t("settings.tabs.appTemplates") || "App Templates"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "skills" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "skills"}
                onClick={() => setActiveTab("skills")}
              >
                {t("settings.tabs.skills") || "Skills"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "network" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "network"}
                onClick={() => setActiveTab("network")}
              >
                {t("settings.tabs.network") || "Network"}
              </button>
            )}
            {/* Storage: workspace-root management on desktop, session-store
                info everywhere — so the tab shows in every build. */}
            <button
              type="button"
              role="tab"
              className={`settings-tab${activeTab === "storage" ? " settings-tab-active" : ""}`}
              aria-selected={activeTab === "storage"}
              onClick={() => setActiveTab("storage")}
            >
              {t("settings.tabs.storage") || "Storage"}
            </button>
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "environment" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "environment"}
                onClick={() => setActiveTab("environment")}
              >
                {t("settings.tabs.environment") || "Environment"}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                role="tab"
                className={`settings-tab${activeTab === "configTransfer" ? " settings-tab-active" : ""}`}
                aria-selected={activeTab === "configTransfer"}
                onClick={() => setActiveTab("configTransfer")}
              >
                {t("settings.tabs.configTransfer") || "Config Export/Import"}
              </button>
            )}
          </div>
          <div className="settings-body">
          {activeTab === "general" && (<>
          {isAdmin && (
            <>
          {serverManaged ? (
            <div className="modal-label">
              {t("settings.llmProvider")}
              <div className="modal-input" style={{ background: "var(--bg-tertiary)", opacity: 0.75, cursor: "default" }}>
                {serverConfig?.llm?.displayName}
              </div>
            </div>
          ) : (
            <>
              <label className="modal-label">
                {t("settings.profiles.title")}
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    value={selectedProfileId}
                    onChange={(e) => {
                      const id = e.target.value;
                      const prev = selectedProfileId;
                      setSelectedProfileId(id);
                      setProfileError(null);
                      if (id === NEW_PROFILE_ID) {
                        // Start a new profile from the current form values;
                        // it is created when the section is saved.
                        setTempProfileName("");
                        return;
                      }
                      if (id && id !== prev) applyProfile(id, prev);
                    }}
                    className="modal-input"
                    style={{ flex: 1 }}
                    disabled={profileBusy}
                  >
                    {!selectedProfileId && <option value="" disabled hidden>—</option>}
                    {llmProfiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                    <option value={NEW_PROFILE_ID}>{t("settings.profiles.newOption")}</option>
                  </select>
                  {selectedProfileId && selectedProfileId !== NEW_PROFILE_ID && (
                    <>
                      <AlertDialog.Root open={profileDeleteOpen} onOpenChange={setProfileDeleteOpen}>
                        <AlertDialog.Trigger asChild>
                          <button className="delete-skill-btn" disabled={profileBusy} title={t("settings.profiles.deleteTitle")}>
                            <Trash2 size={11} />
                          </button>
                        </AlertDialog.Trigger>
                        <AlertDialog.Portal>
                          <AlertDialog.Overlay className="alert-overlay" />
                          <AlertDialog.Content className="alert-content">
                            <AlertDialog.Title className="alert-title">
                              <AlertTriangle size={18} style={{ color: "var(--error)" }} />
                              {t("settings.profiles.deleteTitle")}
                            </AlertDialog.Title>
                            <AlertDialog.Description className="alert-description">
                              {t("settings.profiles.deleteMessage", { name: llmProfiles.find((p) => p.id === selectedProfileId)?.name || "" })}
                            </AlertDialog.Description>
                            <div className="modal-actions">
                              <AlertDialog.Cancel asChild>
                                <button className="btn-secondary">{t("common.cancel")}</button>
                              </AlertDialog.Cancel>
                              <AlertDialog.Action asChild>
                                <button className="btn-danger" onClick={deleteProfile}>
                                  <Trash2 size={14} /> {t("skills.delete")}
                                </button>
                              </AlertDialog.Action>
                            </div>
                          </AlertDialog.Content>
                        </AlertDialog.Portal>
                      </AlertDialog.Root>
                    </>
                  )}
                </div>
              </label>
              {selectedProfileId && (
                <label className="modal-label">
                  {t("settings.profiles.name")}
                  <input
                    type="text"
                    className="modal-input"
                    value={tempProfileName}
                    onChange={(e) => setTempProfileName(e.target.value)}
                    placeholder={t("settings.profiles.namePlaceholder")}
                    disabled={profileBusy}
                  />
                </label>
              )}
              {profileError && (
                <div className="skill-editor-error" role="alert">
                  <AlertTriangle size={14} />
                  <span>{profileError}</span>
                </div>
              )}
              {/* The guided wizard covers the same ground in plain language —
                  offered here so it stays reachable after the first run. */}
              <button
                className="btn-secondary btn-sm"
                style={{ alignSelf: "flex-start" }}
                onClick={() => { onOpenChange(false); openSetup(); }}
              >
                <Sparkles size={14} /> {t("settings.runSetupWizard")}
              </button>
              <label className="modal-label" ref={llmHintRef}>
                {t("settings.llmProvider")}
                <select
                  value={tempProvider}
                  onChange={(e) => {
                    const p = e.target.value;
                    // Codex models come from pi's catalog; a model id carried
                    // over from another provider (e.g. an Azure deployment
                    // name) would fail at the ChatGPT backend, so re-baseline
                    // to the flagship id when switching to this provider.
                    if (p === "openai-codex" && tempProvider !== "openai-codex") setTempModelId("gpt-5.5");
                    // Kimi models come from pi's catalog too; re-baseline to the
                    // flagship id so a leftover id from another provider doesn't
                    // fail at the Kimi backend.
                    if (p === "kimi-coding" && tempProvider !== "kimi-coding") setTempModelId("k3");
                    // Gemini models come from pi's catalog; re-baseline to a
                    // known flagship id so a leftover id from another provider
                    // doesn't fail at the Google backend.
                    if (p === "google" && tempProvider !== "google") setTempModelId("gemini-2.5-pro");
                    setTempProvider(p);
                  }}
                  className="modal-input"
                >
                  <option value="anthropic">{t("settings.anthropic")}</option>
                  <option value="azure-ai-foundry">{t("settings.azureFoundry")}</option>
                  <option value="azure-openai">{t("settings.azureOpenai")}</option>
                  <option value="openai">{t("settings.openai")}</option>
                  <option value="google">{t("settings.google")}</option>
                  <option value="openai-codex">{t("settings.openaiCodex")}</option>
                  <option value="kimi-coding">{t("settings.kimiCoding")}</option>
                  <option value="openrouter">{t("settings.openrouter")}</option>
                  <option value="openai-compatible">{t("settings.openaiCompatible")}</option>
                </select>
              </label>
              {(tempProvider === "azure-ai-foundry" || tempProvider === "azure-openai" || tempProvider === "openai-compatible" || tempProvider === "openrouter") && (
                <label className="modal-label">
                  {t("settings.endpoint")}
                  {tempProvider === "openrouter" && (
                    <span style={{ display: "block", fontWeight: "normal", opacity: 0.6, fontSize: "0.85em" }}>
                      {t("settings.endpointOptional")}
                    </span>
                  )}
                  <input
                    type="text"
                    value={tempEndpoint}
                    onChange={(e) => setTempEndpoint(e.target.value)}
                    placeholder={
                      tempProvider === "azure-openai" ? "https://...azure-api.net/apim-openai/openai/"
                      : tempProvider === "openrouter" ? "https://openrouter.ai/api/v1"
                      : tempProvider === "openai-compatible" ? "http://localhost:1234/v1"
                      : "https://...services.ai.azure.com/anthropic"
                    }
                    className="modal-input"
                  />
                </label>
              )}
              {tempProvider === "azure-openai" && (
                <label className="modal-label">
                  {t("settings.apiVersion")}
                  <input
                    type="text"
                    value={tempApiVersion}
                    onChange={(e) => setTempApiVersion(e.target.value)}
                    placeholder="2025-04-01-preview"
                    className="modal-input"
                  />
                </label>
              )}
              {tempProvider === "openai-codex" ? (
                // No API key for the ChatGPT-subscription provider — the
                // credential is an OAuth token managed server-side. tempKey is
                // left untouched (the UNCHANGED sentinel round-trips on Save).
                <ProviderSignInCard
                  t={t} active={open} reloadServerConfig={reloadServerConfig}
                  apiBase="/admin/codex-auth" keyPrefix="settings.codex"
                  methods={["browser", "device_code"]} allowManualPaste
                />
              ) : tempProvider === "kimi-coding" ? (
                // Kimi Code is subscription-only (device-code sign-in); no API
                // key field, same as codex.
                <ProviderSignInCard
                  t={t} active={open} reloadServerConfig={reloadServerConfig}
                  apiBase="/admin/kimi-auth" keyPrefix="settings.kimi"
                  methods={["device_code"]}
                />
              ) : (
              <label className="modal-label">
                {t("settings.apiKey")}
                <input
                  type="password"
                  value={tempKey}
                  onChange={(e) => setTempKey(e.target.value)}
                  placeholder={
                    tempProvider === "anthropic" ? "sk-ant-..."
                    : tempProvider === "openai" ? "sk-..."
                    : tempProvider === "google" ? "AIza..."
                    : tempProvider === "openrouter" ? "sk-or-..."
                    : tempProvider === "openai-compatible" ? t("settings.apiKeyOptional")
                    : "Azure API Key"
                  }
                  className="modal-input"
                />
              </label>
              )}
              {tempProvider === "openrouter" && (
                // OpenRouter accepts a static API key (above) OR an OAuth
                // sign-in that mints one automatically. The OAuth path completes
                // via a local browser redirect, so it's desktop-only — the key
                // field stays as the remote fallback.
                <ProviderSignInCard
                  t={t} active={open} reloadServerConfig={reloadServerConfig}
                  apiBase="/admin/openrouter-auth" keyPrefix="settings.openrouter.oauth"
                  methods={["browser"]} note
                />
              )}
              <label className="modal-label">
                {tempProvider === "azure-ai-foundry" ? t("settings.modelName") : t("settings.modelId")}
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    value={tempModelId}
                    onChange={(e) => setTempModelId(e.target.value)}
                    placeholder={
                      tempProvider === "openrouter" ? "anthropic/claude-sonnet-5"
                      : tempProvider === "openai-compatible" ? "e.g. local-model"
                      : tempProvider === "google" ? "gemini-2.5-pro"
                      : tempProvider === "kimi-coding" ? "k3"
                      : tempProvider === "openai" || tempProvider === "azure-openai" || tempProvider === "openai-codex" ? "gpt-5.5"
                      : "claude-sonnet-5"
                    }
                    className="modal-input"
                    style={{ flex: 1 }}
                  />
                  {/* Live model listing for providers with a list API.
                      azure-openai uses the Azure OpenAI Models API (base model
                      ids — enter the matching deployment name). azure-ai-foundry
                      has none (Claude models, no list endpoint). openai-codex
                      browses pi's catalog (the ChatGPT backend has no list API). */}
                  {(tempProvider === "anthropic" || tempProvider === "openai" || tempProvider === "google" || tempProvider === "openai-codex" || tempProvider === "kimi-coding" || tempProvider === "openrouter" || tempProvider === "openai-compatible" || tempProvider === "azure-openai") && (
                    <button
                      className="btn-secondary"
                      style={{ whiteSpace: "nowrap" }}
                      onClick={() => setModelPickerOpen(true)}
                    >
                      <Search size={14} /> {t("settings.modelPicker.browse")}
                    </button>
                  )}
                </div>
              </label>
              <label className="modal-label">
                {t("settings.contextWindowOverride")}
                <input
                  type="number"
                  min="0"
                  value={tempContextWindow}
                  onChange={(e) => setTempContextWindow(e.target.value)}
                  placeholder={t("settings.contextWindowAuto")}
                  className="modal-input"
                />
                <span style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                  {t("settings.contextWindowHint")}
                </span>
              </label>
              <label className="modal-label">
                {t("settings.maxTokensOverride")}
                <input
                  type="number"
                  min="0"
                  value={tempMaxTokens}
                  onChange={(e) => setTempMaxTokens(e.target.value)}
                  placeholder={t("settings.contextWindowAuto")}
                  className="modal-input"
                />
              </label>
            </>
          )}
          <div className="settings-divider" />
          <div className="settings-section-title">
            <Globe size={14} /> {t("settings.webToolsSection")}
          </div>
          {/* Web tools are auto-configured from the LLM provider — this is a
              read-only availability display, no manual tuning. */}
          <div className="modal-label" style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <span>{t("settings.webTools.search")}</span>
            <span style={{ fontWeight: "normal", fontSize: 13, color: "var(--text-muted)" }}>
              {webToolsProvider !== "none"
                ? t("settings.webTools.viaProvider", { provider: webToolsProviderName })
                : t("settings.webTools.notAvailable")}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "-2px 0 8px 0" }}>
            {webSearchStatusText}
            {serverManaged && webToolsProvider === "none" && serverConfig?.webTools?.reason ? ` (${serverConfig.webTools.reason})` : ""}
          </div>
          <div className="modal-label" style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <span>{t("settings.webTools.fetch")}</span>
            <span style={{ fontWeight: "normal", fontSize: 13, color: "var(--text-muted)" }}>
              {webFetchViaProvider
                ? t("settings.webTools.viaProvider", { provider: webToolsProviderName })
                : t("settings.webTools.localFetch")}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "-2px 0 8px 0" }}>
            {webFetchStatusText}
          </div>
          <div className="settings-divider" />
          <div className="settings-section-title">
            <ImageIcon size={14} /> {t("settings.imageSection")}
          </div>
          {imageServerManaged ? (
            <div className="modal-label">
              {t("settings.apiKey")}
              <div className="modal-input" style={{ background: "var(--bg-tertiary)", opacity: 0.75, cursor: "default" }}>
                {serverConfig?.image?.maskedKey}
              </div>
            </div>
          ) : (
            <>
              <label className="modal-label">
                {t("settings.imageProvider")}
                <select
                  value={tempImageProvider}
                  onChange={(e) => {
                    const next = e.target.value;
                    setTempImageProvider(next);
                    // Reset model id to a known-good default when the prior
                    // value clearly belongs to another provider's namespace.
                    const m = tempImageModelId;
                    if (next === "google" && !m.startsWith("gemini")) {
                      setTempImageModelId("gemini-3.1-flash-image-preview");
                    } else if (next === "openai" && !m.startsWith("gpt-") && !m.startsWith("dall-")) {
                      setTempImageModelId("gpt-image-1");
                    } else if (next === "openrouter" && !m.includes("/")) {
                      setTempImageModelId("google/gemini-2.5-flash-image-preview");
                    }
                  }}
                  className="modal-input"
                >
                  <option value="google">{t("settings.image.google")}</option>
                  <option value="openai">{t("settings.image.openai")}</option>
                  <option value="openrouter">{t("settings.image.openrouter")}</option>
                </select>
              </label>
              <label className="modal-label">
                {t("settings.modelId")}
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    value={tempImageModelId}
                    onChange={(e) => setTempImageModelId(e.target.value)}
                    placeholder={
                      tempImageProvider === "openai" ? "gpt-image-1"
                      : tempImageProvider === "openrouter" ? "google/gemini-2.5-flash-image-preview"
                      : "gemini-3.1-flash-image-preview"
                    }
                    className="modal-input"
                    style={{ flex: 1 }}
                  />
                  {/* Google has no model-list API — Browse only where live
                      image-model listing is supported. */}
                  {(tempImageProvider === "openai" || tempImageProvider === "openrouter") && (
                    <button
                      className="btn-secondary"
                      style={{ whiteSpace: "nowrap" }}
                      onClick={() => setImageModelPickerOpen(true)}
                    >
                      <Search size={14} /> {t("settings.modelPicker.browse")}
                    </button>
                  )}
                </div>
              </label>
              <label className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={tempImageUseLlmKey && !llmUsesOAuthOnly}
                  disabled={llmUsesOAuthOnly}
                  onChange={(e) => setTempImageUseLlmKey(e.target.checked)}
                />
                <span>{t("settings.image.useLlmKey")}</span>
                {tempProvider === "openai-codex" && (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {t("settings.codex.imageKeyUnavailable")}
                  </span>
                )}
                {tempProvider === "kimi-coding" && (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {t("settings.kimi.imageKeyUnavailable")}
                  </span>
                )}
              </label>
              {(!tempImageUseLlmKey || llmUsesOAuthOnly) && (
                <label className="modal-label">
                  {t("settings.apiKey")}
                  <input
                    type="password"
                    value={tempImageKey}
                    onChange={(e) => setTempImageKey(e.target.value)}
                    placeholder={
                      tempImageProvider === "openai" ? "sk-..."
                      : tempImageProvider === "openrouter" ? "sk-or-..."
                      : "Google AI API Key"
                    }
                    className="modal-input"
                  />
                </label>
              )}
            </>
          )}
          {llmSaveError && (
            <div className="skill-editor-error" role="alert">
              <AlertTriangle size={14} />
              <span>{llmSaveError}</span>
            </div>
          )}
            </>
          )}
          </>)}
          {activeTab === "versionControl" && isAdmin && (
            <VersionControlTab t={t} />
          )}
          {activeTab === "authentication" && isAdmin && (
            <AuthenticationTab t={t} userId={userId} onAuthFlip={onOpenChange} registerSave={registerTabSave} />
          )}
          {activeTab === "network" && isAdmin && (
            <NetworkTab t={t} registerSave={registerTabSave} />
          )}
          {activeTab === "storage" && (
            <>
              {isDesktop && (
                <>
                  <StorageTab t={t} />
                  <div className="settings-divider" />
                </>
              )}
              {/* Session store (read-only) — moved here from AI Model Config */}
              <div className="settings-section-title">
                <Lock size={14} /> Session store
              </div>
              <div className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 13 }}>
                <span>Backend:</span>
                <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                  {serverConfig?.sessionStore?.description || "unknown"}
                </span>
              </div>
            </>
          )}
          {activeTab === "environment" && isAdmin && (
            <EnvironmentTab t={t} registerSave={registerTabSave} />
          )}
          {activeTab === "configTransfer" && isAdmin && (
            <>
              <div className="settings-section-title">
                <ArrowRightLeft size={14} /> {t("settings.transfer.section")}
              </div>
              <div className="modal-label" style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 10 }}>
                {t("settings.transfer.tabIntro")}
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button className="btn-primary" onClick={() => setExportDialogOpen(true)}>
                  <Download size={14} /> {t("settings.transfer.exportBtn")}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => { setImportFileError(""); importFileRef.current && importFileRef.current.click(); }}
                >
                  <Upload size={14} /> {t("settings.transfer.importBtn")}
                </button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={onPickConfigFile}
                />
              </div>
              {importFileError && (
                <div className="skill-editor-error" role="alert">
                  <AlertTriangle size={14} />
                  <span>{importFileError}</span>
                </div>
              )}
              {importResult && importResult.ok && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--success)", fontWeight: 600, fontSize: 13 }}>
                    <CircleCheck size={15} /> {t("settings.transfer.doneTitle")}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 4 }}>
                    {importResult.applied.map((c) => (
                      <div key={c} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                        <CircleCheck size={13} style={{ color: "var(--success)", flexShrink: 0 }} />
                        <span>{t(`settings.transfer.category.${c}`)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {importResult && !importResult.ok && (
                <div className="skill-editor-error" role="alert">
                  <AlertTriangle size={14} />
                  <span>{t("settings.transfer.resultFailed", { error: importResult.error })}</span>
                </div>
              )}
            </>
          )}
          {activeTab === "mcpServers" && isAdmin && (
            <>
              <div className="settings-section-title">
                <Wrench size={14} /> {t("settings.mcp.section")}
              </div>
              <div className="mcp-servers-list">
                {mcpLoading && mcpServers.length === 0 ? (
                  <div className="mcp-servers-empty">{t("settings.mcp.loading")}</div>
                ) : mcpServers.length === 0 ? (
                  <div className="mcp-servers-empty">{t("settings.mcp.empty")}</div>
                ) : (
                  mcpServers.map((s) => {
                    const expanded = !!mcpExpandedIds[s.id];
                    const probeError = s.probe && s.probe.ok === false ? s.probe.error : null;
                    return (
                      <div key={s.id} className="mcp-server-card">
                        <div className="mcp-server-header">
                          <button
                            className="mcp-server-toggle"
                            onClick={() => setMcpExpandedIds({ ...mcpExpandedIds, [s.id]: !expanded })}
                            aria-label={expanded ? t("common.close") : t("settings.mcp.showTools")}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                          <div className="mcp-server-meta">
                            <div className="mcp-server-name">
                              {s.name}
                              {!s.enabled && (
                                <span className="mcp-server-badge mcp-server-badge-muted">
                                  {t("settings.mcp.disabled")}
                                </span>
                              )}
                              {s.authType === "apiKey" && (
                                <span className="mcp-server-badge"><Key size={10} /> API key</span>
                              )}
                            </div>
                            <div className="mcp-server-url">{s.url}</div>
                            {probeError && (
                              <div className="mcp-server-error">
                                <AlertTriangle size={11} /> {probeError}
                              </div>
                            )}
                          </div>
                          <div className="mcp-server-actions">
                            <Tip label={s.enabled ? t("settings.mcp.disable") : t("settings.mcp.enable")}>
                              <button
                                className="mcp-server-icon-btn"
                                disabled={mcpBusyId === s.id}
                                onClick={() => toggleMcpEnabled(s)}
                              >
                                {s.enabled ? <CircleCheck size={14} /> : <CircleX size={14} />}
                              </button>
                            </Tip>
                            <Tip label={t("settings.mcp.refresh")}>
                              <button
                                className="mcp-server-icon-btn"
                                disabled={mcpBusyId === s.id}
                                onClick={() => probeMcpServer(s)}
                              >
                                <RefreshCw size={14} />
                              </button>
                            </Tip>
                            <Tip label={t("settings.mcp.edit")}>
                              <button
                                className="mcp-server-icon-btn"
                                disabled={mcpBusyId === s.id}
                                onClick={() => openEditMcpServer(s)}
                              >
                                <Pencil size={14} />
                              </button>
                            </Tip>
                            <Tip label={t("settings.mcp.delete")}>
                              <button
                                className="mcp-server-icon-btn mcp-server-icon-danger"
                                disabled={mcpBusyId === s.id}
                                onClick={() => setMcpDeleteTarget(s)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </Tip>
                          </div>
                        </div>
                        {expanded && (
                          <div className="mcp-tools-list">
                            {!s.enabled ? (
                              <div className="mcp-tools-empty">{t("settings.mcp.disabledHint")}</div>
                            ) : s.tools && s.tools.length > 0 ? (
                              s.tools.map((tool) => (
                                <div key={tool.name} className="mcp-tool-row">
                                  <div className="mcp-tool-name">{tool.name}</div>
                                  {tool.description && (
                                    <div className="mcp-tool-desc">{tool.description}</div>
                                  )}
                                </div>
                              ))
                            ) : probeError ? (
                              <div className="mcp-tools-empty">{t("settings.mcp.probeFailed")}</div>
                            ) : (
                              <div className="mcp-tools-empty">{t("settings.mcp.noTools")}</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              <div style={{ marginTop: 8 }}>
                <button className="btn-secondary" onClick={openNewMcpServer}>
                  <Plus size={14} /> {t("settings.mcp.add")}
                </button>
              </div>
              {mcpError && (
                <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>{mcpError}</div>
              )}
            </>
          )}
          {activeTab === "usersGroups" && isAdmin && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <UsersAdminDialog embedded oauthEnabled={authEnabled} />
              <GroupsAccessDialog embedded />
            </div>
          )}
          {activeTab === "systemPrompt" && isAdmin && (
            <>
              <div className="settings-section-title">
                <BookOpen size={14} /> {t("skills.systemPromptAdmin")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1 }}>
                    {promptAdmin && promptAdmin.activeSource === "local" && t("skills.systemPromptUsingLocal")}
                    {promptAdmin && promptAdmin.activeSource === "repo" && t("skills.systemPromptUsingRepo")}
                    {promptAdmin && promptAdmin.activeSource === null && t("skills.systemPromptNone")}
                    {promptAdmin && promptAdmin.activeVersion && promptAdmin.activeVersion !== "unknown" && (
                      <span className="skill-badge version" style={{ marginLeft: 8 }}>
                        {promptAdmin.activeVersion === "local" ? "local" : `v${promptAdmin.activeVersion}`}
                      </span>
                    )}
                  </span>
                  {!promptEditing && (
                    <button className="btn-primary" onClick={() => setPromptEditing(true)} disabled={contentBusy}>
                      <Pencil size={12} /> {t("skills.systemPromptEdit")}
                    </button>
                  )}
                </div>
                {promptEditing && (
                  <>
                    <textarea
                      className="modal-input"
                      rows={12}
                      value={promptDraft}
                      onChange={(e) => setPromptDraft(e.target.value)}
                      placeholder={t("skills.systemPromptLocalPlaceholder")}
                      disabled={contentBusy}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn-primary" onClick={savePromptLocal} disabled={contentBusy}>
                        {t("skills.systemPromptSaveLocal")}
                      </button>
                      {promptAdmin && promptAdmin.local && (
                        <button className="delete-skill-btn" onClick={deletePromptLocal} disabled={contentBusy}>
                          <Trash2 size={12} /> {t("skills.systemPromptDeleteLocal")}
                        </button>
                      )}
                      <button className="btn-secondary" onClick={() => { setPromptEditing(false); setPromptDraft(promptAdmin && promptAdmin.local ? promptAdmin.local.content : ""); }} disabled={contentBusy}>
                        {t("settings.cancel") || t("common.cancel")}
                      </button>
                    </div>
                  </>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    className="modal-input"
                    style={{ flex: 1 }}
                    value={promptRepoDraft}
                    onChange={(e) => setPromptRepoDraft(e.target.value)}
                    placeholder={t("skills.systemPromptRepoPlaceholder")}
                    disabled={contentBusy}
                  />
                  <button className="btn-primary" onClick={savePromptRepo} disabled={contentBusy || !promptRepoDraft.trim()}>
                    {t("skills.systemPromptSaveRepo")}
                  </button>
                  {promptAdmin && promptAdmin.repo && (
                    <button className="delete-skill-btn" onClick={clearPromptRepo} disabled={contentBusy}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                {contentError && (
                  <div className="skill-editor-error" role="alert">
                    <AlertTriangle size={14} />
                    <span>{contentError}</span>
                  </div>
                )}
              </div>
            </>
          )}
          {activeTab === "appTemplates" && isAdmin && (
            <>
              <div className="settings-section-title">
                <FileCode size={14} /> {t("skills.appTemplates")}
              </div>
              <div className="skills-list">
                {tplAdmin.local.length === 0 ? (
                  <div className="maintenance-windows-empty">{t("skills.appTemplatesEmpty")}</div>
                ) : (
                  tplAdmin.local.map(tpl => (
                    <div key={`local-${tpl.dirName}`} className="skill-item">
                      <div className="skill-info">
                        <div className="skill-name">
                          <FileCode size={14} />
                          {tpl.name}
                          <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 400 }}>
                            · {tpl.appType === "web" ? (t("skills.appTemplateType.web") || "Client-side web app") : (t("skills.appTemplateType.node") || "Node app")}
                          </span>
                          {tpl.deploymentOption !== undefined && tpl.deploymentOption !== null && (
                            <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 400 }}>
                              · {t("skills.appTemplateDeploy.badge")}: {formatTemplateDeployDefault(t, tpl.deploymentOption)}
                            </span>
                          )}
                        </div>
                        {tpl.description && <div className="skill-description">{tpl.description}</div>}
                      </div>
                      <button
                        className="icon-btn"
                        onClick={() => { window.location.href = `/api/admin/app-templates/${encodeURIComponent(tpl.dirName)}/export`; }}
                        disabled={contentBusy}
                        title={t("skills.appTemplateExport")}
                      >
                        <Download size={11} />
                      </button>
                      <button
                        className="delete-skill-btn"
                        onClick={() => removeLocalTemplate(tpl.dirName)}
                        disabled={contentBusy}
                        title={t("skills.delete")}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    type="text"
                    className="modal-input"
                    style={{ flex: "1 1 160px" }}
                    value={newTplName}
                    onChange={(e) => setNewTplName(e.target.value)}
                    placeholder={t("skills.appTemplateNamePlaceholder")}
                    disabled={contentBusy}
                  />
                  <input
                    type="text"
                    className="modal-input"
                    style={{ flex: "2 1 220px" }}
                    value={newTplDescription}
                    onChange={(e) => setNewTplDescription(e.target.value)}
                    placeholder={t("skills.appTemplateDescriptionPlaceholder")}
                    disabled={contentBusy}
                  />
                  <select
                    className="modal-input"
                    style={{ flex: "0 1 190px" }}
                    value={newTplAppType}
                    onChange={(e) => {
                      setNewTplAppType(e.target.value);
                      // web-export is only legal for web apps — drop stale picks.
                      if (e.target.value !== "web") {
                        setNewTplDeployContainer(v => (v === "web-export" ? "unset" : v));
                        setNewTplDeployElectron(v => (v === "web-export" ? "unset" : v));
                      }
                    }}
                    disabled={contentBusy}
                    title={t("skills.appTemplateTypeTitle") || "App type"}
                  >
                    <option value="node">{t("skills.appTemplateType.node") || "Node app"}</option>
                    <option value="web">{t("skills.appTemplateType.web") || "Client-side web app"}</option>
                  </select>
                  <button className="btn-primary" onClick={addLocalTemplate} disabled={contentBusy || !newTplName.trim()}>
                    <Plus size={14} /> {t("skills.appTemplateAddLocal")}
                  </button>
                  <button className="btn-secondary" onClick={() => tplZipInputRef.current && tplZipInputRef.current.click()} disabled={contentBusy}>
                    <Upload size={14} /> {t("skills.appTemplateInstallZip")}
                  </button>
                  <input
                    ref={tplZipInputRef}
                    type="file"
                    accept=".zip,application/zip"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files && e.target.files[0];
                      e.target.value = "";
                      installTemplateZip(f);
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("skills.appTemplateDeployDefault")}</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 200px", fontSize: 11, color: "var(--text-muted)" }}>
                    {t("skills.appTemplateDeploy.containerShort")}
                    <select
                      className="modal-input"
                      style={{ flex: 1 }}
                      value={newTplDeployContainer}
                      onChange={(e) => setNewTplDeployContainer(e.target.value)}
                      disabled={contentBusy}
                      title={t("skills.appTemplateDeployContainer")}
                    >
                      <option value="unset">{t("skills.appTemplateDeploy.unset")}</option>
                      <option value="electron">{t("projectSettings.deploymentOption.electron")}</option>
                      <option value="git-tag">{t("projectSettings.deploymentOption.gitTag")}</option>
                      {newTplAppType === "web" && <option value="web-export">{t("projectSettings.deploymentOption.webExport")}</option>}
                    </select>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 200px", fontSize: 11, color: "var(--text-muted)" }}>
                    {t("skills.appTemplateDeploy.electronShort")}
                    <select
                      className="modal-input"
                      style={{ flex: 1 }}
                      value={newTplDeployElectron}
                      onChange={(e) => setNewTplDeployElectron(e.target.value)}
                      disabled={contentBusy}
                      title={t("skills.appTemplateDeployElectron")}
                    >
                      <option value="unset">{t("skills.appTemplateDeploy.unset")}</option>
                      <option value="electron">{t("projectSettings.deploymentOption.electron")}</option>
                      <option value="git-tag">{t("projectSettings.deploymentOption.gitTag")}</option>
                      {newTplAppType === "web" && <option value="web-export">{t("projectSettings.deploymentOption.webExport")}</option>}
                    </select>
                  </label>
                </div>
                {contentError && (
                  <div className="skill-editor-error" role="alert">
                    <AlertTriangle size={14} />
                    <span>{contentError}</span>
                  </div>
                )}
              </div>
            </>
          )}
          {activeTab === "skills" && isAdmin && (
            <>
              <div className="settings-section-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Zap size={14} /> {t("skills.system")}
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <Tip label={t("skills.refreshAll")} side="bottom">
                    <button className="icon-btn" onClick={refreshSystemSkills} disabled={skillsRefreshing}>
                      <RefreshCw size={14} className={skillsRefreshing ? "spin" : ""} />
                    </button>
                  </Tip>
                  <button className="btn-new-skill" onClick={() => setEditingSystemSkill({})}>
                    <Plus size={14} /> {t("skills.newSkill")}
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
                {skillsSyncError && (
                  <div className="skill-editor-error" role="alert" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <AlertTriangle size={14} />
                      <span>{t("skills.syncErrorTitle")}</span>
                    </div>
                    <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 160, overflow: "auto", margin: "4px 0 0", fontSize: 12 }}>{skillsSyncError}</pre>
                  </div>
                )}
                <div className="skills-list">
                  {systemSkillsAdmin.map(s => (
                    <div key={s.name} className="skill-item">
                      <div className="skill-info">
                        <div className="skill-name">
                          <BookOpen size={14} />
                          {s.name}
                          <span className="skill-badge system">{t("skills.systemBadge")}</span>
                          {s.version && <span className="skill-badge version">v{s.version}</span>}
                          {s.repoUrl && (
                            <a href={s.repoUrl} target="_blank" rel="noopener noreferrer" className="skill-repo-link" title={t("skills.openRepo")}>
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </div>
                        <div className="skill-desc">{s.description}</div>
                      </div>
                      <div className="skill-actions">
                        {s.source === "admin" ? (
                          <button onClick={() => setEditingSystemSkill({ name: s.dirName || s.name, isEdit: true })}>
                            <Pencil size={11} /> {t("skills.edit")}
                          </button>
                        ) : (
                          <button onClick={() => setEditingSystemSkill({ name: s.dirName || s.name, isEdit: true, isView: true })}>
                            <Eye size={11} /> {t("skills.view")}
                          </button>
                        )}
                        {(s.source === "admin" || s.repoUrl) && (
                          <AlertDialog.Root open={deleteSkillTarget === s.name} onOpenChange={(o) => !o && setDeleteSkillTarget(null)}>
                            <AlertDialog.Trigger asChild>
                              <button className="delete-skill-btn" onClick={() => setDeleteSkillTarget(s.name)}>
                                <Trash2 size={11} /> {t("skills.delete")}
                              </button>
                            </AlertDialog.Trigger>
                            <AlertDialog.Portal>
                              <AlertDialog.Overlay className="alert-overlay" />
                              <AlertDialog.Content className="alert-content">
                                <AlertDialog.Title className="alert-title">
                                  <AlertTriangle size={18} style={{ color: "var(--error)" }} />
                                  {t("skills.deleteTitle")}
                                </AlertDialog.Title>
                                <AlertDialog.Description className="alert-description">
                                  {t("skills.deleteMessage", { name: s.name })}
                                </AlertDialog.Description>
                                <div className="modal-actions">
                                  <AlertDialog.Cancel asChild>
                                    <button className="btn-secondary">{t("common.cancel")}</button>
                                  </AlertDialog.Cancel>
                                  <AlertDialog.Action asChild>
                                    <button className="btn-danger" onClick={() => deleteSystemSkill(s)}>
                                      <Trash2 size={14} /> {t("skills.delete")}
                                    </button>
                                  </AlertDialog.Action>
                                </div>
                              </AlertDialog.Content>
                            </AlertDialog.Portal>
                          </AlertDialog.Root>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          </div>
          {/* The footer always shows the ACTIVE category's Save: highlighted
              when the category has unsaved changes, faded otherwise. Closing
              moved to the X in the top-right corner. Tabs whose actions apply
              immediately never register a save, so the button stays faded. */}
          {(() => {
            const footerSave = activeTab === "general" && isAdmin
              ? { dirty: llmDirty, busy: profileBusy, save }
              : tabSaveState
                ? { ...tabSaveState, save: () => tabSaveFnRef.current && tabSaveFnRef.current() }
                : null;
            return (
              <div className="modal-actions">
                {activeTab === "general" && llmSaved && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--success)", fontSize: 13 }}>
                    <CircleCheck size={14} /> {t("settings.savedFeedback")}
                  </span>
                )}
                <button
                  className={`btn-primary${footerSave?.dirty ? "" : " btn-faded"}`}
                  disabled={!footerSave || !footerSave.dirty || footerSave.busy}
                  onClick={() => footerSave && footerSave.save()}
                >
                  <Save size={14} /> {t("common.save")}
                </button>
              </div>
            );
          })()}
        </Dialog.Content>
        {/* Onboarding nudge: render as a Dialog.Portal sibling of
            Dialog.Content so it auto-unmounts on close and isn't clipped
            by the modal's overflow:auto. Only shows on the AI Model Config tab
            while the provider section is editable and unconfigured. */}
        {!serverManaged && !llmConfigured && activeTab === "general" && !llmHintDismissed && (
          <OnboardingTooltip
            targetRef={llmHintRef}
            text={t("onboarding.configureLlm")}
            side="bottom"
            onDismiss={() => setLlmHintDismissed(true)}
          />
        )}
      </Dialog.Portal>
    </Dialog.Root>

    <ModelPickerDialog
      open={modelPickerOpen}
      onOpenChange={setModelPickerOpen}
      provider={tempProvider}
      endpoint={tempEndpoint}
      apiKey={tempKey}
      apiVersion={tempApiVersion}
      currentModelId={tempModelId}
      onSelect={(id) => { setTempModelId(id.trim()); setModelPickerOpen(false); }}
    />

    <ModelPickerDialog
      open={imageModelPickerOpen}
      onOpenChange={setImageModelPickerOpen}
      provider={tempImageProvider}
      apiKey={tempImageUseLlmKey ? tempKey : tempImageKey}
      currentModelId={tempImageModelId}
      images={true}
      onSelect={(id) => { setTempImageModelId(id.trim()); setImageModelPickerOpen(false); }}
    />

    <ConfigExportDialog open={exportDialogOpen} onOpenChange={setExportDialogOpen} t={t} />

    <ConfigImportDialog
      envelope={importEnvelope}
      onClose={() => setImportEnvelope(null)}
      t={t}
      onApplied={onConfigImported}
      onFailed={(msg) => setImportResult({ ok: false, error: msg })}
    />

    {/* Shown after Save when a different profile was selected (or created)
        during this dialog session. */}
    <Dialog.Root open={profileSwitchNotice} onOpenChange={setProfileSwitchNotice}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <Info size={18} className="title-icon" />
            {t("settings.profiles.switchNoticeTitle")}
          </Dialog.Title>
          <Dialog.Description className="alert-description">
            {t("settings.profiles.switchNoticeBody")}
          </Dialog.Description>
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-primary">
                <X size={14} /> {t("common.close")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    {editingSystemSkill !== null && (
      <SkillEditorDialog
        open={true}
        onOpenChange={(o) => { if (!o) { setEditingSystemSkill(null); loadSystemSkillsAdmin(); } }}
        skillName={editingSystemSkill.name}
        isEdit={editingSystemSkill.isEdit}
        isView={editingSystemSkill.isView}
        asSystem={true}
      />
    )}

    {/* MCP server add/edit dialog */}
    <Dialog.Root open={!!mcpEditing} onOpenChange={(o) => { if (!o) setMcpEditing(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <Wrench size={18} className="title-icon" />
            {mcpEditing?.id ? t("settings.mcp.editTitle") : t("settings.mcp.addTitle")}
          </Dialog.Title>
          {mcpEditing && (
            <>
              <label className="modal-label">
                {t("settings.mcp.fieldName")}
                <input
                  type="text"
                  className="modal-input"
                  value={mcpEditing.name}
                  onChange={(e) => setMcpEditing({ ...mcpEditing, name: e.target.value })}
                  placeholder="GitHub"
                />
              </label>
              <label className="modal-label">
                {t("settings.mcp.fieldUrl")}
                <input
                  type="text"
                  className="modal-input"
                  value={mcpEditing.url}
                  onChange={(e) => setMcpEditing({ ...mcpEditing, url: e.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <label className="modal-label">
                {t("settings.mcp.fieldAuth")}
                <select
                  className="modal-input"
                  value={mcpEditing.authType}
                  onChange={(e) => setMcpEditing({ ...mcpEditing, authType: e.target.value, replaceKey: e.target.value === "apiKey", apiKey: "" })}
                >
                  <option value="none">{t("settings.mcp.authNone")}</option>
                  <option value="apiKey">{t("settings.mcp.authApiKey")}</option>
                </select>
              </label>
              {mcpEditing.authType === "apiKey" && (
                <>
                  {mcpEditing.id && !mcpEditing.replaceKey ? (
                    <div className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("settings.mcp.apiKeyExisting")}</span>
                      <button className="btn-secondary" onClick={() => setMcpEditing({ ...mcpEditing, replaceKey: true })}>
                        {t("settings.mcp.apiKeyReplace")}
                      </button>
                    </div>
                  ) : (
                    <label className="modal-label">
                      {t("settings.mcp.fieldApiKey")}
                      <input
                        type="password"
                        className="modal-input"
                        value={mcpEditing.apiKey}
                        onChange={(e) => setMcpEditing({ ...mcpEditing, apiKey: e.target.value })}
                        placeholder="Bearer token"
                        autoComplete="new-password"
                      />
                    </label>
                  )}
                </>
              )}
              <label className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!mcpEditing.enabled}
                  onChange={(e) => setMcpEditing({ ...mcpEditing, enabled: e.target.checked })}
                />
                <span>{t("settings.mcp.fieldEnabled")}</span>
              </label>
              {mcpError && <div style={{ color: "#dc2626", fontSize: 12 }}>{mcpError}</div>}
            </>
          )}
          <div className="modal-actions">
            <button className="btn-primary" onClick={saveMcpServer}>
              <Save size={14} /> {t("common.save")}
            </button>
            <button className="btn-secondary" onClick={() => setMcpEditing(null)}>
              <X size={14} /> {t("common.cancel")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    {/* MCP delete confirmation */}
    <Dialog.Root open={!!mcpDeleteTarget} onOpenChange={(o) => { if (!o) setMcpDeleteTarget(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="alert-overlay" />
        <Dialog.Content className="alert-content">
          <Dialog.Title className="alert-title">
            <AlertTriangle size={18} className="title-icon-danger" />
            {t("settings.mcp.deleteTitle")}
          </Dialog.Title>
          <div className="alert-description">
            {t("settings.mcp.deleteMessage", { name: mcpDeleteTarget?.name || "" })}
          </div>
          <div className="modal-actions wrap">
            <button className="btn-secondary" onClick={() => setMcpDeleteTarget(null)}>{t("common.cancel")}</button>
            <button
              className="btn-danger"
              disabled={mcpBusyId === mcpDeleteTarget?.id}
              onClick={confirmDeleteMcpServer}
            >
              <Trash2 size={14} /> {t("settings.mcp.delete")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    {/* Users & Groups now live as an embedded panel inside the Settings dialog
        (see activeTab === "usersGroups" above). No standalone dialogs. */}
    </>
  );
}

const PROJECT_STEPS_BASE = ["create_workspace", "copy_template", "install_dependencies", "initial_commit", "start_preview", "project_setup"];

function NewProjectDialog({ open, onOpenChange }) {
  const { createProject, projectSteps, setProjectSteps, projectLogs, setProjectLogs, t } = useContext(AppContext);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState([]);
  const [templateName, setTemplateName] = useState("");
  const inputRef = useRef(null);

  // Repository setup now lives in Project Settings → Version control (choose a
  // profile, then Create/Connect), so new-project creation has no remote step.
  const PROJECT_STEPS = PROJECT_STEPS_BASE;

  useEffect(() => {
    if (!open) return;
    setName("");
    setCreating(false);
    setError("");
    setProjectSteps({});
    setProjectLogs({});
    setTimeout(() => inputRef.current?.focus(), 50);
    (async () => {
      try {
        const cfg = await api("/config");
        const list = Array.isArray(cfg.appTemplates) ? cfg.appTemplates : [];
        setTemplates(list);
        const defaultEntry = list[0];
        setTemplateName(defaultEntry?.name || "");
      } catch {
        setTemplates([]);
        setTemplateName("");
      }
    })();
  }, [open]);

  const allFinished = creating && PROJECT_STEPS.every(id => projectSteps[id]?.status === "finished");
  const anyFailed = creating && PROJECT_STEPS.some(id => projectSteps[id]?.status === "failed");

  useEffect(() => {
    if (allFinished) {
      const timer = setTimeout(() => { setCreating(false); onOpenChange(false); }, 800);
      return () => clearTimeout(timer);
    }
  }, [allFinished]);

  const submit = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError("");
    setProjectSteps({});
    setProjectLogs({});
    try {
      await createProject(name.trim(), templateName || undefined);
    } catch (err) {
      setError(err.message || String(err));
      setCreating(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!creating || anyFailed) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <FolderPlus size={20} className="title-icon" />
            {t("newProject.title")}
          </Dialog.Title>
          {!creating && (
            <>
              <label className="modal-label">
                {t("newProject.name")}
                <input
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder={t("newProject.placeholder")}
                  className="modal-input"
                />
              </label>
              {templates.length > 0 && (
                <label className="modal-label">
                  {t("newProject.template")}
                  <select
                    className="modal-input"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                  >
                    {templates.map(tpl => (
                      <option key={tpl.name} value={tpl.name}>
                        {tpl.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          {creating && (
            <DeployStepList
              stepIds={PROJECT_STEPS}
              steps={projectSteps}
              logs={projectLogs}
              t={t}
              translationPrefix="project.step."
            />
          )}
          {error && <div style={{ color: "var(--error)", fontSize: 13 }}>{error}</div>}
          <div className="modal-actions">
            {!creating && (
              <button className="btn-primary" onClick={submit} disabled={!name.trim()}>
                <Plus size={14} /> {t("newProject.create")}
              </button>
            )}
            <Dialog.Close asChild>
              <button className="btn-secondary" disabled={creating && !anyFailed}>
                <X size={14} /> {t("common.cancel")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProjectsGalleryDialog({ open, onOpenChange }) {
  const { state, agentBusy, userId, loadProjects, selectProject, deleteProject, unlinkProject, setShowNewProject, isAdmin, lang, t } = useContext(AppContext);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showLinkOthers, setShowLinkOthers] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(null); // { id, name, ownerName } or null

  const [linkBusy, setLinkBusy] = useState({});

  const [searchQuery, setSearchQuery] = useState("");

  // Virtual folder tree (per-user metadata, see project-folders.ts). Folders
  // organize the list only — a project's disk location never changes.
  const [folders, setFolders] = useState([]);
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set());
  const [folderDialog, setFolderDialog] = useState(null); // {mode:"create",parentId} | {mode:"rename",id}
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [folderError, setFolderError] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState(null); // folder object
  const [moveTarget, setMoveTarget] = useState(null); // project object
  const [moveFolderId, setMoveFolderId] = useState("");

  // Drag & drop reorganization. The dragged item lives in a ref (so hovering
  // doesn't re-render mid-drag); dragOverId drives the hover highlight, and
  // dropConfirm holds the pending move until the user confirms it. The
  // ROOT_DROP sentinel represents the top level (drop outside any folder).
  const ROOT_DROP = "__root__";
  const dragItemRef = useRef(null); // { kind:"project"|"folder", id, name, parentId }
  // True from drag start until just after it ends. Native HTML5 drags emit
  // pointer/focus events that Radix's dismiss layer would otherwise read as an
  // outside interaction and use to close the gallery — this ref gates that off.
  const dragActiveRef = useRef(false);
  // Set on drag start, cleared on the next fresh mousedown. Lets a row tell a
  // real click apart from the click a drag gesture may leave behind, so a
  // drag-to-move never selects the project (which would close the gallery).
  const dragMovedRef = useRef(false);
  const [dragOverId, setDragOverId] = useState(null);
  const [dropConfirm, setDropConfirm] = useState(null); // { kind, id, name, targetId, targetName }

  const loadFolders = async () => {
    try {
      const r = await api(`/users/${userId}/project-folders`);
      setFolders(Array.isArray(r?.folders) ? r.folders : []);
    } catch {
      setFolders([]);
    }
  };
  useEffect(() => { if (open) { loadFolders(); setFolderError(null); } }, [open]);

  const folderIds = useMemo(() => new Set(folders.map(f => f.id)), [folders]);
  // Unknown/stale parent or assignment ids degrade to the top level.
  const normalizedParent = (id) => (id && folderIds.has(id) ? id : null);
  const childFolders = (parentId) =>
    folders.filter(f => normalizedParent(f.parentId) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, lang || undefined));
  const projectsInFolder = (folderId) =>
    state.projects.filter(p => normalizedParent(p.folderId) === folderId);
  // Depth-first flattening for the move dialog's indented options.
  const flattenedFolders = useMemo(() => {
    const acc = [];
    const walk = (parentId, depth) => {
      for (const f of childFolders(parentId)) {
        acc.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return acc;
  }, [folders, lang]);

  const toggleFolder = (id) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitFolderDialog = async () => {
    const name = folderNameDraft.trim();
    if (!name || !folderDialog) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      if (folderDialog.mode === "create") {
        await api(`/users/${userId}/project-folders`, {
          method: "POST",
          body: JSON.stringify({ name, parentId: folderDialog.parentId || null, userId }),
        });
        if (folderDialog.parentId) {
          setCollapsedFolders(prev => { const next = new Set(prev); next.delete(folderDialog.parentId); return next; });
        }
      } else {
        await api(`/users/${userId}/project-folders/${folderDialog.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, userId }),
        });
      }
      await loadFolders();
      setFolderDialog(null);
    } catch (err) {
      setFolderError(err?.message || String(err));
    } finally {
      setFolderBusy(false);
    }
  };

  const doDeleteFolder = async () => {
    const folder = confirmDeleteFolder;
    if (!folder) return;
    setConfirmDeleteFolder(null);
    try {
      await api(`/users/${userId}/project-folders/${folder.id}?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    } catch (err) {
      console.error("[project-folders] delete failed:", err);
    }
    await loadFolders();
    await loadProjects();
  };

  const doMoveProject = async () => {
    const target = moveTarget;
    if (!target) return;
    setMoveTarget(null);
    try {
      await api(`/projects/${target.id}/folder`, {
        method: "PUT",
        body: JSON.stringify({ userId, folderId: moveFolderId || null }),
      });
    } catch (err) {
      console.error("[project-folders] move failed:", err);
    }
    await loadProjects();
  };

  // ── Drag & drop: file projects and folders by dropping them on a folder
  // (or the top-level drop zone). Every drop routes through a confirm dialog. ──

  // rootId plus every folder transitively beneath it — a folder may not be
  // dropped into its own subtree, which would splice a cycle out of the tree.
  const descendantIds = (rootId) => {
    const set = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parentId && set.has(f.parentId) && !set.has(f.id)) {
          set.add(f.id);
          grew = true;
        }
      }
    }
    return set;
  };

  // Would dropping `item` on targetId (null = top level) both change something
  // and stay legal? Drives the hover highlight and gates the drop itself.
  const canDropOn = (item, targetId) => {
    if (!item) return false;
    if (item.parentId === targetId) return false; // already filed there
    if (item.kind === "folder") {
      if (targetId === item.id) return false; // onto itself
      if (targetId && descendantIds(item.id).has(targetId)) return false; // into own subtree
    }
    return true;
  };

  const startDrag = (e, kind, entity) => {
    dragActiveRef.current = true;
    dragMovedRef.current = true;
    dragItemRef.current = {
      kind,
      id: entity.id,
      name: entity.name,
      parentId: normalizedParent(kind === "folder" ? entity.parentId : entity.folderId),
    };
    // Firefox won't start a drag without payload data; the real payload is the ref.
    try { e.dataTransfer.setData("text/plain", entity.id); } catch { /* ignore */ }
    e.dataTransfer.effectAllowed = "move";
  };

  const endDrag = () => {
    dragItemRef.current = null;
    setDragOverId(null);
    // Keep the dismiss guard up for one more tick so any pointer/focus event the
    // browser queues as the drag unwinds can't slip through and close the gallery.
    setTimeout(() => { dragActiveRef.current = false; }, 0);
  };

  const dragOverTarget = (e, targetId) => {
    const item = dragItemRef.current;
    if (!item) return;
    e.stopPropagation(); // this target owns the hover; don't also flag its ancestor
    if (canDropOn(item, targetId)) {
      e.preventDefault(); // opt in as a drop target
      e.dataTransfer.dropEffect = "move";
      const key = targetId === null ? ROOT_DROP : targetId;
      if (dragOverId !== key) setDragOverId(key);
    } else {
      e.dataTransfer.dropEffect = "none";
      if (dragOverId !== null) setDragOverId(null);
    }
  };

  const dropOnTarget = (e, targetId, targetName) => {
    const item = dragItemRef.current;
    e.stopPropagation();
    e.preventDefault();
    setDragOverId(null);
    dragItemRef.current = null;
    if (!canDropOn(item, targetId)) return;
    setDropConfirm({ kind: item.kind, id: item.id, name: item.name, targetId, targetName });
  };

  const doDropMove = async () => {
    const move = dropConfirm;
    setDropConfirm(null);
    if (!move) return;
    try {
      if (move.kind === "folder") {
        await api(`/users/${userId}/project-folders/${move.id}/parent`, {
          method: "PUT",
          body: JSON.stringify({ userId, parentId: move.targetId || null }),
        });
        await loadFolders();
      } else {
        await api(`/projects/${move.id}/folder`, {
          method: "PUT",
          body: JSON.stringify({ userId, folderId: move.targetId || null }),
        });
      }
      // Expand the destination so the moved item is visible after the drop.
      if (move.targetId) {
        setCollapsedFolders(prev => { const next = new Set(prev); next.delete(move.targetId); return next; });
      }
      await loadProjects();
    } catch (err) {
      console.error("[project-folders] drop move failed:", err);
    }
  };

  const linkedSet = useMemo(
    () => new Set(state.projects.filter(p => p.isLink).map(p => p.id)),
    [state.projects]
  );

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return state.projects;
    return state.projects.filter(p => (p.name || "").toLowerCase().includes(q));
  }, [state.projects, searchQuery]);

  const handleUnlink = async (projectId) => {
    if (linkBusy[projectId]) return;
    setLinkBusy(prev => ({ ...prev, [projectId]: true }));
    try {
      await unlinkProject(projectId);
    } catch (err) {
      console.error("[unlink]", err);
    } finally {
      setLinkBusy(prev => { const n = { ...prev }; delete n[projectId]; return n; });
    }
  };

  const confirmProject = state.projects.find(p => p.id === confirmDelete);

  const handleSelect = (id, name) => {
    // Switching away mid-turn releases the running project's lock while the
    // agent keeps writing. Re-picking the already-open project isn't a switch,
    // but selectProject would still wipe messages/chats — just close instead.
    if (agentBusy) {
      if (id === state.currentProjectId) onOpenChange(false);
      return;
    }
    selectProject(id, name);
    onOpenChange(false);
  };

  const doDelete = (id, undeploy) => {
    setConfirmDelete(null);
    deleteProject(id, undeploy);
  };

  const handleCreateNew = () => {
    // Creating a project switches away from the current one (releasing its lock).
    if (agentBusy) return;
    onOpenChange(false);
    setTimeout(() => setShowNewProject(true), 150);
  };

  const renderProjectRow = (p, depth = 0) => {
    const isActive = p.id === state.currentProjectId;
    const isLinked = !!p.isLink;
    const deployedUrl = p.deployment?.deployed ? p.deployment.url : null;
    // Drag to re-file is disabled in the flat search view (no folder tree shown).
    const dndEnabled = !searchQuery.trim();
    // Mid-turn: every other project is unreachable (switching would abandon the
    // running one), and the active one can't be deleted or unlinked. Dragging
    // stays live — folder moves are per-user metadata and touch no workspace.
    const rowBlocked = agentBusy && !isActive;
    const activeBlocked = agentBusy && isActive;

    const kebabItems = [
      deployedUrl && {
        icon: <Globe size={14} />,
        label: t("project.openDeployment"),
        onClick: () => window.open(deployedUrl, "_blank", "noopener,noreferrer"),
      },
      {
        icon: <Download size={14} />,
        label: t("project.download"),
        onClick: () => window.open(
          `/api/projects/${p.id}/download?userId=${encodeURIComponent(userId)}&name=${encodeURIComponent(p.name)}`,
          "_blank"
        ),
      },
      {
        icon: <FolderOpen size={14} />,
        label: t("project.moveToFolder"),
        onClick: () => {
          setMoveFolderId(normalizedParent(p.folderId) || "");
          setMoveTarget(p);
        },
      },
      !isLinked && {
        icon: <Trash2 size={14} />,
        label: t("project.deleteTitle"),
        danger: true,
        disabled: activeBlocked,
        onClick: () => {
          setConfirmDelete(p.id);
        },
      },
    ];

    return (
      <div
        key={p.id}
        className={`project-row${isActive ? " active" : ""}${isLinked ? " linked" : ""}`}
        aria-disabled={rowBlocked || undefined}
        title={rowBlocked ? t("project.busyBlocked") : undefined}
        style={depth > 0 ? { marginLeft: depth * 18 } : undefined}
        draggable={dndEnabled}
        onMouseDown={dndEnabled ? () => { dragMovedRef.current = false; } : undefined}
        onDragStart={dndEnabled ? (e) => startDrag(e, "project", p) : undefined}
        onDragEnd={dndEnabled ? endDrag : undefined}
        onClick={() => {
          // Ignore the click a drag gesture can leave behind — it must not
          // select the project (which would close the gallery mid-move). Only
          // in the tree view, where a fresh mousedown always clears the flag
          // first; the flat search view has no drag to guard against.
          if (dndEnabled && dragMovedRef.current) { dragMovedRef.current = false; return; }
          handleSelect(p.id, p.name);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleSelect(p.id, p.name);
          }
        }}
      >
        {/* Icon works for linked projects too — the server resolves the
            owner's workspace for both hasIcon and the icon bytes. */}
        <span className="row-icon"><RowIcon projectId={p.id} hasIcon={!!p.settings?.hasIcon} /></span>
        <div className="project-row-main">
          <span className="project-row-name">{p.name}</span>
          {p.createdAt && (
            <span className="project-row-meta">
              {new Date(p.createdAt).toLocaleDateString(lang || undefined, { year: "numeric", month: "short", day: "numeric" })}
            </span>
          )}
        </div>
        <div className="project-row-badges" onClick={(e) => e.stopPropagation()}>
          {deployedUrl && (
            <button
              type="button"
              className="project-badge deployed"
              title={deployedUrl}
              onClick={() => window.open(deployedUrl, "_blank", "noopener,noreferrer")}
            >
              <Globe size={11} />
            </button>
          )}
          {isLinked && (
            <button
              type="button"
              className="project-badge linked"
              title={p.sourceDisplayName || t("project.linked")}
              onClick={() => setConfirmUnlink({ id: p.id, name: p.name, ownerName: p.sourceDisplayName || "" })}
              disabled={!!linkBusy[p.id] || activeBlocked}
            >
              <Link2 size={11} />
            </button>
          )}
          {formatProjectCost(p.cost?.totalUsd) && (
            <span className="project-badge cost" title={t("projectCost.tooltip")}>
              {formatProjectCost(p.cost.totalUsd)}
            </span>
          )}
        </div>
        <span onClick={(e) => e.stopPropagation()}>
          <RowKebab
            ariaLabel={t("projectsGallery.actions")}
            items={kebabItems}
          />
        </span>
      </div>
    );
  };

  const renderFolderRow = (folder, depth = 0) => {
    const kids = childFolders(folder.id);
    const projs = projectsInFolder(folder.id);
    const isCollapsed = collapsedFolders.has(folder.id);
    return (
      <div key={folder.id}>
        <div
          className={`project-folder-row${dragOverId === folder.id ? " drop-target" : ""}`}
          style={depth > 0 ? { marginLeft: depth * 18 } : undefined}
          draggable
          onMouseDown={() => { dragMovedRef.current = false; }}
          onDragStart={(e) => startDrag(e, "folder", folder)}
          onDragEnd={endDrag}
          onDragOver={(e) => dragOverTarget(e, folder.id)}
          onDrop={(e) => dropOnTarget(e, folder.id, folder.name)}
          onClick={() => {
            if (dragMovedRef.current) { dragMovedRef.current = false; return; }
            toggleFolder(folder.id);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleFolder(folder.id);
            }
          }}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <FolderOpen size={14} />
          <span className="project-folder-name">{folder.name}</span>
          {(projs.length > 0 || kids.length > 0) && (
            <span className="project-folder-count">{projs.length > 0 ? projs.length : ""}</span>
          )}
          <span onClick={(e) => e.stopPropagation()}>
            <RowKebab
              ariaLabel={t("projectFolders.actions")}
              items={[
                {
                  icon: <FolderPlus size={14} />,
                  label: t("projectFolders.newSub"),
                  onClick: () => { setFolderNameDraft(""); setFolderError(null); setFolderDialog({ mode: "create", parentId: folder.id }); },
                },
                {
                  icon: <Pencil size={14} />,
                  label: t("projectFolders.rename"),
                  onClick: () => { setFolderNameDraft(folder.name); setFolderError(null); setFolderDialog({ mode: "rename", id: folder.id }); },
                },
                {
                  icon: <Trash2 size={14} />,
                  label: t("projectFolders.delete"),
                  danger: true,
                  onClick: () => setConfirmDeleteFolder(folder),
                },
              ]}
            />
          </span>
        </div>
        {!isCollapsed && (
          <>
            {kids.map(k => renderFolderRow(k, depth + 1))}
            {projs.map(p => renderProjectRow(p, depth + 1))}
          </>
        )}
      </div>
    );
  };

  // A Radix "outside" interaction (pointer-down / interact / focus) on this
  // gallery can actually originate inside one of the nested confirm/move/folder
  // dialogs: those are portaled as siblings of the gallery, so Radix treats a
  // click on them as outside. Radix also defers an outside left-click's dismiss
  // to the trailing `click`; confirming a move closes the nested dialog first,
  // and the deferred check then finds the gallery topmost and would dismiss it
  // too (that's why moving a project via drag-drop or the kebab menu closed the
  // gallery). Prevent default whenever the origin lands inside another dialog so
  // the gallery stays open. closest() still resolves after the nested dialog
  // unmounts — React detaches the subtree's root but leaves its internal links.
  const keepGalleryOpen = (e) => {
    if (dragActiveRef.current) return true; // stray pointer/focus events mid native-drag
    const target = e?.detail?.originalEvent?.target;
    // Origin inside a nested dialog's content ([role]) or its own backdrop
    // (.alert-overlay — distinct from the gallery's own .modal-overlay, which
    // must still close the gallery). Covers confirm, cancel and backdrop clicks.
    return target instanceof Element && !!target.closest('[role="dialog"],[role="alertdialog"],.alert-overlay');
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content settings-wide gallery-modal"
          // Don't let an interaction that belongs to a nested dialog (or a native
          // drag) dismiss the gallery — see keepGalleryOpen. A genuine overlay
          // click and Escape still close it normally.
          onPointerDownOutside={(e) => { if (keepGalleryOpen(e)) e.preventDefault(); }}
          onInteractOutside={(e) => { if (keepGalleryOpen(e)) e.preventDefault(); }}
          onFocusOutside={(e) => { if (keepGalleryOpen(e)) e.preventDefault(); }}
        >
          <div className="gallery-header">
            <Dialog.Title className="modal-title">
              <LayoutGrid size={20} className="title-icon" />
              {t("projectsGallery.title")}
            </Dialog.Title>
            <input
              type="text"
              className="gallery-search"
              placeholder={t("projectsGallery.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button className="btn-primary" onClick={handleCreateNew} disabled={agentBusy}>
              <Plus size={14} /> {t("projectsGallery.createNew")}
            </button>
            <Tip label={t("projectFolders.new")} side="bottom">
              <button
                className="btn-secondary"
                onClick={() => { setFolderNameDraft(""); setFolderError(null); setFolderDialog({ mode: "create", parentId: null }); }}
              >
                <FolderPlus size={14} />
              </button>
            </Tip>
            {isAdmin && (
              <RowKebab
                ariaLabel={t("projectsGallery.linkOthers")}
                items={[
                  {
                    icon: <Link2 size={14} />,
                    label: t("projectsGallery.linkOthers"),
                    onClick: () => setShowLinkOthers(true),
                  },
                ]}
              />
            )}
          </div>

          {/* Everything that would abandon the running project is disabled below;
              this says why, once, instead of on every greyed-out control. */}
          {agentBusy && (
            <div className="settings-readonly-banner">
              {t("projectsGallery.agentBusy", { name: state.currentProjectName })}
            </div>
          )}

          <div className="gallery-body">
            {searchQuery.trim() ? (
              // Search ignores the folder tree — matches shown flat.
              filteredProjects.length === 0 ? (
                <div className="project-list-empty">
                  <FolderOpen size={28} />
                  <span>{t("projectsGallery.noResults")}</span>
                </div>
              ) : (
                <div className="project-list">
                  {filteredProjects.map(p => renderProjectRow(p))}
                </div>
              )
            ) : state.projects.length === 0 && folders.length === 0 ? (
              <div className="project-list-empty">
                <FolderOpen size={28} />
                <span>{t("projectsGallery.empty")}</span>
                <button className="btn-primary" onClick={handleCreateNew} disabled={agentBusy}>
                  <Plus size={14} /> {t("projectsGallery.createNew")}
                </button>
              </div>
            ) : (
              <div
                className={`project-list${dragOverId === ROOT_DROP ? " drop-root" : ""}`}
                onDragOver={(e) => dragOverTarget(e, null)}
                onDrop={(e) => dropOnTarget(e, null, t("projectFolders.topLevel"))}
              >
                {childFolders(null).map(f => renderFolderRow(f, 0))}
                {projectsInFolder(null).map(p => renderProjectRow(p, 0))}
              </div>
            )}

          </div>

          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary"><X size={14} /> {t("common.close")}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      <Dialog.Root open={!!confirmUnlink} onOpenChange={(o) => { if (!o) setConfirmUnlink(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <AlertTriangle size={18} className="title-icon-danger" />
              {t("project.unlinkConfirmTitle")}
            </Dialog.Title>
            <div className="alert-description">
              {t("project.unlinkConfirmMessage", { name: confirmUnlink?.name })}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmUnlink(null)}>{t("common.cancel")}</button>
              <button
                className="btn-danger"
                onClick={async () => {
                  const target = confirmUnlink;
                  setConfirmUnlink(null);
                  if (target) await handleUnlink(target.id);
                }}
              >
                <Link2Off size={14} /> {t("project.unlink")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <AlertTriangle size={18} className="title-icon-danger" />
              {t("project.deleteTitle")}
            </Dialog.Title>
            <div className="alert-description">
              {t("project.deleteMessage", { name: confirmProject?.name })}
            </div>
            <div className="modal-actions wrap">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</button>
              <button className="btn-danger" onClick={() => doDelete(confirmDelete, false)}>
                <Trash2 size={14} /> {t("project.delete")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Create / rename a virtual folder */}
      <Dialog.Root open={!!folderDialog} onOpenChange={(o) => { if (!o && !folderBusy) setFolderDialog(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <FolderPlus size={18} className="title-icon" />
              {folderDialog?.mode === "rename" ? t("projectFolders.renameTitle") : t("projectFolders.createTitle")}
            </Dialog.Title>
            <input
              type="text"
              className="modal-input"
              value={folderNameDraft}
              onChange={(e) => setFolderNameDraft(e.target.value)}
              placeholder={t("projectFolders.namePlaceholder")}
              autoFocus
              disabled={folderBusy}
              onKeyDown={(e) => { if (e.key === "Enter" && folderNameDraft.trim() && !folderBusy) submitFolderDialog(); }}
            />
            {folderError && (
              <div className="skill-editor-error" role="alert">
                <AlertTriangle size={14} />
                <span>{folderError}</span>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn-primary" onClick={submitFolderDialog} disabled={folderBusy || !folderNameDraft.trim()}>
                <Save size={14} /> {t("common.save")}
              </button>
              <button className="btn-secondary" onClick={() => setFolderDialog(null)} disabled={folderBusy}>
                {t("common.cancel")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Delete a virtual folder (contents move up one level) */}
      <Dialog.Root open={!!confirmDeleteFolder} onOpenChange={(o) => { if (!o) setConfirmDeleteFolder(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <AlertTriangle size={18} className="title-icon-danger" />
              {t("projectFolders.deleteTitle")}
            </Dialog.Title>
            <div className="alert-description">
              {t("projectFolders.deleteMessage", { name: confirmDeleteFolder?.name })}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteFolder(null)}>{t("common.cancel")}</button>
              <button className="btn-danger" onClick={doDeleteFolder}>
                <Trash2 size={14} /> {t("projectFolders.delete")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Move a project in the virtual hierarchy — explicit confirmation */}
      <Dialog.Root open={!!moveTarget} onOpenChange={(o) => { if (!o) setMoveTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <FolderOpen size={18} className="title-icon" />
              {t("projectFolders.moveTitle")}
            </Dialog.Title>
            <div className="alert-description">
              {t("projectFolders.moveMessage", { name: moveTarget?.name })}
            </div>
            <select
              className="modal-input"
              value={moveFolderId}
              onChange={(e) => setMoveFolderId(e.target.value)}
            >
              <option value="">{t("projectFolders.topLevel")}</option>
              {flattenedFolders.map(({ folder, depth }) => (
                <option key={folder.id} value={folder.id}>
                  {`${"   ".repeat(depth)}${folder.name}`}
                </option>
              ))}
            </select>
            <div className="alert-description" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("projectFolders.moveHint")}
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={doMoveProject}>
                <FolderOpen size={14} /> {t("projectFolders.move")}
              </button>
              <button className="btn-secondary" onClick={() => setMoveTarget(null)}>{t("common.cancel")}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Drag & drop move — explicit confirmation before the move commits */}
      <Dialog.Root open={!!dropConfirm} onOpenChange={(o) => { if (!o) setDropConfirm(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <FolderOpen size={18} className="title-icon" />
              {dropConfirm?.kind === "folder" ? t("projectFolders.moveFolderTitle") : t("projectFolders.moveTitle")}
            </Dialog.Title>
            <div className="alert-description">
              {dropConfirm?.targetId
                ? t("projectFolders.dropIntoMessage", { name: dropConfirm?.name, target: dropConfirm?.targetName })
                : t("projectFolders.dropToTopMessage", { name: dropConfirm?.name })}
            </div>
            <div className="alert-description" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("projectFolders.moveHint")}
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={doDropMove}>
                <FolderOpen size={14} /> {t("projectFolders.move")}
              </button>
              <button className="btn-secondary" onClick={() => setDropConfirm(null)}>{t("common.cancel")}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <LinkOtherProjectsDialog open={showLinkOthers} onOpenChange={setShowLinkOthers} />
    </Dialog.Root>
  );
}

function ProjectSettingsDialog({ projectId, project, userId, isAdmin, open, onOpenChange, onSaved, t }) {
  const [form, setForm] = useState(null);
  const [initial, setInitial] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  // Read-only monitoring data; never part of the form/dirty/save flow.
  const [cost, setCost] = useState(null);
  // App version (main.minor.build). Owner-editable main/minor; build is
  // auto-bumped by the agent and shown read-only. Separate save flow from the
  // admin-only settings above.
  const [version, setVersion] = useState(null);
  const [vForm, setVForm] = useState(null);
  const [vSaving, setVSaving] = useState(false);
  const [vError, setVError] = useState("");
  const [vFlash, setVFlash] = useState(false);
  // Only the project owner (its own, non-linked copy) can set main/minor.
  const canEditVersion = !project?.isLink;
  // Project Info (name / id / copy-markdown), moved here from the former
  // standalone Project Info dialog. Rename dispatches so the open project's
  // header title updates immediately.
  const { state, dispatch, imageConfigured, refreshGitRemoteStatus } = useContext(AppContext);
  const [name, setName] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [copyState, setCopyState] = useState("idle"); // idle | copied | error
  // Project folder on disk (server workspace path) + its own copy affordance.
  const [folderPath, setFolderPath] = useState("");
  const [pathCopyState, setPathCopyState] = useState("idle"); // idle | copied | error
  // Version control: the global VCS profile list (id/name/provider) for the
  // picker, plus the busy/message state for the Create/Connect actions.
  const [vcsProfiles, setVcsProfiles] = useState([]);
  const [vcBusy, setVcBusy] = useState(false);
  const [vcMsg, setVcMsg] = useState("");
  // App icon: owner-editable (like name/version), not admin-gated. `hasIcon`
  // mirrors whether a .vca-icon.png master exists; `iconTs` cache-busts the
  // preview <img> after a change. A linked copy can't edit the source's icon.
  const canEditIcon = !project?.isLink;
  const [hasIcon, setHasIcon] = useState(false);
  const [iconTs, setIconTs] = useState(0);
  const [iconGenOpen, setIconGenOpen] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  // Read-only project app type ("node" full-stack | "web" client-side),
  // stamped at creation from the template. Gates the web-export option.
  const [appType, setAppType] = useState("node");

  const reload = useCallback(async () => {
    if (!projectId) return;
    setError("");
    setLoading(true);
    try {
      const [current, ver, vcs] = await Promise.all([
        api(`/projects/${encodeURIComponent(projectId)}/settings?userId=${encodeURIComponent(userId)}`).catch(() => null),
        api(`/projects/${encodeURIComponent(projectId)}/version?userId=${encodeURIComponent(userId)}`).catch(() => null),
        api(`/vcs-profiles`).catch(() => null),
      ]);
      setCost((current && current.cost) || (project && project.cost) || null);
      setFolderPath((current && current.workspacePath) || "");
      setVersion(ver || { version: null });
      setVForm(ver && ver.version ? { main: ver.main, minor: ver.minor } : null);
      setVcsProfiles(Array.isArray(vcs?.profiles) ? vcs.profiles : []);
      const base = (current && current.settings) || (project && project.settings) || null;
      if (base) {
        const snapshot = {
          deploymentOption: base.deploymentOption || "",
          vcsProfileId: base.vcsProfileId || "",
          repoUrl: base.repoUrl || "",
          vcsOverrideUsername: base.vcsOverrideUsername || "",
          vcsOverridePat: base.vcsOverridePat || "",
        };
        setForm(snapshot);
        setInitial(snapshot);
        setHasIcon(!!base.hasIcon);
        setAppType(base.appType === "web" ? "web" : "node");
      } else {
        setError(t("projectSettings.loadError") || "Failed to load settings");
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, userId, project, t]);

  useEffect(() => {
    if (open && projectId) reload();
  }, [open, projectId, reload]);

  // Seed the editable name from the live project name whenever the dialog opens.
  useEffect(() => {
    if (open) setName(state.currentProjectName || "");
  }, [open, state.currentProjectName]);

  // Seed icon presence from the cached project so the preview doesn't flash the
  // placeholder before reload() confirms it.
  useEffect(() => {
    if (open) setHasIcon(!!project?.settings?.hasIcon);
  }, [open, project]);

  // Reset on close so the next open re-fetches fresh values.
  useEffect(() => {
    if (!open) {
      setForm(null);
      setInitial(null);
      setError("");
      setSavedFlash(false);
      setCost(null);
      setVersion(null);
      setVForm(null);
      setVError("");
      setVFlash(false);
      setVcMsg("");
      setVcBusy(false);
      setCopyState("idle");
      setFolderPath("");
      setPathCopyState("idle");
      setIconGenOpen(false);
      setIconBusy(false);
      setAppType("node");
    }
  }, [open]);

  const dirty = useMemo(() => {
    if (!form || !initial) return false;
    return (form.deploymentOption || "") !== (initial.deploymentOption || "")
      || (form.vcsProfileId || "") !== (initial.vcsProfileId || "")
      || (form.repoUrl || "") !== (initial.repoUrl || "")
      || (form.vcsOverrideUsername || "") !== (initial.vcsOverrideUsername || "")
      || (form.vcsOverridePat || "") !== (initial.vcsOverridePat || "");
  }, [form, initial]);

  const vDirty = Boolean(vForm && version && version.version
    && (Number(vForm.main) !== version.main || Number(vForm.minor) !== version.minor));
  const vInvalid = Boolean(vForm && (
    !Number.isInteger(Number(vForm.main)) || Number(vForm.main) < 0
    || !Number.isInteger(Number(vForm.minor)) || Number(vForm.minor) < 0));

  const handleSave = async () => {
    if (!form || !isAdmin || saving) return;
    setSaving(true);
    setError("");
    setSavedFlash(false);
    try {
      const body = {
        userId,
        deploymentOption: form.deploymentOption || "",
        vcsProfileId: form.vcsProfileId || "",
        repoUrl: form.repoUrl || "",
        vcsOverrideUsername: form.vcsOverrideUsername || "",
        vcsOverridePat: form.vcsOverridePat ?? "",
      };
      const res = await api(`/projects/${encodeURIComponent(projectId)}/settings`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const saved = res?.settings;
      if (saved) {
        // Round-trip the canonical server values so disk and form agree,
        // and refresh the parent's cached project list so the Deploy dialog
        // (and anything else reading project.settings) sees the new values
        // without a page reload.
        const snapshot = {
          deploymentOption: saved.deploymentOption || "",
          vcsProfileId: saved.vcsProfileId || "",
          repoUrl: saved.repoUrl || "",
          vcsOverrideUsername: saved.vcsOverrideUsername || "",
          vcsOverridePat: saved.vcsOverridePat || "",
        };
        setForm(snapshot);
        setInitial(snapshot);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
        onSaved && onSaved();
      }
    } catch (err) {
      const msg = (err && err.body && Array.isArray(err.body.errors) && err.body.errors.join("; "))
        || (err && err.message)
        || t("projectSettings.saveError") || "Save failed";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleVersionSave = async () => {
    if (!vForm || !canEditVersion || vSaving || vDirty === false || vInvalid) return;
    setVSaving(true);
    setVError("");
    setVFlash(false);
    try {
      const res = await api(`/projects/${encodeURIComponent(projectId)}/version`, {
        method: "PATCH",
        body: JSON.stringify({ userId, main: Number(vForm.main), minor: Number(vForm.minor) }),
      });
      if (res && res.version) {
        setVersion(res);
        setVForm({ main: res.main, minor: res.minor });
        setVFlash(true);
        setTimeout(() => setVFlash(false), 2000);
        onSaved && onSaved();
      }
    } catch (err) {
      setVError((err && err.message) || t("projectSettings.saveError") || "Save failed");
    } finally {
      setVSaving(false);
    }
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === state.currentProjectName || nameSaving) return;
    setNameSaving(true);
    try {
      await api(`/projects/${encodeURIComponent(state.currentProjectId)}`, {
        method: "PATCH",
        body: JSON.stringify({ userId, name: trimmed }),
      });
      dispatch({ type: "RENAME_PROJECT", id: state.currentProjectId, name: trimmed });
      onSaved && onSaved();
    } catch (err) {
      console.error("Rename failed:", err);
    } finally {
      setNameSaving(false);
    }
  };

  const copyMarkdown = async () => {
    const md = buildProjectMarkdown({
      projectName: state.currentProjectName,
      projectId: state.currentProjectId,
      appType,
      t,
    });
    try {
      await navigator.clipboard.writeText(md);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 2500);
    }
  };

  const copyFolderPath = async () => {
    if (!folderPath) return;
    try {
      await navigator.clipboard.writeText(folderPath);
      setPathCopyState("copied");
      setTimeout(() => setPathCopyState("idle"), 1500);
    } catch {
      setPathCopyState("error");
      setTimeout(() => setPathCopyState("idle"), 2500);
    }
  };

  const removeIcon = async () => {
    if (iconBusy) return;
    setIconBusy(true);
    setError("");
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/icon`, {
        method: "DELETE",
        body: JSON.stringify({ userId }),
      });
      setHasIcon(false);
      setIconTs(Date.now());
      onSaved && onSaved();
    } catch (err) {
      setError((err && err.message) || t("projectSettings.appIconRemoveError") || "Failed to remove icon");
    } finally {
      setIconBusy(false);
    }
  };

  // Called by the generator dialog after it PUTs a new icon.
  const handleIconSaved = () => {
    setHasIcon(true);
    setIconTs(Date.now());
    onSaved && onSaved();
  };

  // Save the current VC settings to disk, then create or connect the remote
  // (the server resolves the profile + override from disk). endpoint is
  // "git-remote/create" or "git-remote/connect".
  const runVcAction = async (endpoint) => {
    if (!form || !isAdmin || vcBusy) return;
    setVcBusy(true);
    setVcMsg("");
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          userId,
          deploymentOption: form.deploymentOption || "",
          vcsProfileId: form.vcsProfileId || "",
          repoUrl: form.repoUrl || "",
          vcsOverrideUsername: form.vcsOverrideUsername || "",
          vcsOverridePat: form.vcsOverridePat ?? "",
        }),
      });
      const r = await api(`/projects/${encodeURIComponent(projectId)}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setVcMsg((t("projectSettings.vcs.connected") || "Connected to {url}").replace("{url}", r?.remoteUrl || ""));
      if (refreshGitRemoteStatus) refreshGitRemoteStatus();
      await reload(); // pick up the persisted repo_url + redacted override PAT
    } catch (err) {
      const code = err?.code;
      const localized = code ? t(`git.createRemote.error.${code}`) : "";
      setVcMsg((localized && !localized.startsWith("git.createRemote.error."))
        ? localized
        : (err?.message || String(err)));
    } finally {
      setVcBusy(false);
    }
  };

  // ── Field renderers ─────────────────────────────────────────────────
  const labeled = (labelKey, fallback, control, hint) => (
    <label className="psd-field">
      <span className="psd-label">
        <span className="psd-label-text">{t(labelKey) || fallback}</span>
        {hint && <span className="psd-hint">{hint}</span>}
      </span>
      <span className="psd-control">{control}</span>
    </label>
  );

  const sectionTitle = (icon, labelKey, fallback) => (
    <div className="psd-section-title">{icon} {t(labelKey) || fallback}</div>
  );

  return (
    <>
    <Dialog.Root open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content modal-sticky settings-wide">
          <Dialog.Title className="modal-title">
            <Settings size={18} className="title-icon" />
            {t("projectSettings.title")}{project?.name ? ` — ${project.name}` : ""}
          </Dialog.Title>
          <div className="modal-body psd-body">
            {!isAdmin && (
              <div className="settings-readonly-banner">{t("projectSettings.readOnly") || "Read-only — admin privileges required to edit"}</div>
            )}
            {loading && <div>…</div>}
            {form && (
              <div className="psd-form">
                {/* Project Info — moved from the former standalone Project Info dialog */}
                <div className="psd-section">
                  {sectionTitle(<Info size={14} />, "projectInfo.title", "Project info")}
                  {labeled(
                    "projectInfo.name",
                    "Name",
                    <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
                      <input
                        className="psd-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveName(); }}
                        disabled={nameSaving}
                      />
                      {name.trim() && name.trim() !== (state.currentProjectName || "") && (
                        <button className="btn-primary" onClick={saveName} disabled={nameSaving} style={{ whiteSpace: "nowrap" }}>
                          <Save size={14} /> {t("projectInfo.save") || "Save"}
                        </button>
                      )}
                    </div>,
                  )}
                  {labeled(
                    "projectInfo.id",
                    "ID",
                    <input className="psd-input" value={projectId || ""} readOnly style={{ opacity: 0.7, cursor: "default" }} />,
                  )}
                  {labeled(
                    "projectInfo.appType",
                    "App type",
                    <input
                      className="psd-input"
                      value={appType === "web" ? (t("projectInfo.appType.web") || "Client-side web app") : (t("projectInfo.appType.node") || "Node web app")}
                      readOnly
                      style={{ opacity: 0.7, cursor: "default" }}
                    />,
                  )}
                  <div className="psd-field">
                    <span className="psd-control">
                      <button className="btn-secondary" onClick={copyMarkdown}>
                        <Copy size={14} /> {copyState === "copied" ? t("projectInfo.copied") : copyState === "error" ? t("projectInfo.copyFailed") : t("projectInfo.copyMarkdown")}
                      </button>
                    </span>
                  </div>
                </div>

                {/* Folder path — where this project lives on the workspace
                    storage. Its own category: read-only path + icon copy button. */}
                {folderPath && (
                  <div className="psd-section">
                    {sectionTitle(<FolderOpen size={14} />, "projectSettings.section.folderPath", "Folder path")}
                    <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
                      <input
                        className="psd-input"
                        value={folderPath}
                        readOnly
                        title={folderPath}
                        onFocus={(e) => e.target.select()}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <button
                        type="button"
                        className="icon-btn-sm"
                        onClick={copyFolderPath}
                        style={{ flexShrink: 0 }}
                        title={pathCopyState === "copied" ? (t("projectInfo.copied") || "Copied") : (t("projectSettings.copyPath") || "Copy path")}
                        aria-label={t("projectSettings.copyPath") || "Copy path"}
                      >
                        {pathCopyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                )}

                {/* App icon — its own category (was part of Project info) */}
                <div className="psd-section">
                  {sectionTitle(<ImageIcon size={14} />, "projectSettings.appIcon", "App icon")}
                  <div className="psd-section-hint">
                    {t("projectSettings.appIconHint") || "Used as the Electron installer/app icon and the website favicon on deploy."}
                  </div>
                  <div className="psd-icon-row">
                    <span className="psd-icon-preview">
                      {hasIcon
                        ? <img src={`/api/projects/${encodeURIComponent(projectId)}/icon?ts=${iconTs}`} alt="" />
                        : <ImageIcon size={22} className="psd-icon-placeholder" />}
                    </span>
                    {canEditIcon ? (
                      <div className="psd-icon-actions">
                        <button className="btn-secondary" onClick={() => setIconGenOpen(true)}>
                          <Sparkles size={14} /> {hasIcon ? (t("projectSettings.appIconChange") || "Change icon…") : (t("projectSettings.appIconCreate") || "Create icon…")}
                        </button>
                        {hasIcon && (
                          <button className="btn-secondary psd-icon-remove" onClick={removeIcon} disabled={iconBusy}>
                            <Trash2 size={14} /> {t("projectSettings.appIconRemove") || "Remove"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="psd-hint">{t("projectSettings.appIconLinked") || "Set on the source project"}</span>
                    )}
                  </div>
                </div>

                {/* Deployment */}
                <div className="psd-section">
                  {sectionTitle(<Globe size={14} />, "projectSettings.section.deployment", "Deployment")}
                  {labeled(
                    "projectSettings.deploymentOption",
                    "Deployment option",
                    <select
                      className="psd-input"
                      value={form.deploymentOption || ""}
                      onChange={(e) => setForm(f => ({ ...f, deploymentOption: e.target.value }))}
                      disabled={!isAdmin}
                    >
                      <option value="">{t("projectSettings.deploymentOption.none") || "Not configured"}</option>
                      <option value="electron">{t("projectSettings.deploymentOption.electron") || "Electron app"}</option>
                      <option value="git-tag">{t("projectSettings.deploymentOption.gitTag") || "Commit & tag to git remote"}</option>
                      {appType === "web" && (
                        <option value="web-export">{t("projectSettings.deploymentOption.webExport") || "Static web export (zip / single HTML)"}</option>
                      )}
                    </select>,
                    t("projectSettings.deploymentOption.hint") || "Used by the Deploy button. Configure shared credentials in Settings → Deployment.",
                  )}
                </div>

                {/* Version control: pick a global VCS profile, set the repo
                    URL, optionally override credentials, then Create/Connect. */}
                <div className="psd-section">
                  {sectionTitle(<GitBranch size={14} />, "projectSettings.section.vcs", "Version control")}
                  <div className="psd-section-hint">
                    {t("projectSettings.vcs.hint") || "Pick a profile (managed in Settings → Version Control), set the repository, then Create or Connect the remote."}
                  </div>
                  {labeled(
                    "projectSettings.vcs.profile",
                    "Profile",
                    <select
                      className="psd-input"
                      value={form.vcsProfileId || ""}
                      disabled={!isAdmin}
                      onChange={(e) => setForm(f => ({ ...f, vcsProfileId: e.target.value }))}
                    >
                      <option value="">{t("projectSettings.vcs.profileNone") || "None"}</option>
                      {vcsProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>,
                  )}
                  {labeled(
                    "projectSettings.vcs.repoUrl",
                    "Repository URL",
                    <input
                      type="text"
                      className="psd-input"
                      value={form.repoUrl || ""}
                      disabled={!isAdmin}
                      placeholder="https://github.com/owner/repo.git"
                      onChange={(e) => setForm(f => ({ ...f, repoUrl: e.target.value }))}
                    />,
                    t("projectSettings.vcs.repoUrlHint") || "Leave blank and use Create repository to auto-create one.",
                  )}
                  {labeled(
                    "projectSettings.vcs.overrideUsername",
                    "Override username",
                    <input
                      type="text"
                      className="psd-input"
                      value={form.vcsOverrideUsername || ""}
                      disabled={!isAdmin}
                      autoComplete="off"
                      onChange={(e) => setForm(f => ({ ...f, vcsOverrideUsername: e.target.value }))}
                    />,
                    t("projectSettings.vcs.overrideHint") || "Optional — overrides the profile's credentials for this project.",
                  )}
                  {labeled(
                    "projectSettings.vcs.overridePat",
                    "Override password / PAT",
                    <input
                      type="password"
                      className="psd-input"
                      value={form.vcsOverridePat || ""}
                      disabled={!isAdmin}
                      autoComplete="new-password"
                      placeholder={form.vcsOverridePat === AUTH_SECRET_SENTINEL ? (t("projectSettings.vcs.overridePatPlaceholder") || "leave unchanged") : ""}
                      onFocus={() => { if (form.vcsOverridePat === AUTH_SECRET_SENTINEL) setForm(f => ({ ...f, vcsOverridePat: "" })); }}
                      onChange={(e) => setForm(f => ({ ...f, vcsOverridePat: e.target.value }))}
                    />,
                  )}
                  {isAdmin && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <button type="button" className="btn-secondary" disabled={vcBusy || !form.vcsProfileId} onClick={() => runVcAction("git-remote/create")}>
                        <Plus size={14} /> {t("projectSettings.vcs.createRepo") || "Create repository"}
                      </button>
                      <button type="button" className="btn-secondary" disabled={vcBusy || !form.repoUrl || !form.vcsProfileId} onClick={() => runVcAction("git-remote/connect")}>
                        <Link size={14} /> {t("projectSettings.vcs.connect") || "Connect"}
                      </button>
                    </div>
                  )}
                  {vcMsg && <div className="psd-section-hint" style={{ marginTop: 4 }}>{vcMsg}</div>}
                </div>

                {/* Version (main.minor.build). Owner sets main/minor; build is
                    auto-bumped by the agent on every change. Own save flow. */}
                <div className="psd-section">
                  {sectionTitle(<Tag size={14} />, "projectSettings.section.version", "Version")}
                  {version && !version.version && (
                    <div className="psd-section-hint">
                      {t("projectSettings.versionUnavailable") || "This app has no package.json, so it isn't versioned."}
                    </div>
                  )}
                  {version && version.version && vForm && (
                    <>
                      <div className="psd-section-hint">
                        {t("projectSettings.versionHint") || "main.minor.build — you set main & minor; the build number auto-increments on every change."}
                      </div>
                      {labeled(
                        "projectSettings.versionMain",
                        "Main version",
                        <input
                          type="number"
                          className="psd-input psd-input-short"
                          min={0}
                          value={vForm.main}
                          onChange={(e) => setVForm(f => ({ ...f, main: e.target.value === "" ? "" : Number(e.target.value) }))}
                          disabled={!canEditVersion || vSaving}
                        />,
                      )}
                      {labeled(
                        "projectSettings.versionMinor",
                        "Minor version",
                        <input
                          type="number"
                          className="psd-input psd-input-short"
                          min={0}
                          value={vForm.minor}
                          onChange={(e) => setVForm(f => ({ ...f, minor: e.target.value === "" ? "" : Number(e.target.value) }))}
                          disabled={!canEditVersion || vSaving}
                        />,
                      )}
                      {labeled(
                        "projectSettings.versionBuild",
                        "Build (auto)",
                        <span className="psd-static">{version.build}</span>,
                      )}
                      {labeled(
                        "projectSettings.versionCurrent",
                        "Current version",
                        <span className="psd-static">{version.version}</span>,
                      )}
                      {vInvalid && (
                        <div className="psd-error">{t("projectSettings.versionInvalid") || "Main and minor must be non-negative integers"}</div>
                      )}
                      {vError && <div className="psd-error">{vError}</div>}
                      {canEditVersion && (
                        <div className="psd-actions-inline">
                          {vFlash && <span className="psd-saved-flash"><CircleCheck size={14} /> {t("common.saved") || "Saved"}</span>}
                          <button
                            className="btn-primary"
                            onClick={handleVersionSave}
                            disabled={!vDirty || vSaving || vInvalid}
                          >
                            <Save size={14} /> {vSaving ? (t("common.saving") || "Saving…") : (t("projectSettings.versionSave") || "Save version")}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Usage (read-only monitoring — not part of the form/save flow) */}
                <div className="psd-section">
                  {sectionTitle(<Coins size={14} />, "projectSettings.section.usage", "Usage")}
                  {labeled(
                    "projectSettings.llmSpend",
                    "LLM spend",
                    <span className="psd-static">{formatProjectCost(cost?.totalUsd) || "$0.00"}</span>,
                    t("projectSettings.llmSpendHint"),
                  )}
                </div>
              </div>
            )}
            {error && <div className="psd-error">{error}</div>}
          </div>
          <div className="modal-actions wrap psd-actions">
            <div className="psd-status">
              {savedFlash && <span className="psd-saved-flash"><CircleCheck size={14} /> {t("common.saved") || "Saved"}</span>}
              {dirty && !savedFlash && <span className="psd-dirty">{t("projectSettings.unsaved") || "Unsaved changes"}</span>}
            </div>
            <button className="btn-secondary" onClick={() => onOpenChange(false)} disabled={saving}>
              {isAdmin ? (t("common.close") || "Close") : (t("projectSettings.close") || "Close")}
            </button>
            {isAdmin && (
              <button
                className="btn-primary"
                onClick={handleSave}
                disabled={!dirty || saving || loading}
              >
                <Save size={14} /> {saving ? (t("common.saving") || "Saving…") : (t("projectSettings.save") || "Save")}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {canEditIcon && (
      <IconGeneratorDialog
        open={iconGenOpen}
        onOpenChange={setIconGenOpen}
        projectId={projectId}
        userId={userId}
        currentHasIcon={hasIcon}
        iconTs={iconTs}
        imageConfigured={imageConfigured}
        onSaved={handleIconSaved}
        t={t}
      />
    )}
    </>
  );
}

// Create or edit a project's app icon from a text prompt (reusing the image
// proxy) or an uploaded image, preview it, and set it. Generation is gated on an
// image provider being configured; upload always works.
function IconGeneratorDialog({ open, onOpenChange, projectId, userId, currentHasIcon, iconTs, imageConfigured, onSaved, t }) {
  const [prompt, setPrompt] = useState("");
  const [candidate, setCandidate] = useState(null); // normalized square PNG data URL, or null
  const [loading, setLoading] = useState(false);     // generating
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  // Reset when closed.
  useEffect(() => {
    if (!open) { setPrompt(""); setCandidate(null); setError(""); setLoading(false); setSaving(false); }
  }, [open]);

  // On open, preload the existing icon as the edit base + initial preview.
  useEffect(() => {
    if (!open || !currentHasIcon) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/icon?ts=${iconTs}`);
        if (!r.ok) return;
        const blob = await r.blob();
        const reader = new FileReader();
        reader.onload = () => { if (!cancelled) setCandidate(reader.result); };
        reader.readAsDataURL(blob);
      } catch { /* ignore — user can still generate/upload */ }
    })();
    return () => { cancelled = true; };
  }, [open, currentHasIcon, projectId, iconTs]);

  const generate = async () => {
    const p = prompt.trim();
    if (!p || !imageConfigured || loading) return;
    setLoading(true);
    setError("");
    try {
      // Edit the current candidate when present; otherwise create from a blank
      // square. The proxy requires a base image either way.
      const base = candidate || blankIconDataUrl();
      const fullPrompt = `${p}. Design as a clean, modern application icon: a single clear subject, centered, simple background, square composition.`;
      const res = await api("/image/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: fullPrompt, imageDataUrl: base }),
      });
      if (!res?.dataUrl) throw new Error(t("iconGenerator.noImage") || "No image returned");
      setCandidate(await normalizeIconDataUrl(res.dataUrl));
    } catch (err) {
      setError((err && err.message) || t("iconGenerator.genError") || "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  const onPickFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try { setCandidate(await normalizeIconDataUrl(reader.result)); setError(""); }
      catch { setError(t("iconGenerator.loadError") || "Could not load that image"); }
    };
    reader.onerror = () => setError(t("iconGenerator.loadError") || "Could not load that image");
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!candidate || saving) return;
    setSaving(true);
    setError("");
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/icon`, {
        method: "PUT",
        body: JSON.stringify({ userId, dataUrl: candidate }),
      });
      onSaved && onSaved();
      onOpenChange(false);
    } catch (err) {
      setError((err && err.message) || t("iconGenerator.saveError") || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!loading && !saving) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content icon-gen-content">
          <Dialog.Title className="modal-title">
            <Sparkles size={18} className="title-icon" />
            {t("iconGenerator.title") || "App icon"}
          </Dialog.Title>
          <div className="modal-body icon-gen-body">
            <div className="icon-gen-preview">
              {candidate
                ? <img src={candidate} alt={t("iconGenerator.previewAlt") || "Icon preview"} />
                : <span className="icon-gen-placeholder"><ImageIcon size={40} /></span>}
              {loading && <span className="icon-gen-spinner"><Loader size={22} className="spin" /></span>}
            </div>
            <div className="icon-gen-controls">
              <label className="icon-gen-label">{t("iconGenerator.promptLabel") || "Describe the icon"}</label>
              <textarea
                className="psd-input icon-gen-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("iconGenerator.promptPlaceholder") || "e.g. a friendly robot reading a book, flat style, blue"}
                disabled={!imageConfigured || loading}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate(); }}
              />
              <div className="icon-gen-actions">
                <button
                  className="btn-primary"
                  onClick={generate}
                  disabled={!imageConfigured || loading || !prompt.trim()}
                  title={!imageConfigured ? (t("iconGenerator.notConfigured") || "Configure an image provider in Settings to generate") : undefined}
                >
                  {loading ? <Loader size={14} className="spin" /> : <Sparkles size={14} />}
                  {" "}
                  {loading
                    ? (t("iconGenerator.generating") || "Generating…")
                    : candidate
                      ? (t("iconGenerator.regenerate") || "Edit with AI")
                      : (t("iconGenerator.generate") || "Generate")}
                </button>
                <button className="btn-secondary" onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={loading}>
                  <ArrowUpFromLine size={14} /> {t("iconGenerator.upload") || "Upload"}
                </button>
                <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={onPickFile} style={{ display: "none" }} />
              </div>
              {!imageConfigured && (
                <div className="icon-gen-hint">{t("iconGenerator.notConfigured") || "Configure an image provider in Settings to generate. You can still upload an image."}</div>
              )}
              {error && <div className="psd-error">{error}</div>}
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => onOpenChange(false)} disabled={loading || saving}>
              {t("common.cancel") || "Cancel"}
            </button>
            <button className="btn-primary" onClick={save} disabled={!candidate || saving || loading}>
              <Save size={14} /> {saving ? (t("common.saving") || "Saving…") : (t("iconGenerator.save") || "Set icon")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GroupsAccessDialog({ open, onOpenChange, embedded = false }) {
  const { t } = useContext(AppContext);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailGroup, setDetailGroup] = useState(null); // full group object when open
  const [confirmDelete, setConfirmDelete] = useState(null); // group summary or null
  const [showCreate, setShowCreate] = useState(false);
  const [createKind, setCreateKind] = useState("users");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [linkPermissionError, setLinkPermissionError] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberDisplayName, setMemberDisplayName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [toast, setToast] = useState("");

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api("/admin/vca-groups");
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open || embedded) {
      reload();
      setDetailGroup(null);
      setShowCreate(false);
      setCreateName("");
      setCreateDescription("");
      setCreateKind("users");
      setToast("");
    }
  }, [open, embedded]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? "" : t)), 4000);
  };

  const refreshDetail = async (groupId) => {
    try {
      const data = await api(`/admin/vca-groups/${encodeURIComponent(groupId)}`);
      setDetailGroup(data?.group || null);
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const createGroup = async () => {
    const name = createName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      await api("/admin/vca-groups", { method: "POST", body: JSON.stringify({ kind: createKind, name, description: createDescription.trim() }) });
      setShowCreate(false);
      setCreateName("");
      setCreateDescription("");
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteGroup = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await api(`/admin/vca-groups/${encodeURIComponent(confirmDelete.id)}`, { method: "DELETE" });
      setConfirmDelete(null);
      if (detailGroup?.id === confirmDelete.id) setDetailGroup(null);
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
      setConfirmDelete(null);
    } finally {
      setBusy(false);
    }
  };

  const runSync = async (groupId) => {
    setBusy(true);
    try {
      const data = await api(`/admin/vca-groups/${encodeURIComponent(groupId)}/sync`, { method: "POST" });
      showToast(t("groups.syncOk", { added: data?.added ?? 0, removed: data?.removed ?? 0, kept: data?.kept ?? 0 }));
      if (data?.group) setDetailGroup(data.group);
      await reload();
    } catch (err) {
      showToast(t("groups.syncFailed", { error: err?.message || String(err) }));
      if (detailGroup) await refreshDetail(detailGroup.id);
    } finally {
      setBusy(false);
    }
  };

  const unlinkGroup = async (groupId, mode) => {
    setBusy(true);
    try {
      await api(`/admin/vca-groups/${encodeURIComponent(groupId)}/unlink`, { method: "POST", body: JSON.stringify({ mode }) });
      await reload();
      if (detailGroup?.id === groupId) await refreshDetail(groupId);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const linkGroup = async (graphGroupId, graphGroupName) => {
    if (!detailGroup) return;
    setBusy(true);
    try {
      const data = await api(`/admin/vca-groups/${encodeURIComponent(detailGroup.id)}/link`, {
        method: "POST",
        body: JSON.stringify({ graphGroupId, graphGroupName }),
      });
      if (data?.group) setDetailGroup(data.group);
      if (data?.sync?.ok) {
        showToast(t("groups.syncOk", { added: data.sync.added, removed: data.sync.removed, kept: data.sync.kept }));
      } else if (data?.sync && !data.sync.ok) {
        showToast(t("groups.syncFailed", { error: data.sync.error || "" }));
      }
      setLinkPickerOpen(false);
      setLinkQuery("");
      setLinkResults([]);
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const runLinkSearch = async (q) => {
    setLinkQuery(q);
    if (q.trim().length < 2) {
      setLinkResults([]);
      return;
    }
    setLinkSearching(true);
    setLinkPermissionError("");
    try {
      const data = await api(`/admin/graph-groups/search?q=${encodeURIComponent(q)}&limit=15`);
      setLinkResults(Array.isArray(data?.groups) ? data.groups : []);
    } catch (err) {
      if (err && err.code === "GRAPH_INSUFFICIENT_PERMISSIONS") {
        setLinkPermissionError(err.body?.requiredRole || "GroupMember.Read.All");
      } else {
        setError(err?.message || String(err));
      }
      setLinkResults([]);
    } finally {
      setLinkSearching(false);
    }
  };

  const addMember = async () => {
    if (!detailGroup || !memberUserId.trim()) return;
    setBusy(true);
    try {
      await api(`/admin/vca-groups/${encodeURIComponent(detailGroup.id)}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: memberUserId.trim(), displayName: memberDisplayName.trim(), email: memberEmail.trim() }),
      });
      setMemberUserId("");
      setMemberDisplayName("");
      setMemberEmail("");
      await refreshDetail(detailGroup.id);
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId) => {
    if (!detailGroup) return;
    setBusy(true);
    try {
      await api(`/admin/vca-groups/${encodeURIComponent(detailGroup.id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
      await refreshDetail(detailGroup.id);
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogOrPanel
        embedded={embedded}
        open={open}
        onOpenChange={onOpenChange}
        title={t("groups.title")}
        titleIcon={<Users size={embedded ? 14 : 18} className={embedded ? "" : "title-icon"} />}
        maxWidth={720}
        sticky
      >
        {error && <div style={{ color: "#dc2626", fontSize: 12, marginBottom: 8 }}>{error}</div>}
        {toast && <div style={{ background: "var(--surface-subtle)", padding: "6px 10px", borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{toast}</div>}
        {!detailGroup ? (
              <>
                {loading ? (
                  <div style={{ padding: 20, color: "var(--text-muted)" }}>{t("common.loading")}</div>
                ) : groups.length === 0 ? (
                  <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 13 }}>{t("groups.empty")}</div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 11 }}>
                        <th style={{ padding: "4px 6px" }}>{t("groups.col.name")}</th>
                        <th style={{ padding: "4px 6px" }}>{t("groups.col.kind")}</th>
                        <th style={{ padding: "4px 6px" }}>{t("groups.col.linkedTo")}</th>
                        <th style={{ padding: "4px 6px", textAlign: "right" }}>{t("groups.col.members")}</th>
                        <th style={{ padding: "4px 6px" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.id} style={{ borderTop: "1px solid var(--border)" }}>
                          <td style={{ padding: "6px" }}>{g.name}</td>
                          <td style={{ padding: "6px" }}>
                            <span className="mcp-server-badge">{t(`groups.kind.${g.kind}`)}</span>
                          </td>
                          <td style={{ padding: "6px", color: "var(--text-muted)" }}>
                            {g.linkedGraphGroupId ? (
                              <span><Link2 size={11} /> {g.linkedGraphGroupName || g.linkedGraphGroupId}</span>
                            ) : "—"}
                          </td>
                          <td style={{ padding: "6px", textAlign: "right" }}>{g.memberCount}</td>
                          <td style={{ padding: "6px", textAlign: "right" }}>
                            <button className="btn-secondary" style={{ padding: "2px 8px" }} onClick={async () => { await refreshDetail(g.id); }}>
                              {t("groups.openDetail")}
                            </button>
                            {g.linkedGraphGroupId && (
                              <button className="btn-secondary" style={{ padding: "2px 8px", marginLeft: 4 }} disabled={busy} onClick={() => runSync(g.id)}>
                                <RefreshCw size={11} /> {t("groups.syncNow")}
                              </button>
                            )}
                            <button className="btn-danger" style={{ padding: "2px 8px", marginLeft: 4 }} disabled={busy} onClick={() => setConfirmDelete(g)}>
                              <Trash2 size={11} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div style={{ marginTop: 12 }}>
                  {!showCreate ? (
                    <button className="btn-primary" onClick={() => setShowCreate(true)}>
                      <Plus size={14} /> {t("groups.create")}
                    </button>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <select className="modal-input" value={createKind} onChange={(e) => setCreateKind(e.target.value)} style={{ width: 140 }}>
                          <option value="users">{t("groups.kind.users")}</option>
                          <option value="admin">{t("groups.kind.admin")}</option>
                        </select>
                        <input
                          className="modal-input"
                          placeholder={t("groups.create.namePlaceholder")}
                          value={createName}
                          onChange={(e) => setCreateName(e.target.value)}
                        />
                      </div>
                      <input
                        className="modal-input"
                        placeholder={t("groups.create.descriptionPlaceholder")}
                        value={createDescription}
                        onChange={(e) => setCreateDescription(e.target.value)}
                      />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn-primary" disabled={busy || !createName.trim()} onClick={createGroup}>
                          <Check size={14} /> {t("common.save")}
                        </button>
                        <button className="btn-secondary" onClick={() => setShowCreate(false)}>
                          <X size={14} /> {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <button className="btn-secondary" onClick={() => setDetailGroup(null)}>
                    <ChevronLeft size={14} /> {t("common.back")}
                  </button>
                  <span className="mcp-server-badge">{t(`groups.kind.${detailGroup.kind}`)}</span>
                </div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{detailGroup.name}</div>
                {detailGroup.description && (
                  <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>{detailGroup.description}</div>
                )}

                <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("groups.linkedTo")}</div>
                  {detailGroup.linkedGraphGroupId ? (
                    <>
                      <div style={{ marginTop: 4 }}>
                        <Link2 size={12} /> {detailGroup.linkedGraphGroupName || detailGroup.linkedGraphGroupId}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                        {detailGroup.lastSyncedAt ? (
                          t("groups.lastSyncedAt", { when: new Date(detailGroup.lastSyncedAt).toLocaleString(), status: detailGroup.lastSyncStatus || "—" })
                        ) : t("groups.notSynced")}
                        {detailGroup.lastSyncError && (
                          <div style={{ color: "#dc2626", marginTop: 2 }}>{detailGroup.lastSyncError}</div>
                        )}
                      </div>
                      <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                        <button className="btn-secondary" disabled={busy} onClick={() => runSync(detailGroup.id)}>
                          <RefreshCw size={12} /> {t("groups.syncNow")}
                        </button>
                        <button className="btn-secondary" disabled={busy} onClick={() => unlinkGroup(detailGroup.id, "keep")}>
                          <Link2Off size={12} /> {t("groups.unlink.keepMembers")}
                        </button>
                        <button className="btn-danger" disabled={busy} onClick={() => unlinkGroup(detailGroup.id, "drop")}>
                          <Link2Off size={12} /> {t("groups.unlink.dropMembers")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={{ marginTop: 4 }}>
                      <button className="btn-secondary" onClick={() => { setLinkPickerOpen(true); setLinkQuery(""); setLinkResults([]); setLinkPermissionError(""); }}>
                        <Link2 size={12} /> {t("groups.link.title")}
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600 }}>{t("groups.members.title")} ({detailGroup.members.length})</div>
                <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, marginTop: 4 }}>
                  {detailGroup.members.length === 0 ? (
                    <div style={{ padding: 8, color: "var(--text-muted)", fontSize: 12 }}>{t("groups.members.empty")}</div>
                  ) : (
                    detailGroup.members.map((m) => (
                      <div key={m.userId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", borderTop: "1px solid var(--border)", fontSize: 12 }}>
                        <div>
                          <div>{m.displayName || m.userId}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{m.email || m.userId}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span className="mcp-server-badge mcp-server-badge-muted">{m.source}</span>
                          {!detailGroup.linkedGraphGroupId && (
                            <button className="btn-danger" style={{ padding: "2px 6px" }} disabled={busy} onClick={() => removeMember(m.userId)}>
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {!detailGroup.linkedGraphGroupId && (
                  <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{t("groups.members.add")}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                      <input className="modal-input" placeholder={t("groups.members.userId")} value={memberUserId} onChange={(e) => setMemberUserId(e.target.value)} />
                      <input className="modal-input" placeholder={t("groups.members.displayName")} value={memberDisplayName} onChange={(e) => setMemberDisplayName(e.target.value)} />
                      <input className="modal-input" placeholder={t("groups.members.email")} value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} />
                      <div>
                        <button className="btn-primary" disabled={busy || !memberUserId.trim()} onClick={addMember}>
                          <Plus size={12} /> {t("groups.members.add")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

      </DialogOrPanel>

      {/* Delete confirmation */}
      <Dialog.Root open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="alert-overlay" />
          <Dialog.Content className="alert-content">
            <Dialog.Title className="alert-title">
              <AlertTriangle size={18} className="title-icon-danger" />
              {t("groups.delete.title")}
            </Dialog.Title>
            <div className="alert-description">
              {t("groups.delete.message", { name: confirmDelete?.name || "" })}
            </div>
            <div className="modal-actions wrap">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</button>
              <button className="btn-danger" disabled={busy} onClick={deleteGroup}>
                <Trash2 size={14} /> {t("groups.delete.confirm")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Link picker */}
      <Dialog.Root open={linkPickerOpen} onOpenChange={(o) => { if (!o) { setLinkPickerOpen(false); setLinkResults([]); setLinkQuery(""); } }}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content">
            <Dialog.Title className="modal-title">
              <Link2 size={16} className="title-icon" /> {t("groups.link.title")}
            </Dialog.Title>
            {linkPermissionError && (
              <div style={{ background: "var(--surface-subtle)", padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>
                <AlertTriangle size={12} /> {t("groups.link.permissionRequired", { role: linkPermissionError })}
              </div>
            )}
            <input
              className="modal-input"
              placeholder={t("groups.link.searchPlaceholder")}
              value={linkQuery}
              onChange={(e) => runLinkSearch(e.target.value)}
              autoFocus
            />
            <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
              {linkSearching ? (
                <div style={{ padding: 8, color: "var(--text-muted)", fontSize: 12 }}>{t("common.loading")}</div>
              ) : linkResults.length === 0 ? (
                <div style={{ padding: 8, color: "var(--text-muted)", fontSize: 12 }}>{t("groups.link.noResults")}</div>
              ) : (
                linkResults.map((g) => (
                  <div key={g.id} style={{ padding: "6px 8px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                    <div>
                      <div>{g.displayName}</div>
                      {g.description && <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{g.description}</div>}
                      <div style={{ color: "var(--text-muted)", fontSize: 10, fontFamily: "monospace" }}>{g.id}</div>
                    </div>
                    <button className="btn-primary" disabled={busy} onClick={() => linkGroup(g.id, g.displayName)}>
                      <Check size={11} /> {t("groups.link.confirm")}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setLinkPickerOpen(false)}>
                <X size={14} /> {t("common.cancel")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function UsersAdminDialog({ open, onOpenChange, oauthEnabled, embedded = false }) {
  const { t, userId: sessionUserId } = useContext(AppContext);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createAuthType, setCreateAuthType] = useState("local");
  const [cUsername, setCUsername] = useState("");
  const [cFirstName, setCFirstName] = useState("");
  const [cLastName, setCLastName] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [cPassword, setCPassword] = useState("");
  const [cEntraOid, setCEntraOid] = useState("");
  const [createError, setCreateError] = useState("");

  // Edit + delete + password reset state
  const [editing, setEditing] = useState(null);
  const [eUsername, setEUsername] = useState("");
  const [eFirstName, setEFirstName] = useState("");
  const [eLastName, setELastName] = useState("");
  const [eEmail, setEEmail] = useState("");
  const [editError, setEditError] = useState("");
  const [pwTarget, setPwTarget] = useState(null);
  const [pwNew, setPwNew] = useState("");
  const [pwError, setPwError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleteHasProjects, setDeleteHasProjects] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api("/admin/users");
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open || embedded) {
      reload();
      setShowCreate(false);
      setEditing(null);
      setPwTarget(null);
      setConfirmDelete(null);
      setCreateError("");
      setEditError("");
      setPwError("");
    }
  }, [open, embedded]);

  const resetCreate = () => {
    setCreateAuthType(oauthEnabled ? "local" : "local");
    setCUsername(""); setCFirstName(""); setCLastName(""); setCEmail("");
    setCPassword(""); setCEntraOid(""); setCreateError("");
  };

  const doCreate = async () => {
    setBusy(true);
    setCreateError("");
    try {
      const body = createAuthType === "local"
        ? { authType: "local", username: cUsername, firstName: cFirstName, lastName: cLastName, email: cEmail, password: cPassword }
        : { authType: "entra", entraOid: cEntraOid, username: cUsername, firstName: cFirstName, lastName: cLastName, email: cEmail };
      await api("/admin/users", { method: "POST", body: JSON.stringify(body) });
      setShowCreate(false);
      resetCreate();
      await reload();
    } catch (err) {
      setCreateError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (u) => {
    setEditing(u);
    setEUsername(u.username || "");
    setEFirstName(u.firstName || "");
    setELastName(u.lastName || "");
    setEEmail(u.email || "");
    setEditError("");
  };

  const doSaveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    setEditError("");
    try {
      await api(`/admin/users/${encodeURIComponent(editing.userId)}`, {
        method: "PUT",
        body: JSON.stringify({ username: eUsername, firstName: eFirstName, lastName: eLastName, email: eEmail }),
      });
      setEditing(null);
      await reload();
    } catch (err) {
      setEditError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const doResetPassword = async () => {
    if (!pwTarget) return;
    setBusy(true);
    setPwError("");
    try {
      await api(`/admin/users/${encodeURIComponent(pwTarget.userId)}/password`, {
        method: "POST",
        body: JSON.stringify({ password: pwNew }),
      });
      setPwTarget(null);
      setPwNew("");
    } catch (err) {
      setPwError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (force) => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      const qs = force ? "?force=1" : "";
      await api(`/admin/users/${encodeURIComponent(confirmDelete.userId)}${qs}`, { method: "DELETE" });
      setConfirmDelete(null);
      setDeleteHasProjects(false);
      await reload();
    } catch (err) {
      if (err?.code === "HAS_PROJECTS") {
        setDeleteHasProjects(true);
      } else {
        setError(err?.message || String(err));
        setConfirmDelete(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogOrPanel
      embedded={embedded}
      open={open}
      onOpenChange={onOpenChange}
      title={t("users.dialog.title") || "User management"}
      titleIcon={<Users size={embedded ? 14 : 20} className={embedded ? "" : "title-icon"} />}
      maxWidth={960}
    >
      {error && <div style={{ color: "#dc2626", fontSize: 12, marginBottom: 8 }}>{error}</div>}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {loading ? "…" : `${users.length} user${users.length === 1 ? "" : "s"}`}
            </div>
            <button className="btn-primary" disabled={busy} onClick={() => { resetCreate(); setShowCreate(true); }}>
              <Plus size={14} /> {t("users.dialog.create") || "Create user"}
            </button>
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ background: "var(--bg-tertiary)" }}>
                <tr>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>{t("users.dialog.field.username") || "Username"}</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>{t("users.dialog.col.displayName") || "Name"}</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>{t("users.dialog.col.authType") || "Type"}</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>{t("users.dialog.field.email") || "Email"}</th>
                  <th style={{ textAlign: "right", padding: "6px 8px" }}>{t("users.dialog.col.actions") || "Actions"}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.userId} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{u.username}</td>
                    <td style={{ padding: "6px 8px" }}>{u.displayName}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <span className="skill-badge" style={{ background: u.authType === "local" ? "#dbeafe" : "#dcfce7", color: u.authType === "local" ? "#1e40af" : "#166534" }}>
                        {u.authType}
                      </span>
                    </td>
                    <td style={{ padding: "6px 8px", color: "var(--text-muted)" }}>{u.email || "—"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn-icon" title={t("common.edit") || "Edit"} onClick={() => openEdit(u)} disabled={busy}>
                        <Pencil size={12} />
                      </button>
                      {u.authType === "local" && (
                        <button className="btn-icon" title={t("users.dialog.resetPassword") || "Reset password"} onClick={() => { setPwTarget(u); setPwNew(""); setPwError(""); }} disabled={busy}>
                          <Key size={12} />
                        </button>
                      )}
                      <button className="btn-icon" title={t("common.delete") || "Delete"} onClick={() => { setConfirmDelete(u); setDeleteHasProjects(false); }} disabled={busy || u.userId === sessionUserId}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!loading && users.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>—</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="modal-buttons" style={{ marginTop: 12 }}>
            <button onClick={() => onOpenChange(false)} className="btn-secondary">
              <X size={14} /> {t("common.close") || "Close"}
            </button>
          </div>

          {/* Create dialog */}
          <Dialog.Root open={showCreate} onOpenChange={setShowCreate}>
            <Dialog.Portal>
              <Dialog.Overlay className="modal-overlay" />
              <Dialog.Content className="modal-content">
                <Dialog.Title className="modal-title">
                  <Plus size={18} className="title-icon" /> {t("users.dialog.create") || "Create user"}
                </Dialog.Title>
                <label className="modal-label">
                  {t("users.dialog.field.authType") || "Account type"}
                  <select className="modal-input" value={createAuthType} onChange={(e) => setCreateAuthType(e.target.value)} disabled={busy}>
                    <option value="local">{t("users.dialog.authType.local") || "Local (username + password)"}</option>
                    {oauthEnabled && <option value="entra">{t("users.dialog.authType.entra") || "Microsoft Entra ID"}</option>}
                  </select>
                </label>
                {createAuthType === "entra" && (
                  <label className="modal-label">
                    {t("users.dialog.field.entraOid") || "Entra Object ID (OID)"}
                    <input className="modal-input" value={cEntraOid} onChange={(e) => setCEntraOid(e.target.value)} disabled={busy} placeholder="00000000-0000-0000-0000-000000000000" />
                  </label>
                )}
                <label className="modal-label">
                  {t("users.dialog.field.username") || "Username"}
                  <input className="modal-input" value={cUsername} onChange={(e) => setCUsername(e.target.value)} disabled={busy} />
                </label>
                <label className="modal-label">
                  {t("users.dialog.field.firstName") || "First name"}
                  <input className="modal-input" value={cFirstName} onChange={(e) => setCFirstName(e.target.value)} disabled={busy} />
                </label>
                <label className="modal-label">
                  {t("users.dialog.field.lastName") || "Last name"}
                  <input className="modal-input" value={cLastName} onChange={(e) => setCLastName(e.target.value)} disabled={busy} />
                </label>
                <label className="modal-label">
                  {t("users.dialog.field.email") || "Email"}
                  <input className="modal-input" type="email" value={cEmail} onChange={(e) => setCEmail(e.target.value)} disabled={busy} />
                </label>
                {createAuthType === "local" && (
                  <label className="modal-label">
                    {t("users.dialog.field.password") || "Password"}
                    <input className="modal-input" type="password" value={cPassword} onChange={(e) => setCPassword(e.target.value)} disabled={busy} />
                  </label>
                )}
                {createError && <div style={{ color: "#dc2626", fontSize: 12 }}>{createError}</div>}
                <div className="modal-buttons">
                  <button className="btn-secondary" onClick={() => setShowCreate(false)} disabled={busy}>
                    <X size={14} /> {t("common.cancel") || "Cancel"}
                  </button>
                  <button className="btn-primary" onClick={doCreate} disabled={busy}>
                    <Check size={14} /> {t("common.create") || "Create"}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          {/* Edit dialog */}
          <Dialog.Root open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
            <Dialog.Portal>
              <Dialog.Overlay className="modal-overlay" />
              <Dialog.Content className="modal-content">
                <Dialog.Title className="modal-title">
                  <Pencil size={18} className="title-icon" /> {t("users.dialog.edit") || "Edit user"}
                </Dialog.Title>
                <label className="modal-label">
                  {t("users.dialog.field.username") || "Username"}
                  <input className="modal-input" value={eUsername} onChange={(e) => setEUsername(e.target.value)} disabled={busy} />
                </label>
                <label className="modal-label">
                  {t("users.dialog.field.firstName") || "First name"}
                  <input className="modal-input" value={eFirstName} onChange={(e) => setEFirstName(e.target.value)} disabled={busy} />
                </label>
                <label className="modal-label">
                  {t("users.dialog.field.lastName") || "Last name"}
                  <input className="modal-input" value={eLastName} onChange={(e) => setELastName(e.target.value)} disabled={busy} />
                </label>
                <label className="modal-label">
                  {t("users.dialog.field.email") || "Email"}
                  <input className="modal-input" type="email" value={eEmail} onChange={(e) => setEEmail(e.target.value)} disabled={busy} />
                </label>
                {editError && <div style={{ color: "#dc2626", fontSize: 12 }}>{editError}</div>}
                <div className="modal-buttons">
                  <button className="btn-secondary" onClick={() => setEditing(null)} disabled={busy}>
                    <X size={14} /> {t("common.cancel") || "Cancel"}
                  </button>
                  <button className="btn-primary" onClick={doSaveEdit} disabled={busy}>
                    <Check size={14} /> {t("common.save") || "Save"}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          {/* Password reset dialog */}
          <Dialog.Root open={!!pwTarget} onOpenChange={(o) => !o && setPwTarget(null)}>
            <Dialog.Portal>
              <Dialog.Overlay className="modal-overlay" />
              <Dialog.Content className="modal-content">
                <Dialog.Title className="modal-title">
                  <Key size={18} className="title-icon" /> {t("users.dialog.resetPassword") || "Reset password"}
                </Dialog.Title>
                <div style={{ marginBottom: 8, fontSize: 12, color: "var(--text-muted)" }}>
                  {pwTarget?.displayName || pwTarget?.username}
                </div>
                <label className="modal-label">
                  {t("users.dialog.field.password") || "Password"}
                  <input className="modal-input" type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} disabled={busy} />
                </label>
                {pwError && <div style={{ color: "#dc2626", fontSize: 12 }}>{pwError}</div>}
                <div className="modal-buttons">
                  <button className="btn-secondary" onClick={() => setPwTarget(null)} disabled={busy}>
                    <X size={14} /> {t("common.cancel") || "Cancel"}
                  </button>
                  <button className="btn-primary" onClick={doResetPassword} disabled={busy || !pwNew}>
                    <Check size={14} /> {t("common.save") || "Save"}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          {/* Delete confirmation */}
          <AlertDialog.Root open={!!confirmDelete} onOpenChange={(o) => !o && (setConfirmDelete(null), setDeleteHasProjects(false))}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="modal-overlay" />
              <AlertDialog.Content className="modal-content">
                <AlertDialog.Title className="modal-title">
                  <Trash2 size={18} className="title-icon" /> {t("users.dialog.deleteTitle") || "Delete user"}
                </AlertDialog.Title>
                <AlertDialog.Description style={{ fontSize: 13 }}>
                  {deleteHasProjects
                    ? (t("users.dialog.deleteHasProjects") || "This user has projects. Force-delete anyway? Workspace files are preserved.")
                    : ((t("users.dialog.deleteMessage") || "Delete \"{name}\"? The workspace folder is preserved; transfer their projects first if needed.")
                        .replace("{name}", confirmDelete?.displayName || confirmDelete?.username || ""))}
                </AlertDialog.Description>
                <div className="modal-buttons">
                  <AlertDialog.Cancel className="btn-secondary" disabled={busy}>
                    <X size={14} /> {t("common.cancel") || "Cancel"}
                  </AlertDialog.Cancel>
                  <button className="btn-danger" onClick={() => doDelete(deleteHasProjects)} disabled={busy}>
                    <Trash2 size={14} /> {deleteHasProjects ? (t("users.dialog.deleteForce") || "Force delete") : (t("common.delete") || "Delete")}
                  </button>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>

    </DialogOrPanel>
  );
}

function LinkOtherProjectsDialog({ open, onOpenChange }) {
  const { userId, loadProjects, t } = useContext(AppContext);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});
  const [transferTarget, setTransferTarget] = useState(null);
  const [successMsg, setSuccessMsg] = useState("");
  useEffect(() => {
    if (!successMsg) return;
    const handle = setTimeout(() => setSuccessMsg(""), 2400);
    return () => clearTimeout(handle);
  }, [successMsg]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api(`/admin/users-with-projects?userId=${encodeURIComponent(userId)}`);
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err?.message || String(err));
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const toggle = async (targetUserId, projectId, currentlyLinked) => {
    const key = `${targetUserId}:${projectId}`;
    setBusy(prev => ({ ...prev, [key]: true }));
    try {
      if (currentlyLinked) {
        await api("/admin/projects/unlink", {
          method: "POST",
          body: JSON.stringify({ userId, projectId }),
        });
      } else {
        await api("/admin/projects/link", {
          method: "POST",
          body: JSON.stringify({ userId, targetUserId, projectId }),
        });
      }
      await refresh();
      await loadProjects();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content modal-sticky wide link-dialog-wide">
          <Dialog.Title className="modal-title">
            <Link2 size={20} className="title-icon" />
            {t("projectsGallery.linkDialog.title")}
          </Dialog.Title>
          <div className="modal-body">

          {loading && <div style={{ padding: 16, color: "var(--text-secondary)" }}>{t("common.loading") || "Loading…"}</div>}
          {!loading && error && <div style={{ padding: 12, color: "var(--error)" }}>{error}</div>}
          {!loading && !error && users.length === 0 && (
            <div style={{ padding: 16, color: "var(--text-secondary)" }}>
              {t("projectsGallery.linkDialog.empty")}
            </div>
          )}

          {!loading && users.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {users.map(u => (
                <div key={u.userId}>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text-primary)" }}>
                    {u.displayName}
                    {u.email && u.email !== u.displayName && (
                      <span style={{ marginLeft: 8, fontWeight: 400, color: "var(--text-secondary)" }}>
                        &lt;{u.email}&gt;
                      </span>
                    )}
                    <span style={{ marginLeft: 8, fontWeight: 400, fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)" }}>
                      {u.userId}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {u.projects.map(p => {
                      const key = `${u.userId}:${p.id}`;
                      const isBusy = !!busy[key];
                      const transitiveBlocked = !!p.isLink && !p.linked;
                      const cursor = isBusy ? "wait" : (transitiveBlocked ? "not-allowed" : "pointer");
                      let nameColor;
                      if (p.linked) nameColor = "var(--info, #4ea1f3)";
                      else if (p.isLink) nameColor = "var(--text-muted)";
                      const titleAttr = transitiveBlocked
                        ? (t("projectsGallery.linkDialog.alreadyLink") || "This project is itself a link — cannot link a link")
                        : undefined;
                      return (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <label
                            title={titleAttr}
                            style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, cursor, background: "var(--bg-input)", opacity: transitiveBlocked ? 0.7 : 1 }}
                          >
                            <input
                              type="checkbox"
                              checked={p.linked}
                              disabled={isBusy || transitiveBlocked}
                              onChange={() => toggle(u.userId, p.id, p.linked)}
                            />
                            <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, color: nameColor, fontStyle: p.isLink && !p.linked ? "italic" : undefined }}>
                              {p.name}
                              {p.isLink && <Link2 size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                            </span>
                            <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)" }}>{p.id}</span>
                          </label>
                          {!p.isLink && (
                            <Tip label={t("projectsGallery.linkDialog.transferOwnership") || "Transfer ownership to another user"}>
                              <button
                                className="icon-btn-sm"
                                disabled={isBusy}
                                onClick={() => setTransferTarget({ fromUserId: u.userId, fromDisplayName: u.displayName, fromEmail: u.email, projectId: p.id, projectName: p.name })}
                              >
                                <ArrowRightLeft size={14} />
                              </button>
                            </Tip>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          </div>
          {successMsg && (
            <div style={{ margin: "0 0 8px", padding: 8, background: "var(--success, #4ec9b0)", color: "var(--bg-primary, #1e1e1e)", borderRadius: 4, fontSize: 13 }}>
              <Check size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
              {successMsg}
            </div>
          )}
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary"><X size={14} /> {t("projectsGallery.linkDialog.close")}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <TransferOwnershipDialog
        target={transferTarget}
        onClose={() => setTransferTarget(null)}
        onSuccess={async (msg) => {
          setTransferTarget(null);
          setSuccessMsg(msg);
          await refresh();
          await loadProjects();
        }}
      />
    </Dialog.Root>
  );
}

function TransferOwnershipDialog({ target, onClose, onSuccess }) {
  const { t } = useContext(AppContext);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [picked, setPicked] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const open = !!target;

  useEffect(() => {
    if (!open) return;
    setQ("");
    setResults([]);
    setSearching(false);
    setSearchError("");
    setPicked(null);
    setSubmitting(false);
    setSubmitError(null);
  }, [open, target?.projectId]);

  useEffect(() => {
    if (!open || picked) return;
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearchError("");
      setSearching(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      setSearchError("");
      try {
        const res = await api(`/people/search?q=${encodeURIComponent(trimmed)}&userId=${encodeURIComponent(target.fromUserId)}`);
        if (!cancelled) {
          const list = Array.isArray(res?.users) ? res.users : [];
          setResults(list.filter(u => u.id !== target.fromUserId));
        }
      } catch (err) {
        if (!cancelled) {
          setSearchError(err?.message || String(err));
          setResults([]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [q, open, picked, target?.fromUserId]);

  const submit = async () => {
    if (!picked || !target) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api("/admin/projects/transfer", {
        method: "POST",
        body: JSON.stringify({
          fromUserId: target.fromUserId,
          toUserId: picked.id,
          projectId: target.projectId,
        }),
      });
      onSuccess(t("projectsGallery.transferDialog.success", { name: target.projectName, recipient: picked.displayName })
        || `Transferred "${target.projectName}" to ${picked.displayName}`);
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const errorMessage = (() => {
    if (!submitError) return null;
    const code = submitError?.code || submitError?.body?.code;
    if (code === "PROJECT_LOCKED") {
      const holder = submitError?.body?.holder;
      const name = holder?.displayName || holder?.email || holder?.userId || "another user";
      return t("projectsGallery.transferDialog.lockedBy", { name }) || `Project is currently open by ${name}. Ask them to close it, then try again.`;
    }
    if (code === "TARGET_HAS_REAL_DIR") {
      return t("projectsGallery.transferDialog.targetHasDir") || "The destination user already owns a project with this id.";
    }
    if (code === "NOT_OWNER" || code === "NOT_OWNER_DIR") {
      return t("projectsGallery.transferDialog.notOwner") || "Source user is not the owner of this project.";
    }
    return submitError?.message || String(submitError);
  })();

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title className="modal-title">
            <ArrowRightLeft size={20} className="title-icon" />
            {t("projectsGallery.transferDialog.title") || "Transfer project ownership"}
          </Dialog.Title>

          {target && (
            <div className="modal-body">
              <div style={{ marginBottom: 12, fontSize: 13, color: "var(--text-secondary)" }}>
                {t("projectsGallery.transferDialog.summary", { name: target.projectName }) || (
                  <>Transfer ownership of <strong style={{ color: "var(--text-primary)" }}>{target.projectName}</strong></>
                )}
                <div style={{ marginTop: 4 }}>
                  {t("projectsGallery.transferDialog.from") || "From"}: <strong>{target.fromDisplayName}</strong>
                  {target.fromEmail && target.fromEmail !== target.fromDisplayName && (
                    <span style={{ color: "var(--text-muted)" }}> &lt;{target.fromEmail}&gt;</span>
                  )}
                </div>
              </div>

              {!picked && (
                <>
                  <div style={{ position: "relative", marginBottom: 8 }}>
                    <Search size={14} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
                    <input
                      className="modal-input"
                      style={{ paddingLeft: 28, width: "100%", boxSizing: "border-box" }}
                      placeholder={t("share.searchPlaceholder")}
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      autoFocus
                    />
                  </div>
                  {searching && <div style={{ padding: 8, color: "var(--text-muted)", fontSize: 13 }}>{t("common.loading") || "Loading..."}</div>}
                  {searchError && <div style={{ padding: 8, color: "var(--error)", fontSize: 13 }}>{searchError}</div>}
                  {!searching && !searchError && q.trim().length >= 2 && results.length === 0 && (
                    <div style={{ padding: 8, color: "var(--text-muted)", fontSize: 13 }}>{t("share.noResults")}</div>
                  )}
                  {results.length > 0 && (
                    <div style={{ maxHeight: 280, overflowY: "auto" }}>
                      {results.map((u) => (
                        <div key={u.id} style={{ display: "flex", alignItems: "center", padding: 8, gap: 8, borderBottom: "1px solid var(--border-subtle, #2a2a2a)" }}>
                          <User size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.displayName}</div>
                            {u.mail && <div style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.mail}</div>}
                          </div>
                          <button
                            className="btn-primary"
                            onClick={() => setPicked(u)}
                            style={{ padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap" }}
                          >
                            {t("projectsGallery.transferDialog.pick") || "Select"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {picked && (
                <div>
                  <div style={{ padding: 10, background: "var(--bg-input)", borderRadius: 6, marginBottom: 12 }}>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
                      {t("projectsGallery.transferDialog.to") || "Transfer to"}
                    </div>
                    <div style={{ fontSize: 14, color: "var(--text-primary)" }}>
                      <User size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
                      {picked.displayName}
                      {picked.mail && <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>&lt;{picked.mail}&gt;</span>}
                    </div>
                  </div>
                  <ul style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                    <li>{t("projectsGallery.transferDialog.bulletWorkspace") || "The project workspace moves to the new owner's storage."}</li>
                    <li>{t("projectsGallery.transferDialog.bulletShares") || "Existing shares are re-pointed to the new owner automatically."}</li>
                    <li>{t("projectsGallery.transferDialog.bulletDeploy") || "The deployed Container App URL does not change."}</li>
                    <li>{t("projectsGallery.transferDialog.bulletLoseAccess", { name: target.fromDisplayName }) || `${target.fromDisplayName} will lose access to this project.`}</li>
                  </ul>
                  {errorMessage && (
                    <div style={{ padding: 8, background: "var(--bg-input)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 12 }}>
                      {errorMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="modal-actions">
            {picked && (
              <button className="btn-secondary" onClick={() => setPicked(null)} disabled={submitting}>
                {t("common.back") || "Back"}
              </button>
            )}
            <Dialog.Close asChild>
              <button className="btn-secondary" disabled={submitting}>
                <X size={14} /> {t("common.cancel") || "Cancel"}
              </button>
            </Dialog.Close>
            {picked && (
              <button className="btn-primary" onClick={submit} disabled={submitting}>
                {submitting ? <Loader size={12} className="spin" /> : <ArrowRightLeft size={14} />}
                <span style={{ marginLeft: 4 }}>
                  {t("projectsGallery.transferDialog.confirm") || "Transfer ownership"}
                </span>
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommitsDialog({ open, onOpenChange }) {
  const { state, dispatch, userId, refreshPreview, reloadMessages, reloadDiagrams, t } = useContext(AppContext);
  const [commits, setCommits] = useState([]);
  const [selectedHash, setSelectedHash] = useState(null);
  const [rollbackTarget, setRollbackTarget] = useState(null);

  const loadCommits = async () => {
    try {
      const data = await api(`/projects/${state.currentProjectId}/commits?userId=${userId}`);
      setCommits(data.commits || []);
    } catch {
      setCommits([]);
    }
  };

  useEffect(() => {
    if (open && state.currentProjectId) loadCommits();
  }, [open, state.currentProjectId]);

  useEffect(() => {
    if (commits.length && !commits.find(c => c.hash === selectedHash)) {
      setSelectedHash(commits[0].hash);
    } else if (!commits.length && selectedHash) {
      setSelectedHash(null);
    }
  }, [commits]);

  const selected = commits.find(c => c.hash === selectedHash) || null;
  const rollbackCommit = commits.find(c => c.hash === rollbackTarget) || null;
  const firstLine = (s) => (s || "").split("\n")[0];

  const doRollback = async (hash) => {
    await api(`/projects/${state.currentProjectId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ userId, chatId: state.currentChatId, commitHash: hash }),
    });
    setRollbackTarget(null);
    onOpenChange(false);
    refreshPreview();
    reloadMessages();
    reloadDiagrams();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content commits-wide">
          <Dialog.Title className="modal-title">
            <History size={20} className="title-icon" />
            {t("commits.title")}
          </Dialog.Title>
          <div className="commits-split">
            <div className="commits-list-pane">
              {commits.map(c => (
                <button
                  key={c.hash}
                  type="button"
                  className={`commit-item ${c.hash === selectedHash ? "commit-active" : ""}`}
                  onClick={() => setSelectedHash(c.hash)}
                >
                  <div className="commit-row-top">
                    <GitBranch size={12} className="commit-icon" />
                    <span className="commit-date">{c.date ? new Date(c.date).toLocaleString() : ""}</span>
                    <span className="commit-hash">{c.hash.slice(0, 8)}</span>
                    {(c.tags || []).map(tag => (
                      <span
                        key={tag}
                        title={tag}
                        style={{ display: "inline-flex", alignItems: "center", gap: 2, marginLeft: 4, padding: "0 6px", borderRadius: 10, border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 10, fontWeight: 600, whiteSpace: "nowrap" }}
                      >
                        <Tag size={9} /> {tag}
                      </span>
                    ))}
                  </div>
                  <div className="commit-msg-preview">
                    <MarkdownChunk text={firstLine(c.message)} />
                  </div>
                </button>
              ))}
              {commits.length === 0 && <div className="skills-empty">{t("commits.empty")}</div>}
            </div>
            <div className="commits-detail-pane">
              {selected ? (
                <>
                  <div className="commit-detail-meta">
                    <div><span className="commit-detail-label">{t("commits.hashLabel")}</span> <code>{selected.hash}</code></div>
                    <div><span className="commit-detail-label">{t("commits.dateLabel")}</span> {selected.date ? new Date(selected.date).toLocaleString() : ""}</div>
                    {selected.tags && selected.tags.length > 0 && (
                      <div><span className="commit-detail-label">{t("commits.tagsLabel") || "Tags"}</span> {selected.tags.map(tag => <code key={tag} style={{ marginRight: 6 }}>{tag}</code>)}</div>
                    )}
                  </div>
                  <div className="commit-detail-body">
                    <MarkdownChunk text={selected.message} />
                  </div>
                  <div className="commit-detail-actions">
                    <button className="btn-danger" onClick={() => setRollbackTarget(selected.hash)}>
                      <RotateCcw size={14} /> {t("commits.rollback")}
                    </button>
                  </div>
                </>
              ) : (
                <div className="skills-empty">{t("commits.detailEmpty")}</div>
              )}
            </div>
          </div>

          <AlertDialog.Root open={!!rollbackTarget} onOpenChange={(o) => !o && setRollbackTarget(null)}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="alert-overlay" />
              <AlertDialog.Content className="alert-content">
                <AlertDialog.Title className="alert-title">
                  <AlertTriangle size={18} style={{ color: "var(--error)" }} />
                  {t("commits.rollbackTitle")}
                </AlertDialog.Title>
                <AlertDialog.Description className="alert-description">
                  {t("commits.rollbackMessage", { message: firstLine(rollbackCommit?.message || "") })}
                </AlertDialog.Description>
                <div className="modal-actions">
                  <AlertDialog.Cancel asChild>
                    <button className="btn-secondary">{t("common.cancel")}</button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <button className="btn-danger" onClick={() => rollbackTarget && doRollback(rollbackTarget)}>
                      <RotateCcw size={14} /> {t("commits.rollback")}
                    </button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>

          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary">
                <X size={14} /> {t("common.close")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


// Friendly, jargon-free progress phases shown while a push/pull runs. The
// backend git call is a single blocking request (no byte-level stream), so we
// step through these on a gentle timer to convey motion — non-technical users
// see "what is happening", not raw git object counts.
const GIT_PUSH_PHASES = ["git.push.phase.prepare", "git.push.phase.connect", "git.push.phase.upload", "git.push.phase.finish"];
const GIT_PULL_PHASES = ["git.pull.phase.connect", "git.pull.phase.check", "git.pull.phase.download", "git.pull.phase.apply"];

function GitProgress({ op, t }) {
  const phases = op === "pull" ? GIT_PULL_PHASES : GIT_PUSH_PHASES;
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(0);
    const timer = setInterval(() => {
      setIdx((i) => (i < phases.length - 1 ? i + 1 : i));
    }, 1100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op]);
  const Icon = op === "pull" ? ArrowDownToLine : ArrowUpFromLine;
  const heading = op === "pull" ? t("git.pull.working") : t("git.push.working");
  return (
    <div className="git-progress" role="status" aria-live="polite">
      <div className="git-progress-head">
        <span className="git-progress-icon"><Icon size={18} /></span>
        <span className="git-progress-title">{heading}</span>
      </div>
      <div className="git-progress-track"><div className="git-progress-bar" /></div>
      <div className="git-progress-phase">
        <Loader size={12} className="spin" /> {t(phases[idx])}
      </div>
      <div className="git-progress-note"><Info size={11} /> {t("git.busyNote")}</div>
    </div>
  );
}

function GitResult({ result, showDetails, setShowDetails, t }) {
  const ok = result.kind === "success";
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <div className={`git-result ${ok ? "git-result-ok" : "git-result-err"}`} role="status">
      <Icon size={16} className="git-result-icon" />
      <div className="git-result-body">
        <div className="git-result-msg">{result.message}</div>
        {result.output && (
          <>
            <button type="button" className="git-result-details-toggle" onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t("git.details")}
            </button>
            {showDetails && <pre className="git-result-details">{result.output}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function GitDialog({ open, onOpenChange }) {
  const { state, userId, isAdmin, refreshPreview, reloadDiagrams, gitRemoteConfigured, t } = useContext(AppContext);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [op, setOp] = useState(null); // "push" | "pull" while an operation runs
  const [result, setResult] = useState(null); // { kind, message, output }
  const [showDetails, setShowDetails] = useState(false);
  const [pushConflict, setPushConflict] = useState(false);
  const [pullConflict, setPullConflict] = useState(false);

  useEffect(() => {
    if (!open || !state.currentProjectId || !userId) return;
    api(`/projects/${state.currentProjectId}/git-remote?userId=${userId}`)
      .then((r) => { setRemoteUrl(r.remoteUrl || ""); })
      .catch(() => {});
  }, [open, state.currentProjectId, state.currentProjectName, userId]);

  const push = async (force = false) => {
    setPushConflict(false);
    setResult(null);
    setShowDetails(false);
    setOp("push");
    setBusy(true);
    try {
      const res = await api(`/projects/${state.currentProjectId}/git-push`, {
        method: "POST",
        body: JSON.stringify({ userId, force }),
      });
      const out = res.output || "";
      setOutput(out);
      setResult({ kind: "success", message: t("git.push.done"), output: out });
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("rejected") || msg.includes("fetch first") || msg.includes("non-fast-forward") || msg.includes("abgelehnt")) {
        setPushConflict(true);
        setOutput(msg);
        setResult({ kind: "conflict", message: t("git.pushConflict"), output: msg });
      } else {
        setOutput(`Error: ${msg}`);
        setResult({ kind: "error", message: t("git.push.failed"), output: msg });
      }
    } finally { setBusy(false); setOp(null); }
  };

  const pull = async (force = false) => {
    setPullConflict(false);
    setResult(null);
    setShowDetails(false);
    setOp("pull");
    setBusy(true);
    try {
      const res = await api(`/projects/${state.currentProjectId}/git-pull`, {
        method: "POST",
        body: JSON.stringify({ userId, force }),
      });
      const out = res.output || "";
      setOutput(out);
      setResult({ kind: "success", message: t("git.pull.done"), output: out });
      refreshPreview();
      reloadDiagrams();
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("überschrieben") || msg.includes("overwritten") || msg.includes("untracked") || msg.includes("Merge")) {
        setPullConflict(true);
        setOutput(msg);
        setResult({ kind: "conflict", message: t("git.pullConflict"), output: msg });
      } else {
        setOutput(`Error: ${msg}`);
        setResult({ kind: "error", message: t("git.pull.failed"), output: msg });
      }
    } finally { setBusy(false); setOp(null); }
  };

  // No repository URL configured (Project Settings → Version control) means
  // there is nothing to push/pull to — block every action button; only Close
  // stays available.
  const hasRemote = !!(remoteUrl && remoteUrl.trim());
  const canOperate = gitRemoteConfigured && hasRemote;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (busy) return; onOpenChange(o); if (!o) { setOutput(""); setResult(null); setShowDetails(false); setPullConflict(false); setPushConflict(false); setBusy(false); setOp(null); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}
        >
          <Dialog.Title className="modal-title">
            <GitBranch size={20} className="title-icon" />
            {t("git.title")}
          </Dialog.Title>

          {remoteUrl ? (
            <label className="modal-label">
              <Link size={12} style={{ display: "inline", verticalAlign: "-1px", marginRight: 4 }} />
              {t("git.remoteUrl")}
              <div style={{ display: "flex", gap: 4, marginTop: 6, alignItems: "stretch" }}>
                <input
                  type="text"
                  value={remoteUrl}
                  readOnly
                  className="modal-input"
                  style={{ flex: 1, minWidth: 0, marginTop: 0, opacity: 0.75, cursor: "default" }}
                />
                <button
                  type="button"
                  className="icon-btn-sm"
                  onClick={() => window.open(remoteUrl, "_blank", "noopener,noreferrer")}
                  disabled={!/^https?:\/\//i.test(remoteUrl)}
                  title="Open in new tab"
                >
                  <ExternalLink size={13} />
                </button>
              </div>
            </label>
          ) : (
            <div className="modal-label" style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {t("git.noRemote")}
            </div>
          )}

          <div className="modal-actions" style={{ flexWrap: "nowrap" }}>
            <button className="btn-secondary" onClick={() => push(false)} disabled={busy || !canOperate}>
              <ArrowUpFromLine size={14} /> {t("git.push")}
            </button>
            <button className="btn-secondary" onClick={() => pull(false)} disabled={busy || !canOperate}>
              <ArrowDownToLine size={14} /> {t("git.pull")}
            </button>
            {isAdmin && (
              <button className="btn-danger" onClick={() => push(true)} disabled={busy || !canOperate}>
                <AlertTriangle size={14} /> {t("git.pushForce")}
              </button>
            )}
          </div>
          {busy && <GitProgress op={op} t={t} />}
          {!busy && result && result.kind !== "conflict" && (
            <GitResult result={result} showDetails={showDetails} setShowDetails={setShowDetails} t={t} />
          )}
          {!busy && pullConflict && (
            <div className="git-conflict-actions">
              <span className="git-conflict-label">{t("git.pullConflict")}</span>
              <button className="btn-danger" onClick={() => pull(true)} disabled={busy || !canOperate}>
                <AlertTriangle size={14} /> {t("git.pullForce")}
              </button>
            </div>
          )}
          {!busy && pushConflict && (
            <div className="git-conflict-actions">
              <span className="git-conflict-label">{t("git.pushConflict")}</span>
              <button className="btn-danger" onClick={() => push(true)} disabled={busy || !canOperate}>
                <AlertTriangle size={14} /> {t("git.pushForce")}
              </button>
            </div>
          )}
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary" disabled={busy}>
                <X size={14} /> {t("common.close")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DeployStepList({ stepIds, steps, logs, t, translationPrefix = "deploy.step." }) {
  const [openLogs, setOpenLogs] = useState({});
  const logEndRefs = useRef({});

  // Auto-scroll log to bottom when new lines arrive
  useEffect(() => {
    for (const id of Object.keys(openLogs)) {
      if (openLogs[id] && logEndRefs.current[id]) {
        logEndRefs.current[id].scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [logs, openLogs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, margin: "12px 0" }}>
      {stepIds.map(id => {
        const s = steps[id];
        const status = s?.status || "pending";
        const stepLogs = logs[id] || [];
        const hasLogs = stepLogs.length > 0;
        const isOpen = openLogs[id] || false;
        let icon;
        if (status === "finished") icon = <CircleCheck size={14} style={{ color: "var(--success)", flexShrink: 0 }} />;
        else if (status === "in-progress") icon = <Loader size={14} className="spin" style={{ color: "var(--accent)", flexShrink: 0 }} />;
        else if (status === "failed") icon = <CircleX size={14} style={{ color: "var(--error)", flexShrink: 0 }} />;
        else icon = <Circle size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
        return (
          <div key={id}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "3px 0", cursor: hasLogs ? "pointer" : "default" }}
              onClick={() => hasLogs && setOpenLogs(prev => ({ ...prev, [id]: !prev[id] }))}
            >
              {icon}
              <span style={{ color: status === "pending" ? "var(--text-muted)" : "var(--text-primary)", flex: 1 }}>{t(`${translationPrefix}${id}`)}</span>
              {hasLogs && (
                status !== "pending" ? (isOpen ? <ChevronDown size={12} style={{ color: "var(--text-muted)" }} /> : <ChevronRight size={12} style={{ color: "var(--text-muted)" }} />) : null
              )}
            </div>
            {status === "failed" && s?.error && (
              <div style={{ color: "var(--error)", fontSize: 12, marginLeft: 22, marginTop: 2 }}>{s.error}</div>
            )}
            {isOpen && hasLogs && (
              <div className="git-output" style={{ marginLeft: 22, marginTop: 4, marginBottom: 6, maxHeight: 160, overflowY: "auto", fontSize: 11, padding: "6px 8px" }}>
                {stepLogs.map((line, i) => (
                  <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</div>
                ))}
                <div ref={el => logEndRefs.current[id] = el} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


function buildProjectMarkdown({ projectName, projectId, appType, t }) {
  const lines = [];
  lines.push(`# ${projectName || projectId}`);
  lines.push("");
  lines.push(`- **${t("projectInfo.id")}**: \`${projectId}\``);
  if (appType) {
    const label = appType === "web"
      ? (t("projectInfo.appType.web") || "Client-side web app")
      : (t("projectInfo.appType.node") || "Node web app");
    lines.push(`- **${t("projectInfo.appType") || "App type"}**: ${label}`);
  }
  return lines.join("\n");
}

function DeployJobLog({ jobId, kind, status, format, onCancel, onClose, t }) {
  const preRef = useRef(null);
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (!jobId) return undefined;
    setLines([]);
    const es = new EventSource(`/api/projects/${encodeURIComponent(window.__VCA_DEPLOY_PID__ || "_")}/deploy/events?jobId=${encodeURIComponent(jobId)}`);
    es.addEventListener("log", (e) => {
      try {
        const data = JSON.parse(e.data);
        setLines((prev) => [...prev.slice(-499), { stream: data.stream || "stdout", line: data.line || "" }]);
      } catch { /* ignore */ }
    });
    es.onerror = () => { /* auto-reconnects */ };
    return () => { try { es.close(); } catch { /* ignore */ } };
  }, [jobId]);
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);
  if (!jobId) return null;
  const effectiveStatus = status || "running";
  const kindLabel = t(`deploy.job.label.${kind}`);
  let friendlyKind = (kindLabel && kindLabel !== `deploy.job.label.${kind}`) ? kindLabel : kind;
  if (format) {
    const formatLabel = t(`deploy.job.format.${format}`);
    friendlyKind += ` · ${(formatLabel && formatLabel !== `deploy.job.format.${format}`) ? formatLabel : format}`;
  }
  const statusKey = `deploy.job.status.${effectiveStatus}`;
  const statusLabel = t(statusKey);
  const friendlyStatus = (statusLabel && statusLabel !== statusKey) ? statusLabel : effectiveStatus;
  const StatusIcon = effectiveStatus === "running" ? Loader
    : effectiveStatus === "succeeded" ? CircleCheck
    : effectiveStatus === "cancelled" ? Circle
    : CircleX;
  return (
    <div className={`dpl-job dpl-job-${effectiveStatus}`}>
      <div className="dpl-job-head">
        <div className="dpl-job-title">
          <StatusIcon size={14} className={effectiveStatus === "running" ? "dpl-spin" : ""} />
          <span>{friendlyKind}</span>
          <span className="dpl-job-status">{friendlyStatus}</span>
        </div>
        {effectiveStatus === "running" && onCancel && (
          <button className="btn-ghost dpl-job-cancel" onClick={onCancel}>{t("common.cancel") || "Cancel"}</button>
        )}
        {effectiveStatus !== "running" && onClose && (
          <button
            className="dpl-job-dismiss"
            onClick={onClose}
            aria-label={t("deploy.job.dismiss") || "Dismiss"}
            title={t("deploy.job.dismiss") || "Dismiss"}
          ><X size={14} /></button>
        )}
      </div>
      <pre ref={preRef} className="dpl-job-log">
        {lines.map((l, i) => (
          <div key={i} className={l.stream === "stderr" ? "dpl-job-log-err" : undefined}>{l.line}</div>
        ))}
      </pre>
    </div>
  );
}

function DeployDialog({ open, onOpenChange }) {
  const { state, userId, t } = useContext(AppContext);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [deploymentOption, setDeploymentOption] = useState("");
  const [info, setInfo] = useState(null);
  const [activeJobs, setActiveJobs] = useState({});
  const [bumpMode, setBumpMode] = useState("patch");
  const [customVersion, setCustomVersion] = useState("");
  const [actionError, setActionError] = useState({});
  // True when running in the packaged desktop app (from deploy/state). Decides
  // whether the release-folder link opens the OS file explorer or the in-app
  // browser dialog.
  const [isPackaged, setIsPackaged] = useState(false);
  // Static web export readiness ({ hasIndexHtml } for web-app projects, null otherwise).
  const [webExport, setWebExport] = useState(null);
  // Web export in flight ("zip" | "html" | "") and the release/ file name the
  // last export produced.
  const [webExporting, setWebExporting] = useState("");
  const [webExportDone, setWebExportDone] = useState("");

  const projectId = state.currentProjectId;

  // Expose projectId to the SSE child so it can build the events URL.
  useEffect(() => { window.__VCA_DEPLOY_PID__ = projectId || ""; }, [projectId]);

  const reload = useCallback(async () => {
    if (!projectId || !userId) return;
    setLoadError("");
    try {
      const data = await api(`/projects/${encodeURIComponent(projectId)}/deploy/state?userId=${encodeURIComponent(userId)}`);
      setInfo(data?.info || null);
      setDeploymentOption(data?.deploymentOption || "");
      setActiveJobs(data?.activeJobs || {});
      setIsPackaged(!!data?.isPackaged);
      setWebExport(data?.webExport || null);
    } catch (err) {
      setLoadError(err?.message || String(err));
    }
  }, [projectId, userId]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    reload().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, reload]);

  // Poll while any job is running.
  useEffect(() => {
    if (!open) return undefined;
    const hasRunning = Object.values(activeJobs || {}).some((j) => j && j.status === "running");
    if (!hasRunning) return undefined;
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [open, activeJobs, reload]);

  const startAction = async (subpath, body, kindKey) => {
    setActionError((prev) => ({ ...prev, [kindKey]: "" }));
    try {
      const result = await api(`/projects/${encodeURIComponent(projectId)}/deploy/${subpath}`, {
        method: "POST",
        body: JSON.stringify({ userId, ...body }),
      });
      const jobId = result?.jobId;
      const kind = result?.kind || kindKey;
      if (jobId && kind) {
        setActiveJobs((prev) => ({
          ...prev,
          [kind]: { jobId, kind, status: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null, exitCode: null, version: result?.version, tag: result?.tag, format: result?.format },
        }));
      }
      await reload();
    } catch (err) {
      setActionError((prev) => ({ ...prev, [kindKey]: err?.message || String(err) }));
    }
  };

  const cancelKind = async (kind) => {
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/deploy/cancel`, {
        method: "POST",
        body: JSON.stringify({ userId, kind }),
      });
      await reload();
    } catch (err) {
      setActionError((prev) => ({ ...prev, [kind]: err?.message || String(err) }));
    }
  };

  const dismissKind = (kind) => {
    setActiveJobs((prev) => ({ ...prev, [kind]: null }));
  };

  // Static web export: the server writes appname-version.zip/.html into the
  // project's release/ folder and answers with the file name it created.
  const runWebExport = async (kind) => {
    setWebExporting(kind);
    setWebExportDone("");
    setActionError((prev) => ({ ...prev, "web-export": "" }));
    try {
      const result = await api(`/projects/${encodeURIComponent(projectId)}/deploy/export/${kind}`, {
        method: "POST",
        body: JSON.stringify({ userId, name: state.currentProjectName || "app" }),
      });
      setWebExportDone(result?.fileName || "");
    } catch (err) {
      setActionError((prev) => ({ ...prev, "web-export": err?.message || String(err) }));
    } finally {
      setWebExporting("");
    }
  };

  const nextVersion = useMemo(() => {
    const cur = info?.packageVersion || "";
    const match = cur.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return "";
    let [maj, min, pat] = [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
    if (bumpMode === "patch") pat += 1;
    else if (bumpMode === "minor") { min += 1; pat = 0; }
    else if (bumpMode === "major") { maj += 1; min = 0; pat = 0; }
    else if (bumpMode === "custom") return customVersion.replace(/^v/, "");
    return `${maj}.${min}.${pat}`;
  }, [info, bumpMode, customVersion]);

  const anyRunning = (job) => job && job.status === "running";
  const isDeploying = Object.values(activeJobs || {}).some(anyRunning);
  const electronWin = activeJobs["electron-win"];
  const electronMac = activeJobs["electron-mac"];
  const electronLinux = activeJobs["electron-linux"];
  const gitJob = activeJobs["git-release"];

  const providerName = deploymentOption === "electron" ? t("deploy.provider.electron")
    : deploymentOption === "git-tag" ? t("deploy.provider.gitTag")
    : deploymentOption === "web-export" ? t("deploy.provider.webExport")
    : "";
  const title = deploymentOption ? t("deploy.title", { provider: providerName }) : t("deploy.titleGeneric");
  const TitleIcon = deploymentOption === "git-tag" ? GitBranch
    : deploymentOption === "web-export" ? Globe
    : Package;
  const projectLabel = state.currentProjectName || projectId;
  const versionLabel = info?.packageVersion;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content modal-sticky dpl-dialog"
          onInteractOutside={(e) => { if (isDeploying) e.preventDefault(); }}
        >
          <Dialog.Title className="modal-title">
            <TitleIcon size={20} className="title-icon" />
            {title}
          </Dialog.Title>
          <div className="modal-body dpl-body">
            {loading && <div>…</div>}
            {loadError && <div className="dpl-error">{loadError}</div>}
            {!loading && !loadError && (
              <>
                {/* Project meta */}
                <div className="dpl-meta">
                  <span className="dpl-meta-item"><strong>{projectLabel}</strong></span>
                  {versionLabel && (
                    <span className="dpl-meta-item">
                      <Tag size={12} /> {versionLabel}
                    </span>
                  )}
                  {info?.isGitRepo ? (
                    <span className="dpl-meta-item">
                      <GitBranch size={12} /> {info.currentBranch || "?"}
                      {info.dirty && <span className="dpl-meta-warn">· {t("deploy.dirty")}</span>}
                    </span>
                  ) : (
                    <span className="dpl-meta-warn"><GitBranch size={12} /> {t("deploy.notRepo")}</span>
                  )}
                </div>

                {!deploymentOption && (
                  <div className="dpl-empty">
                    <Info size={16} />
                    <span>{t("deploy.notConfigured")}</span>
                  </div>
                )}

                {deploymentOption === "electron" && (
                  <div className="dpl-section">
                    <div className="dpl-subtitle">{t("deploy.electron.subtitle")}</div>
                    <div className="dpl-target-row">
                      <button className="btn-secondary dpl-target" disabled={anyRunning(electronWin)} onClick={() => startAction("electron", { target: "win", format: "installer" }, "electron-win")}>
                        <Download size={14} /> {t("deploy.electron.winInstaller")}
                      </button>
                      <button className="btn-secondary dpl-target" disabled={anyRunning(electronWin)} onClick={() => startAction("electron", { target: "win", format: "portable" }, "electron-win")}>
                        <Download size={14} /> {t("deploy.electron.winPortable")}
                      </button>
                      <button className="btn-secondary dpl-target" disabled={anyRunning(electronMac)} onClick={() => startAction("electron", { target: "mac" }, "electron-mac")}>
                        <Download size={14} /> {t("deploy.electron.mac")}
                      </button>
                      <button className="btn-secondary dpl-target" disabled={anyRunning(electronLinux)} onClick={() => startAction("electron", { target: "linux" }, "electron-linux")}>
                        <Download size={14} /> {t("deploy.electron.linux")}
                      </button>
                    </div>
                    {(actionError["electron-win"] || actionError["electron-mac"] || actionError["electron-linux"]) && (
                      <div className="dpl-error">
                        {actionError["electron-win"] || actionError["electron-mac"] || actionError["electron-linux"]}
                      </div>
                    )}
                    {["electron-win", "electron-mac", "electron-linux"].map((k) => activeJobs[k] && (
                      <DeployJobLog
                        key={k}
                        jobId={activeJobs[k].jobId}
                        kind={k}
                        status={activeJobs[k].status}
                        format={activeJobs[k].format}
                        onCancel={() => cancelKind(k)}
                        onClose={() => dismissKind(k)}
                        t={t}
                      />
                    ))}
                    <ReleaseFolderAccess isPackaged={isPackaged} />
                  </div>
                )}

                {deploymentOption === "git-tag" && (
                  <div className="dpl-section">
                    <div className="dpl-subtitle">{t("deploy.gitTag.subtitle")}</div>
                    <div className="dpl-bump-row">
                      <span className="dpl-bump-label">{t("deploy.gitTag.bump")}</span>
                      {["patch", "minor", "major", "custom"].map((b) => (
                        <label key={b} className="dpl-bump-option">
                          <input type="radio" name="deploy-bump" value={b} checked={bumpMode === b} onChange={() => setBumpMode(b)} />
                          {b}
                        </label>
                      ))}
                    </div>
                    {bumpMode === "custom" && (
                      <label className="modal-label">
                        {t("deploy.gitTag.customVersion")}
                        <input className="modal-input" value={customVersion} onChange={(e) => setCustomVersion(e.target.value)} placeholder="1.2.3" />
                      </label>
                    )}
                    <div className="dpl-next">
                      {t("deploy.gitTag.next")}: <strong>{nextVersion || "?"}</strong>
                    </div>
                    <button className="btn-primary" disabled={!info?.isGitRepo || anyRunning(gitJob)} onClick={() => startAction("git-tag", { bump: bumpMode, customVersion: bumpMode === "custom" ? customVersion : undefined }, "git-release")}>
                      <Save size={14} /> {t("deploy.gitTag.btn")}
                    </button>
                    {actionError["git-release"] && <div className="dpl-error">{actionError["git-release"]}</div>}
                    {gitJob && (
                      <DeployJobLog
                        jobId={gitJob.jobId}
                        kind="git-release"
                        status={gitJob.status}
                        onCancel={() => cancelKind("git-release")}
                        onClose={() => dismissKind("git-release")}
                        t={t}
                      />
                    )}
                  </div>
                )}

                {deploymentOption === "web-export" && (
                  <div className="dpl-section">
                    <div className="dpl-subtitle">{t("deploy.webExport.subtitle")}</div>
                    {webExport && !webExport.hasIndexHtml && (
                      <div className="dpl-error">{t("deploy.webExport.missingIndex")}</div>
                    )}
                    <div className="dpl-target-row">
                      <button
                        className="btn-secondary dpl-target"
                        disabled={!webExport?.hasIndexHtml || !!webExporting}
                        onClick={() => runWebExport("zip")}
                      >
                        {webExporting === "zip" ? <Loader size={14} className="spin" /> : <Package size={14} />} {t("deploy.webExport.zipBtn")}
                      </button>
                      <button
                        className="btn-secondary dpl-target"
                        disabled={!webExport?.hasIndexHtml || !!webExporting}
                        onClick={() => runWebExport("html")}
                      >
                        {webExporting === "html" ? <Loader size={14} className="spin" /> : <FileText size={14} />} {t("deploy.webExport.htmlBtn")}
                      </button>
                    </div>
                    {actionError["web-export"] && <div className="dpl-error">{actionError["web-export"]}</div>}
                    {webExportDone && (
                      <div className="dpl-hint" style={{ color: "var(--success)", fontSize: 12 }}>
                        {t("deploy.webExport.done", { file: webExportDone })}
                      </div>
                    )}
                    <div className="dpl-hint" style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {t("deploy.webExport.hint")}
                    </div>
                    <ReleaseFolderAccess isPackaged={isPackaged} />
                  </div>
                )}
              </>
            )}
          </div>
          <div className="modal-actions">
            <Dialog.Close asChild>
              <button className="btn-secondary"><X size={14} /> {t("common.close") || "Close"}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SkillsDialog({ open, onOpenChange }) {
  const { userId, state, t } = useContext(AppContext);
  const [skills, setSkills] = useState([]);
  const [activeSkills, setActiveSkills] = useState([]);
  const [skillStatus, setSkillStatus] = useState({});
  const [editingSkill, setEditingSkill] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [repoRefreshing, setRepoRefreshing] = useState(false);
  const [repoRefreshErrors, setRepoRefreshErrors] = useState([]);
  const load = async () => {
    try { setSkills(await api(`/users/${userId}/skills${state.currentProjectId ? `?projectId=${state.currentProjectId}` : ""}`)); }
    catch { setSkills([]); }
    if (state.currentProjectId) {
      try { setActiveSkills(await api(`/projects/${state.currentProjectId}/active-skills?userId=${userId}`)); }
      catch { setActiveSkills([]); }
      try { setSkillStatus(await api(`/projects/${state.currentProjectId}/skills-status?userId=${userId}`)); }
      catch { setSkillStatus({}); }
    } else {
      setSkillStatus({});
    }
  };

  useEffect(() => { if (open) load(); }, [open]);

  const deleteSkill = async (name) => {
    await api(`/users/${userId}/skills/${name}`, { method: "DELETE" });
    setDeleteTarget(null);
    load();
  };

  const toggleSkill = async (key) => {
    if (!state.currentProjectId) return;
    const newActive = activeSkills.includes(key)
      ? activeSkills.filter(n => n !== key)
      : [...activeSkills, key];
    setActiveSkills(newActive);
    await api(`/projects/${state.currentProjectId}/active-skills`, {
      method: "PUT",
      body: JSON.stringify({ userId, skills: newActive }),
    });
    try { setSkillStatus(await api(`/projects/${state.currentProjectId}/skills-status?userId=${userId}`)); }
    catch {}
  };

  const projectSkills = skills.filter(s => s.kind === "project");
  const userSkills = skills.filter(s => (s.kind ? s.kind === "user" : !s.system));
  const hasTrackedRepos = userSkills.some(s => s.repoUrl);

  // Re-pull every repo-tracked user skill; per-skill failures surface in an
  // error box, successful ones just show their new content/version.
  const refreshRepoSkills = async () => {
    setRepoRefreshing(true);
    setRepoRefreshErrors([]);
    try {
      const r = await api(`/users/${userId}/skills/refresh-repos`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      const failed = (r.results || []).filter(x => !x.ok);
      setRepoRefreshErrors(failed.map(f => `${f.name}: ${f.error}`));
      await load();
    } catch (err) {
      setRepoRefreshErrors([err && err.message ? err.message : t("skills.refreshUserFailed")]);
    } finally {
      setRepoRefreshing(false);
    }
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content skills-dialog">
            <div className="skills-header">
              <Dialog.Title className="modal-title">
                <Zap size={20} className="title-icon" />
                {t("skills.title")}
              </Dialog.Title>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {hasTrackedRepos && (
                  <Tip label={t("skills.refreshUser")} side="bottom">
                    <button className="icon-btn" onClick={refreshRepoSkills} disabled={repoRefreshing}>
                      <RefreshCw size={14} className={repoRefreshing ? "spin" : ""} />
                    </button>
                  </Tip>
                )}
                <button className="btn-new-skill" onClick={() => setEditingSkill({})}>
                  <Plus size={14} /> {t("skills.newSkill")}
                </button>
              </div>
            </div>

            <div className="skills-body">

            {repoRefreshErrors.length > 0 && (
              <div className="skill-editor-error" role="alert" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={14} />
                  <span>{t("skills.refreshUserFailed")}</span>
                </div>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 160, overflow: "auto", margin: "4px 0 0", fontSize: 12 }}>{repoRefreshErrors.join("\n")}</pre>
              </div>
            )}

            {projectSkills.length > 0 && (
              <>
                <div className="skills-section-label">{t("skills.project")}</div>
                <div className="skills-list">
                  {projectSkills.map(s => {
                    const dirKey = s.dirName || s.name;
                    const status = activeSkills.includes(s.name) ? skillStatus[dirKey] : null;
                    return (
                    <div key={s.name} className="skill-item">
                      {state.currentProjectId && (
                        <button
                          className={`skill-toggle ${activeSkills.includes(s.name) ? "active" : ""}`}
                          onClick={() => toggleSkill(s.name)}
                          title={activeSkills.includes(s.name) ? "Deactivate" : "Activate"}
                        />
                      )}
                      <div className="skill-info">
                        <div className="skill-name">
                          <BookOpen size={14} />
                          {s.name}
                          <span className="skill-badge project">{t("skills.projectBadge")}</span>
                          {s.version && <span className="skill-badge version">v{s.version}</span>}
                          {status && status.loaded && (
                            <span className="skill-badge status-loaded" title={t("skills.statusLoadedTitle")}>{t("skills.statusLoaded")}</span>
                          )}
                          {status && !status.loaded && (
                            <span className="skill-badge status-failed" title={status.errors.join("\n") || t("skills.statusFailedTitle")}>{t("skills.statusFailed")}</span>
                          )}
                        </div>
                        <div className="skill-desc">{s.description}</div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className="skills-section-label">{t("skills.user")}</div>
            <div className="skills-list">
              {userSkills.length === 0 ? (
                <div className="skills-empty">{t("skills.emptyUser")}</div>
              ) : userSkills.map(s => {
                const dirKey = s.dirName || s.name;
                const status = activeSkills.includes(s.name) ? skillStatus[dirKey] : null;
                return (
                <div key={s.name} className="skill-item">
                  {state.currentProjectId && (
                    <button
                      className={`skill-toggle ${activeSkills.includes(s.name) ? "active" : ""}`}
                      onClick={() => toggleSkill(s.name)}
                      title={activeSkills.includes(s.name) ? "Deactivate" : "Activate"}
                    />
                  )}
                  <div className="skill-info">
                    <div className="skill-name">
                      <BookOpen size={14} />
                      {s.name}
                      {s.version && <span className="skill-badge version">v{s.version}</span>}
                      {s.repoUrl && (
                        <a href={s.repoUrl} target="_blank" rel="noopener noreferrer" className="skill-repo-link" title={t("skills.openRepo")}>
                          <ExternalLink size={12} />
                        </a>
                      )}
                      {status && status.loaded && (
                        <span className="skill-badge status-loaded" title={t("skills.statusLoadedTitle")}>{t("skills.statusLoaded")}</span>
                      )}
                      {status && !status.loaded && (
                        <span className="skill-badge status-failed" title={status.errors.join("\n") || t("skills.statusFailedTitle")}>{t("skills.statusFailed")}</span>
                      )}
                    </div>
                    <div className="skill-desc">{s.description}</div>
                  </div>
                  <div className="skill-actions">
                    <button onClick={() => setEditingSkill({ name: s.dirName || s.name, isEdit: true })}>
                      <Pencil size={11} /> {t("skills.edit")}
                    </button>

                    <AlertDialog.Root open={deleteTarget === s.name} onOpenChange={(o) => !o && setDeleteTarget(null)}>
                      <AlertDialog.Trigger asChild>
                        <button className="delete-skill-btn" onClick={() => setDeleteTarget(s.name)}>
                          <Trash2 size={11} /> {t("skills.delete")}
                        </button>
                      </AlertDialog.Trigger>
                      <AlertDialog.Portal>
                        <AlertDialog.Overlay className="alert-overlay" />
                        <AlertDialog.Content className="alert-content">
                          <AlertDialog.Title className="alert-title">
                            <AlertTriangle size={18} style={{ color: "var(--error)" }} />
                            {t("skills.deleteTitle")}
                          </AlertDialog.Title>
                          <AlertDialog.Description className="alert-description">
                            {t("skills.deleteMessage", { name: s.name })}
                          </AlertDialog.Description>
                          <div className="modal-actions">
                            <AlertDialog.Cancel asChild>
                              <button className="btn-secondary">{t("common.cancel")}</button>
                            </AlertDialog.Cancel>
                            <AlertDialog.Action asChild>
                              <button className="btn-danger" onClick={() => deleteSkill(s.name)}>
                                <Trash2 size={14} /> {t("skills.delete")}
                              </button>
                            </AlertDialog.Action>
                          </div>
                        </AlertDialog.Content>
                      </AlertDialog.Portal>
                    </AlertDialog.Root>
                  </div>
                </div>
                );
              })}
            </div>

            {!state.currentProjectId && (
              <div style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", marginTop: 8 }}>
                {t("skills.selectProject")}
              </div>
            )}

            </div>

            <div className="skills-footer">
              <Dialog.Close asChild>
                <button className="btn-secondary">
                  <X size={14} /> {t("common.close")}
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {editingSkill !== null && (
        <SkillEditorDialog
          open={true}
          onOpenChange={(o) => { if (!o) { setEditingSkill(null); load(); } }}
          skillName={editingSkill.name}
          isEdit={editingSkill.isEdit}
          isView={editingSkill.isView}
        />
      )}
    </>
  );
}

function SkillEditorDialog({ open, onOpenChange, skillName, isEdit, isView, asSystem: asSystemProp }) {
  const { userId, t } = useContext(AppContext);
  const [name, setName] = useState(skillName || "");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState(null);
  // Creation offers three modes for both tiers: author the skill manually,
  // clone it from a git repository link (system: tracked repo; user: one-shot
  // editable import), or upload a zip archive.
  const [createMode, setCreateMode] = useState("manual");
  const [repoUrl, setRepoUrl] = useState("");
  const [zipFile, setZipFile] = useState(null);
  const zipInputRef = useRef(null);
  // Source-repo settings of an existing repo-tracked user skill: the origin
  // URL (read-only) and whether refresh pulls version tags or the default
  // branch. origUseTags detects an actual change so save() only PUTs then.
  const [sourceRepo, setSourceRepo] = useState(null);
  const [useTags, setUseTags] = useState(false);
  const [origUseTags, setOrigUseTags] = useState(false);
  const [busy, setBusy] = useState(false);
  const modeSelectable = !isEdit && !isView;
  const repoMode = modeSelectable && createMode === "repo";
  const zipMode = modeSelectable && createMode === "zip";

  // Mirrors the server's repoToSkillName (skill-repo-sync.ts): the skill is
  // named after the URL's last path segment with any .git suffix stripped.
  const repoSkillName = (url) => {
    const segments = url.trim().replace(/\/+$/, "").split("/");
    return (segments[segments.length - 1] || "").replace(/\.git$/, "");
  };

  const loadPath = asSystemProp
    ? `/admin/skills/${skillName}`
    : `/users/${userId}/skills/${skillName}`;

  useEffect(() => {
    if (open && isEdit && skillName) {
      api(loadPath)
        .then(s => {
          setDescription(s.description); setContent(s.content);
          if (!asSystemProp && s.repoUrl) {
            setSourceRepo({ url: s.repoUrl });
            setUseTags(!!s.useTags);
            setOrigUseTags(!!s.useTags);
          }
        })
        .catch(() => {});
    }
    if (open && !isEdit) {
      setName(""); setDescription(""); setContent("");
    }
    if (open) {
      setError(null);
      setCreateMode("manual");
      setRepoUrl("");
      setZipFile(null);
      setSourceRepo(null);
      setBusy(false);
    }
  }, [open, skillName]);

  const saveFromRepo = async () => {
    setError(null);
    const url = repoUrl.trim();
    if (!url) {
      setError(t("skillEditor.errRepoUrlRequired"));
      return;
    }
    const expectedName = repoSkillName(url);
    setBusy(true);
    try {
      if (!asSystemProp) {
        // User tier: one-shot import — the server clones once and the result
        // is a normal editable user skill (no repo tracking, no re-sync).
        // userId rides in the body so the auth middleware can cross-check it.
        try {
          await api(`/users/${userId}/skills/install-repo`, {
            method: "POST",
            body: JSON.stringify({ url, userId }),
          });
        } catch (err) {
          if (err && err.code !== "exists") throw err;
          const name = (err.body && err.body.skillName) || expectedName;
          if (!window.confirm(t("skillEditor.replaceConfirm", { name }))) return;
          await api(`/users/${userId}/skills/install-repo`, {
            method: "POST",
            body: JSON.stringify({ url, userId, replace: true }),
          });
        }
        onOpenChange(false);
        return;
      }
      const r = await api("/admin/skill-repos", { method: "POST", body: JSON.stringify({ url }) });
      if (r && r.sync && r.sync.ok === false) {
        setError(r.sync.error || t("skillEditor.errRepoCloneFailed"));
        return;
      }
      // Per-repo clone failures are soft (missing PAT, no vX.X.X tag, no root
      // SKILL.md) — the sync reports ok anyway. Verify the skill actually
      // materialized; if not, roll the URL back so it doesn't linger.
      const all = await api(`/users/${userId}/skills`).catch(() => []);
      const found = Array.isArray(all) && all.some(s =>
        (s.kind ? s.kind === "system" : s.system) && (s.dirName === expectedName || s.name === expectedName));
      if (!found) {
        await api("/admin/skill-repos", { method: "DELETE", body: JSON.stringify({ url }) }).catch(() => {});
        setError(t("skillEditor.errRepoCloneFailed"));
        return;
      }
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to add skill repo:", err);
      setError(err && err.message ? err.message : t("skillEditor.errRepoCloneFailed"));
    } finally {
      setBusy(false);
    }
  };

  // Multipart upload, so raw fetch instead of api() (which forces a JSON
  // content type) — same shape as installTemplateZip in Settings.
  const saveFromZip = async () => {
    setError(null);
    if (!zipFile) {
      setError(t("skillEditor.errZipRequired"));
      return;
    }
    setBusy(true);
    try {
      const endpoint = asSystemProp
        ? "/api/admin/skills/install-zip"
        : `/api/users/${encodeURIComponent(userId)}/skills/install-zip?userId=${encodeURIComponent(userId)}`;
      const post = (replace) => {
        const fd = new FormData();
        fd.append("file", zipFile);
        const sep = endpoint.includes("?") ? "&" : "?";
        return fetch(replace ? `${endpoint}${sep}replace=1` : endpoint, { method: "POST", body: fd });
      };
      let res = await post(false);
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (body.code !== "exists") {
          setError(body.error || t("skillEditor.errZipFailed"));
          return;
        }
        if (!window.confirm(t("skillEditor.replaceConfirm", { name: body.skillName || zipFile.name }))) return;
        res = await post(true);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to install skill from zip:", err);
      setError(err && err.message ? err.message : t("skillEditor.errZipFailed"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (repoMode) return saveFromRepo();
    if (zipMode) return saveFromZip();
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("skillEditor.errNameRequired"));
      return;
    }
    if (trimmedName.length > 64) {
      setError(t("skillEditor.errNameTooLong"));
      return;
    }
    if (!/^[a-z0-9-]+$/.test(trimmedName)) {
      setError(t("skillEditor.errNameFormat"));
      return;
    }
    if (trimmedName.startsWith("-") || trimmedName.endsWith("-") || trimmedName.includes("--")) {
      setError(t("skillEditor.errNameHyphens"));
      return;
    }
    if (!description.trim()) {
      setError(t("skillEditor.errDescriptionRequired"));
      return;
    }

    const target = asSystemProp ? "admin" : "user";
    setBusy(true);
    try {
      if (isEdit) {
        const url = target === "admin"
          ? `/admin/skills/${skillName}`
          : `/users/${userId}/skills/${skillName}`;
        await api(url, {
          method: "PUT",
          body: JSON.stringify({ description, content }),
        });
        if (target === "user" && sourceRepo && useTags !== origUseTags) {
          await api(`/users/${userId}/skill-repos/${skillName}`, {
            method: "PUT",
            body: JSON.stringify({ useTags, userId }),
          });
        }
      } else {
        const url = target === "admin"
          ? `/admin/skills`
          : `/users/${userId}/skills`;
        await api(url, {
          method: "POST",
          body: JSON.stringify({ name: trimmedName, description, content }),
        });
      }
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save skill:", err);
      setError(err && err.message ? err.message : t("skillEditor.errSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="alert-overlay" />
        <Dialog.Content className="modal-content extra-wide" style={{ zIndex: 103 }}>
          <Dialog.Title className="modal-title">
            {isView ? <Eye size={20} className="title-icon" /> : isEdit ? <Pencil size={20} className="title-icon" /> : <Plus size={20} className="title-icon" />}
            {isView ? t("skillEditor.titleView") : isEdit ? t("skillEditor.titleEdit") : t("skillEditor.titleNew")}
          </Dialog.Title>
          {modeSelectable && (
            <div className="modal-label" style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name="skill-create-mode"
                  checked={createMode === "manual"}
                  onChange={() => setCreateMode("manual")}
                  disabled={busy}
                />
                <span>{t("skillEditor.modeManual")}</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name="skill-create-mode"
                  checked={createMode === "repo"}
                  onChange={() => setCreateMode("repo")}
                  disabled={busy}
                />
                <span>{t("skillEditor.modeRepo")}</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name="skill-create-mode"
                  checked={createMode === "zip"}
                  onChange={() => setCreateMode("zip")}
                  disabled={busy}
                />
                <span>{t("skillEditor.modeZip")}</span>
              </label>
            </div>
          )}
          {!repoMode && !zipMode && (
            <>
              <label className="modal-label">
                {t("skillEditor.name")}
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isEdit || isView}
                  placeholder={t("skillEditor.namePlaceholder")}
                  className="modal-input"
                />
              </label>
              <label className="modal-label">
                {t("skillEditor.description")}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("skillEditor.descPlaceholder")}
                  rows={2}
                  className="modal-textarea"
                  readOnly={isView}
                />
              </label>
              <label className="modal-label">
                {t("skillEditor.instructions")}
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={t("skillEditor.instrPlaceholder")}
                  rows={12}
                  className="modal-textarea mono"
                  readOnly={isView}
                />
              </label>
              {sourceRepo && (
                <>
                  <div className="modal-label">
                    {t("skillEditor.sourceRepo")}
                    <div style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all" }}>
                      {sourceRepo.url}
                    </div>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={useTags}
                      onChange={(e) => setUseTags(e.target.checked)}
                      disabled={isView || busy}
                    />
                    <span>{t("skillEditor.useTags")}</span>
                  </label>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {t("skillEditor.sourceRepoHint")}
                  </div>
                </>
              )}
            </>
          )}
          {repoMode && (
            <>
              <label className="modal-label">
                {t("skillEditor.repoUrl")}
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder={t("skillEditor.repoUrlPlaceholder")}
                  className="modal-input"
                  disabled={busy}
                />
              </label>
              {repoSkillName(repoUrl) && (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {t("skillEditor.repoDerivedName", { name: repoSkillName(repoUrl) })}
                </div>
              )}
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {t(asSystemProp ? "skillEditor.repoHint" : "skillEditor.repoHintUser")}
              </div>
            </>
          )}
          {zipMode && (
            <>
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  e.target.value = "";
                  if (f) setZipFile(f);
                }}
              />
              <button
                className="btn-secondary"
                style={{ alignSelf: "flex-start" }}
                onClick={() => zipInputRef.current && zipInputRef.current.click()}
                disabled={busy}
              >
                <Upload size={14} /> {zipFile ? zipFile.name : t("skillEditor.zipChoose")}
              </button>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {t("skillEditor.zipHint")}
              </div>
            </>
          )}
          {error && (
            <div className="skill-editor-error" role="alert">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
          <div className="modal-actions">
            {!isView && (
              <button className="btn-primary" onClick={save} disabled={busy || (zipMode && !zipFile)}>
                {busy ? <RefreshCw size={14} className="spin" /> : <Save size={14} />} {t("common.save")}
              </button>
            )}
            <Dialog.Close asChild>
              <button className="btn-secondary">
                <X size={14} /> {isView ? t("common.close") : t("common.cancel")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Project lock UI ─────────────────────────────────────────
// Modal shown when this tab tries to open a project that's already held by
// another tab in the same browser. User chooses Cancel (drop the switch) or
// Open here (force takeover).
function ProjectLockConflictDialog() {
  const { state, confirmTakeover, cancelTakeover, t } = useContext(AppContext);
  const open = state.projectLockState === "prompt-conflict";
  const pending = state.pendingProjectSelection;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) cancelTakeover(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="alert-overlay" />
        <Dialog.Content className="alert-content">
          <Dialog.Title className="alert-title">
            <AlertTriangle size={18} style={{ color: "var(--accent)" }} />
            {t("projectLock.conflictTitle")}
          </Dialog.Title>
          <div className="alert-description">
            {t("projectLock.conflictMessage", { name: pending?.name || "" })}
          </div>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={cancelTakeover}>{t("common.cancel")}</button>
            <button className="btn-primary" onClick={confirmTakeover}>{t("projectLock.openHere")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Full-pane overlay shown when another tab took the active project from
// this one. Blocks interaction until the user reclaims or switches.
function ProjectLockTakenOverOverlay() {
  const { state, reclaimProject, dispatch, t } = useContext(AppContext);
  if (state.projectLockState !== "taken-over") return null;
  const switchProject = () => dispatch({ type: "CLEAR_PROJECT" });
  return (
    <div className="project-lock-overlay" role="alertdialog" aria-modal="true">
      <div className="project-lock-overlay-card">
        <div className="project-lock-overlay-icon">
          <Lock size={36} />
        </div>
        <div className="project-lock-overlay-title">{t("projectLock.takenOverTitle")}</div>
        <div className="project-lock-overlay-body">{t("projectLock.takenOverMessage")}</div>
        <div className="modal-actions" style={{ justifyContent: "center" }}>
          <button className="btn-secondary" onClick={switchProject}>{t("projectLock.switchProject")}</button>
          <button className="btn-primary" onClick={reclaimProject}>{t("projectLock.retake")}</button>
        </div>
      </div>
    </div>
  );
}

// Modal shown when this user tries to open a project that's currently being
// worked on by ANOTHER user. Owner gets a "Take over" button; recipients get
// Cancel only.
function ServerLockInUseDialog() {
  const { state, takeOverFromOtherUser, cancelServerLockHeld, t } = useContext(AppContext);
  const open = state.projectLockState === "server-in-use";
  const holder = state.serverLockHolder;
  const pending = state.pendingProjectSelection;
  // Owner detection: the project entry's `isLink` is false/undefined for
  // owners and true for recipients (set by linkProject).
  const projectEntry = state.projects.find(p => p.id === pending?.id);
  const isOwner = !!projectEntry && !projectEntry.isLink;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) cancelServerLockHeld(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="alert-overlay" />
        <Dialog.Content className="alert-content">
          <Dialog.Title className="alert-title">
            <AlertTriangle size={18} style={{ color: "var(--accent)" }} />
            {t("projectLock.inUse.title")}
          </Dialog.Title>
          <div className="alert-description">
            {t("projectLock.inUse.message", {
              displayName: holder?.displayName || "another user",
              email: holder?.email || "",
              project: pending?.name || "",
            })}
          </div>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={cancelServerLockHeld}>{t("projectLock.inUse.cancel")}</button>
            {isOwner && (
              <button className="btn-primary" onClick={takeOverFromOtherUser}>{t("projectLock.inUse.takeOver")}</button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Full-pane overlay shown when another USER (the owner) forcibly took the
// project lock from us. Same shape as ProjectLockTakenOverOverlay but driven
// by the server-side `lock_taken_over` SSE event.
function ServerLockTakenOverOverlay() {
  const { state, retakeServerLock, dispatch, releaseServerLock, t } = useContext(AppContext);
  if (state.projectLockState !== "server-taken-over") return null;
  const switchProject = () => {
    if (state.currentProjectId) releaseServerLock(state.currentProjectId);
    dispatch({ type: "CLEAR_PROJECT" });
  };
  const holder = state.serverLockHolder;
  // Same owner-detection logic as ServerLockInUseDialog: a recipient can
  // request a plain re-acquire (succeeds only if the new holder released);
  // the owner can force-take.
  const projectEntry = state.projects.find(p => p.id === state.currentProjectId);
  const isOwner = !!projectEntry && !projectEntry.isLink;
  return (
    <div className="project-lock-overlay" role="alertdialog" aria-modal="true">
      <div className="project-lock-overlay-card">
        <div className="project-lock-overlay-icon">
          <Lock size={36} />
        </div>
        <div className="project-lock-overlay-title">{t("projectLock.takenOverByOther.title")}</div>
        <div className="project-lock-overlay-body">
          {t("projectLock.takenOverByOther.message", { displayName: holder?.displayName || "another user" })}
        </div>
        <div className="modal-actions" style={{ justifyContent: "center" }}>
          <button className="btn-secondary" onClick={switchProject}>{t("projectLock.takenOverByOther.switch")}</button>
          <button className="btn-primary" onClick={retakeServerLock} disabled={!isOwner && !!holder}>
            {t("projectLock.takenOverByOther.retake")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────
function LoginScreen({ t }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [options, setOptions] = useState({ local: true, oauth: false, needsFirstUser: false });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/auth/login-options")
      .then((r) => r.json())
      .then((o) => setOptions({
        local: o?.local !== false,
        oauth: o?.oauth === true,
        needsFirstUser: o?.needsFirstUser === true,
      }))
      .catch(() => { /* keep defaults */ })
      .finally(() => setLoaded(true));
  }, []);

  const onSubmitLogin = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/auth/login-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 204) {
        window.location.reload();
        return;
      }
      if (res.status === 429) {
        setError(t("login.rateLimited") || "Too many attempts. Try again shortly.");
      } else {
        setError(t("login.invalidCredentials") || "Invalid username or password");
      }
    } catch {
      setError(t("login.invalidCredentials") || "Invalid username or password");
    } finally {
      setBusy(false);
    }
  };

  const onSubmitSetup = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/auth/setup-first-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, firstName, lastName, email }),
      });
      if (res.status === 204) {
        window.location.reload();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body?.error || t("login.setupFailed") || "Setup failed");
    } catch {
      setError(t("login.setupFailed") || "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)" }} />
    );
  }

  if (options.needsFirstUser) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)" }}>
        <div className="modal-content" style={{ width: 420, maxWidth: "90vw" }}>
          <div className="modal-title" style={{ marginBottom: 8 }}>
            <Users size={20} className="title-icon" />
            {t("login.setupTitle") || "Set up your first user"}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
            {t("login.setupSubtitle") || "No users exist yet. The account you create here becomes the workspace administrator."}
          </div>
          <form onSubmit={onSubmitSetup}>
            <label className="modal-label">
              {t("users.dialog.field.firstName") || "First name"}
              <input className="modal-input" autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={busy} />
            </label>
            <label className="modal-label">
              {t("users.dialog.field.lastName") || "Last name"}
              <input className="modal-input" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={busy} />
            </label>
            <label className="modal-label">
              {t("users.dialog.field.email") || "Email"}
              <input className="modal-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            </label>
            <label className="modal-label">
              {t("login.username") || "Username"}
              <input className="modal-input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
            </label>
            <label className="modal-label">
              {t("login.password") || "Password"}
              <input className="modal-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            </label>
            {error && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>{error}</div>}
            <div className="modal-buttons" style={{ marginTop: 12 }}>
              <button type="submit" className="btn-primary" disabled={busy || !username || !password} style={{ flex: 1 }}>
                {t("login.setupSubmit") || "Create account"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)" }}>
      <div className="modal-content" style={{ width: 360, maxWidth: "90vw" }}>
        <div className="modal-title" style={{ marginBottom: 16 }}>
          <LogOut size={20} className="title-icon" style={{ transform: "rotate(180deg)" }} />
          {t("login.title") || "Sign in"}
        </div>
        <form onSubmit={onSubmitLogin}>
          <label className="modal-label">
            {t("login.username") || "Username"}
            <input className="modal-input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
          </label>
          <label className="modal-label">
            {t("login.password") || "Password"}
            <input className="modal-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </label>
          {error && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>{error}</div>}
          <div className="modal-buttons" style={{ marginTop: 12 }}>
            <button type="submit" className="btn-primary" disabled={busy || !username || !password} style={{ flex: 1 }}>
              {t("login.submit") || "Sign in"}
            </button>
          </div>
        </form>
        {options.oauth && (
          <>
            <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 12, margin: "16px 0 8px" }}>—</div>
            <button className="btn-secondary" style={{ width: "100%" }} onClick={() => { window.location.href = "/auth/login"; }} disabled={busy}>
              {t("login.signInWithMicrosoft") || "Sign in with Microsoft"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [userId, setUserId] = useLocalStorage("vca-userId", null);
  // Stable per-tab id so reload keeps the same identity (sessionStorage is
  // tab-scoped). Drives the project-lock BroadcastChannel handshake.
  const tabId = useMemo(() => {
    let id = sessionStorage.getItem("vca-tabId");
    if (!id) {
      id = (window.crypto?.randomUUID?.() || `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      sessionStorage.setItem("vca-tabId", id);
    }
    return id;
  }, []);
  // Project lock (single-tab-per-project). Registered here — before any
  // effect that calls selectProject — so the BroadcastChannel is open by
  // the time the restore-on-reload effect fires.
  const { requestAcquire, forceTakeover, releaseLock } = useProjectLock(tabId, dispatch);
  const [authUser, setAuthUser] = useState(null); // { userId, displayName, email } when logged in via Entra
  const [needsLogin, setNeedsLogin] = useState(false);
  // Bumped whenever the SessionExpiredDialog popup-login flow succeeds.
  // Plumbed into useSSE's dep array so the EventSource closes and reopens
  // with the fresh session_id cookie instead of relying on browser-specific
  // EventSource auto-reconnect behaviour after a 401.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  useEffect(() => {
    const onRestored = () => setSessionEpoch((e) => e + 1);
    window.addEventListener("vca-session-restored", onRestored);
    return () => window.removeEventListener("vca-session-restored", onRestored);
  }, []);
  // A 409 PROJECT_LOCK_NOT_HELD surfaced from any mutation flips us into the
  // bumped overlay. Belt-and-suspenders for the brief race between takeover
  // and the SSE lock_taken_over event reaching us.
  useEffect(() => {
    const onBumped = (e) => {
      dispatch({ type: "SERVER_LOCK_BUMPED", newHolder: e.detail?.holder || null });
    };
    window.addEventListener("vca-project-lock-bumped", onBumped);
    return () => window.removeEventListener("vca-project-lock-bumped", onBumped);
  }, []);
  // Release the server-side project lock on tab close. sendBeacon is the
  // only fetch-style call guaranteed to complete during page unload.
  // SSE disconnect would catch this too, but the 20s grace period means
  // another user would otherwise wait — sendBeacon shaves that down.
  useEffect(() => {
    const onUnload = () => {
      const pid = state.currentProjectId;
      if (!pid || !userId) return;
      try {
        const blob = new Blob([JSON.stringify({ userId })], { type: "application/json" });
        navigator.sendBeacon(`/api/projects/${encodeURIComponent(pid)}/lock/release`, blob);
      } catch { /* best-effort */ }
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [state.currentProjectId, userId]);
  // Settings menu values live server-side in admin/vca-settings.json. App
  // init pulls the non-secret view from /api/vca-settings; the Settings
  // dialog (admin-only) reads + writes the full record via the /admin/
  // endpoints. Secrets (apiKey, imageApiKey, devopsPat) are intentionally
  // never carried in browser state — chat requests send empty strings and
  // the backend fills them from the stored settings.
  const [apiKey, setApiKey] = useState("");
  const [theme, setTheme] = useState("light");
  const [lang, setLang] = useState("en");
  const t = useMemo(() => window.__vca_i18n.createT(lang), [lang]);

  const [llmProvider, setLlmProvider] = useState("");
  const [llmModelId, setLlmModelId] = useState("");
  const [llmEndpoint, setLlmEndpoint] = useState("");
  const [llmApiVersion, setLlmApiVersion] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("medium");

  // Effective LLM config of the currently-viewed chat's live session, as the
  // agent may have changed it mid-run via set_llm_config. Distinct from the
  // GLOBAL thinkingLevel pref / active-profile pointer so a per-chat switch is
  // shown in the sidebar controls WITHOUT clobbering the persisted defaults.
  // null (or null fields) ⇒ the controls fall back to the global values. Set on
  // chat open / SSE reconnect and on the llm_config_changed event; cleared when
  // switching chats or on a manual global change.
  const [sessionConfig, setSessionConfig] = useState(null);

  // Image generation: provider/model/key, shaped like the LLM config.
  const [imageProvider, setImageProvider] = useState("google");
  const [imageModelId, setImageModelId] = useState("gemini-3.1-flash-image-preview");
  const [imageApiKey, setImageApiKey] = useState("");

  // Track hydration so the per-user-prefs autosave below doesn't fire on the
  // very first render and overwrite the stored values with React defaults.
  const userPrefsHydratedRef = useRef(false);

  // Hydrate deployment-wide LLM/DevOps display values from the server. Public
  // view = no secrets; admins refresh again on Settings open to get the
  // redacted-secret form values.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api("/vca-settings");
        if (cancelled || !r || !r.settings) return;
        const s = r.settings;
        if (typeof s.llmProvider === "string") setLlmProvider(s.llmProvider);
        if (typeof s.llmModelId === "string") setLlmModelId(s.llmModelId);
        if (typeof s.llmEndpoint === "string") setLlmEndpoint(s.llmEndpoint);
        if (typeof s.llmApiVersion === "string") setLlmApiVersion(s.llmApiVersion);
        if (typeof s.imageProvider === "string") setImageProvider(s.imageProvider);
        if (typeof s.imageModelId === "string") setImageModelId(s.imageModelId);
      } catch { /* fall back to component defaults */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Hydrate per-user prefs (theme, lang, thinkingLevel) from
  // <userId>/user-prefs.json each time we know the userId. Marks hydration
  // complete so the autosave effect doesn't fire on the initial defaults.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    userPrefsHydratedRef.current = false;
    (async () => {
      try {
        const r = await api(`/users/${encodeURIComponent(userId)}/prefs`);
        if (cancelled) return;
        const p = r?.prefs || {};
        if (typeof p.theme === "string") setTheme(p.theme);
        if (typeof p.lang === "string") setLang(p.lang);
        if (typeof p.thinkingLevel === "string") setThinkingLevel(p.thinkingLevel);
      } catch { /* fall back to component defaults */ }
      finally { userPrefsHydratedRef.current = true; }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Autosave per-user prefs on change. Debounced so a slider that fires many
  // updates collapses into one network call.
  useEffect(() => {
    if (!userId || !userPrefsHydratedRef.current) return;
    const handle = setTimeout(() => {
      api(`/users/${encodeURIComponent(userId)}/prefs`, {
        method: "PUT",
        body: JSON.stringify({ theme, lang, thinkingLevel }),
      }).catch((err) => console.warn("[user-prefs] failed to persist:", err));
    }, 300);
    return () => clearTimeout(handle);
  }, [userId, theme, lang, thinkingLevel]);

  const [serverConfig, setServerConfig] = useState(null);

  const { onboardingStep, advanceOnboarding, dismissOnboarding } = useOnboarding();

  const [showSettings, setShowSettings] = useState(false);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [showNotConfigured, setShowNotConfigured] = useState(false);
  // Session-scoped, not localStorage: a dismissed wizard shouldn't reappear in
  // the same tab, but an admin who still has no LLM on the next launch really
  // should be offered it again.
  const setupSkippedRef = useRef(typeof sessionStorage !== "undefined" && sessionStorage.getItem("vca-setup-skipped") === "1");
  const [showNewProject, setShowNewProject] = useState(false);
  const [showProjectsGallery, setShowProjectsGallery] = useState(false);
  const [showCommits, setShowCommits] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [pendingScreenshot, setPendingScreenshot] = useState(null);
  const addScreenshotAttachment = useCallback((dataUrl) => setPendingScreenshot(dataUrl), []);
  const clearPendingScreenshot = useCallback(() => setPendingScreenshot(null), []);
  const [showDeploy, setShowDeploy] = useState(false);
  const [architectMode, setArchitectMode] = useState(false);
  const [showArchitect, setShowArchitect] = useState(false);
  useEffect(() => {
    if (architectMode) {
      setShowArchitect(true);
    } else {
      const timer = setTimeout(() => setShowArchitect(false), 700);
      return () => clearTimeout(timer);
    }
  }, [architectMode]);
  const [deployStatus, setDeployStatus] = useState(null);
  const [useCaseMermaid, setUseCaseMermaid] = useState("");
  const [useCasePulse, setUseCasePulse] = useState(false);
  const [deploymentMermaid, setDeploymentMermaid] = useState("");
  const [deploymentPulse, setDeploymentPulse] = useState(false);
  const [componentMermaid, setComponentMermaid] = useState("");
  const [componentPulse, setComponentPulse] = useState(false);
  const [activityPulse, setActivityPulse] = useState(false);
  const [erPulse, setERPulse] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [contextUsage, setContextUsage] = useState(null);
  const [tokenStats, setTokenStats] = useState(null);
  // Lifetime LLM spend of the current project; seeded by the SSE connect
  // snapshot, updated by project_cost broadcasts. Reset on project switch
  // (consolidated per-project reset effect below, after reloadDiagrams).
  const [projectCost, setProjectCost] = useState(null);
  const [devFocus, setDevFocus] = useState(null); // { name, diagramType }
  const userdataNotesRef = useRef([]);
  // Stale-response fence for reloadDiagrams: holds the projectId the UI is
  // currently on; diagram fetches that resolve after a switch are dropped.
  const diagramsPidRef = useRef(null);
  const [gitRemoteConfigured, setGitRemoteConfigured] = useState(false);
  const [lastProjectId, setLastProjectId] = useLocalStorage("vca-lastProjectId", null);
  const [lastProjectName, setLastProjectName] = useLocalStorage("vca-lastProjectName", "");
  const [sidebarHandlePulse, setSidebarHandlePulse] = useState(null);

  const iframeRef = useRef(null);
  const captureScreenshotRef = useRef(null);
  // Populated by PreviewPane with the agent-triggered capture (screenshot
  // tool); called from the screenshot_request SSE handler.
  const agentScreenshotRef = useRef(null);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme]);

  // Fetch app config. Exposed via context as `reloadServerConfig` so the
  // Settings dialog can flip `llmConfigured` to true the moment a provider
  // is saved — without it, the gate that routes "Create new project" back
  // to Settings would stay armed even after the admin finishes configuring.
  const reloadServerConfig = useCallback(async () => {
    try {
      const cfg = await api("/config");
      setServerConfig(cfg);
    } catch {
      setServerConfig({ llm: { mode: "user-key", provider: "", modelId: "", displayName: "" }, containerApp: { configured: false }, google: { configured: false } });
    }
  }, []);
  useEffect(() => {
    reloadServerConfig();
  }, [reloadServerConfig]);
  const serverManaged = serverConfig?.llm?.mode === "server-configured";
  // True when the backend has working LLM credentials — either AZURE env
  // vars or an apiKey persisted in admin Settings. Used to skip the
  // "open Settings on missing key" auto-redirect now that the keys live
  // server-side.
  const llmConfigured = serverConfig?.llm?.configured === true;
  const imageServerManaged = serverConfig?.image?.serverManaged === true;
  const imageConfigured = serverConfig?.image?.configured === true;
  const authEnabled = serverConfig?.auth?.enabled === true;
  // Admin status is always decided by the server-side session (vca-groups
  // membership). No "auth disabled → everyone admin" shortcut any more —
  // VCA always requires a real login.
  const isAdmin = authUser?.isAdmin === true;

  // Explicit "configure the LLM now" — from Send, or the Settings button.
  // Bypasses the session skip flag, since this is the user asking for it.
  // Declared here rather than next to the auto-open effect below because
  // handleSend closes over it.
  const openSetup = useCallback(() => {
    if (!isAdmin) { setShowNotConfigured(true); return; }
    setupSkippedRef.current = false;
    try { sessionStorage.removeItem("vca-setup-skipped"); } catch { /* private mode */ }
    setShowSettings(false);
    setShowSetupWizard(true);
  }, [isAdmin]);

  const skipSetup = useCallback(() => {
    setupSkippedRef.current = true;
    try { sessionStorage.setItem("vca-setup-skipped", "1"); } catch { /* private mode */ }
    setShowSetupWizard(false);
  }, []);

  // Resolve the current user. VCA always requires a real session — when no
  // session is present (or it can't be refreshed), the LoginScreen takes over
  // and offers local sign-in, Entra SSO (if OAuth is enabled), or first-user
  // setup when the workspace is brand-new.
  useEffect(() => {
    if (serverConfig === null) return; // wait for config
    const tryMe = async () => {
      try {
        const r = await fetch("/auth/me");
        const user = await r.json();
        if (user) return user;
      } catch { /* fall through */ }
      return null;
    };
    (async () => {
      let user = await tryMe();
      if (!user && authEnabled) {
        // Stale or missing cookie but Entra may still know us — silent SSO.
        const reauthed = await silentReauth();
        if (reauthed) user = await tryMe();
      }
      if (user) {
        setAuthUser(user);
        setUserId(user.userId);
      } else {
        setNeedsLogin(true);
      }
    })();
  }, [serverConfig]);

  // Keep-alive ping: while the tab is visible and auth is enabled, ask the
  // backend to renew the server-side OAuth tokens and slide the session cookie.
  useEffect(() => {
    if (!authEnabled) return;
    let cancelled = false;
    const ping = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      refreshAuthSession().catch(() => { /* silent */ });
    };
    ping();
    const id = setInterval(ping, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", ping);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [authEnabled]);

  // Load projects
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const autoOpenedGalleryRef = useRef(false);
  const loadProjects = useCallback(async () => {
    if (!userId) return;
    try {
      const projects = await api(`/users/${userId}/projects`);
      dispatch({ type: "SET_PROJECTS", projects });
      setProjectsLoaded(true);
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }, [userId]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // Auto-clear the chat sidebar handle pulse: 3s when the sidebar is open,
  // otherwise it persists until the user opens the sidebar.
  useEffect(() => {
    if (!sidebarHandlePulse) return;
    if (state.sidebarOpen) {
      const t = setTimeout(() => setSidebarHandlePulse(null), 3000);
      return () => clearTimeout(t);
    }
  }, [sidebarHandlePulse, state.sidebarOpen]);

  // Auto-open the projects gallery once when a user has no projects yet,
  // so they can see where to create one. Suppress while LLM isn't configured
  // — the Settings auto-open below takes the foreground instead, and the
  // gallery would just be a second modal the user has to dismiss before
  // they can configure a provider.
  useEffect(() => {
    if (!projectsLoaded) return;
    if (autoOpenedGalleryRef.current) return;
    if (!llmConfigured) return;
    if (state.projects.length === 0) {
      autoOpenedGalleryRef.current = true;
      setShowProjectsGallery(true);
    }
  }, [projectsLoaded, state.projects.length, llmConfigured]);

  // Restore last selected project on reload, or honor a `?projectid=<uuid>`
  // deep link if present in the URL. The param is consumed once (stripped
  // from the address bar via replaceState) and stashed in a ref so we can
  // wait for `projectsLoaded` before resolving it against the user's list.
  const pendingDirectLinkRef = useRef(undefined); // undefined = not read yet, null = none/invalid, string = uuid to open
  // A brand-new tab/window starts blank with the gallery open; a reload of an
  // existing tab still restores the last project (sessionStorage survives
  // reload but not a fresh tab), so reload-during-an-agent-run can resume.
  // wasFreshTabRef is sticky for the component's lifetime — we read the marker
  // on first run and ignore later sessionStorage state.
  const wasFreshTabRef = useRef(undefined);
  const galleryShownOnFreshTabRef = useRef(false);
  useEffect(() => {
    if (!userId || state.currentProjectId) return;

    if (wasFreshTabRef.current === undefined) {
      wasFreshTabRef.current = sessionStorage.getItem("vca-tab-initialized") !== "1";
      sessionStorage.setItem("vca-tab-initialized", "1");
    }

    if (pendingDirectLinkRef.current === undefined) {
      const url = new URL(window.location.href);
      const rawParam = url.searchParams.get("projectid");
      if (rawParam !== null) {
        url.searchParams.delete("projectid");
        const qs = url.searchParams.toString();
        window.history.replaceState({}, "", url.pathname + (qs ? `?${qs}` : "") + url.hash);
      }
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      pendingDirectLinkRef.current = rawParam && UUID_RE.test(rawParam) ? rawParam : null;
    }

    const targetId = pendingDirectLinkRef.current;
    if (targetId) {
      if (!projectsLoaded) return; // resolve once projects arrive
      pendingDirectLinkRef.current = null;
      const match = state.projects.find((p) => p.id === targetId);
      if (match) {
        selectProject(match.id, match.name);
        return;
      }
      console.warn(`[VCA] Direct link projectid=${targetId} not in user's project list — opening gallery`);
      setShowProjectsGallery(true);
      return;
    }

    if (wasFreshTabRef.current) {
      if (!galleryShownOnFreshTabRef.current && llmConfigured) {
        galleryShownOnFreshTabRef.current = true;
        setShowProjectsGallery(true);
      }
      return;
    }

    if (lastProjectId) {
      selectProject(lastProjectId, lastProjectName);
    }
  }, [userId, lastProjectId, projectsLoaded, llmConfigured]);

  const [previewState, setPreviewState] = useState(EMPTY_PREVIEW_STATE);
  const loadedPreviewInstanceRef = useRef(null);

  const loadPreview = useCallback((projectId = state.currentProjectId) => {
    if (!projectId || !iframeRef.current || !userId) return;
    iframeRef.current.src = "about:blank";
    setTimeout(() => {
      if (!iframeRef.current) return;
      iframeRef.current.src = `/preview/${userId}/${projectId}/index.html?t=${Date.now()}`;
    }, 50);
  }, [state.currentProjectId, userId]);

  // Refresh preview
  const refreshPreview = useCallback(() => {
    loadPreview(state.currentProjectId);
  }, [loadPreview, state.currentProjectId]);

  const applyPreviewState = useCallback((nextState) => {
    setPreviewState(nextState);
    const currentKey = state.currentProjectId && userId ? `${userId}:${state.currentProjectId}` : null;
    if (!currentKey || nextState.projectKey !== currentKey) return;

    if (nextState.status === "running" && nextState.instanceId) {
      if (loadedPreviewInstanceRef.current !== nextState.instanceId) {
        loadedPreviewInstanceRef.current = nextState.instanceId;
        loadPreview(state.currentProjectId);
      }
      return;
    }

    if (nextState.status === "crashed") {
      loadedPreviewInstanceRef.current = null;
      loadPreview(state.currentProjectId);
      return;
    }

    if (nextState.status !== "running") {
      loadedPreviewInstanceRef.current = null;
    }
  }, [state.currentProjectId, userId, loadPreview]);

  const ensurePreviewRunning = useCallback(async (projectId) => {
    if (!projectId || !userId) return null;
    try {
      const data = await api(`/projects/${projectId}/ensure-preview-running?userId=${encodeURIComponent(userId)}`, { method: "POST" });
      const { logs, ...nextState } = data;
      applyPreviewState(nextState);
      if (nextState.status === "running" && nextState.instanceId) {
        loadedPreviewInstanceRef.current = nextState.instanceId;
        loadPreview(projectId);
      }
      return { logs, ...nextState };
    } catch (err) {
      console.error("[VCA] Failed to ensure preview is running:", err);
      return null;
    }
  }, [userId, applyPreviewState]);

  // Reload messages from server
  const reloadMessages = useCallback(async () => {
    if (!state.currentProjectId || !state.currentChatId || !userId) return;
    try {
      const messages = await api(`/projects/${state.currentProjectId}/messages?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(state.currentChatId)}`);
      const parsed = parsePersistedMessages(messages);
      dispatch({ type: "SET_MESSAGES", messages: parsed });
    } catch (err) {
      console.error("[VCA] Failed to reload messages:", err);
    }
  }, [state.currentProjectId, state.currentChatId, userId]);

  // Deploy status — per-project ACA deploy was removed; keep the callback as
  // a stable no-op so callers (Project Info dialog, post-save handlers) still
  // resolve without firing a doomed network request.
  const refreshDeployStatus = useCallback(async () => {
    setDeployStatus(null);
  }, []);

  // Git remote status
  const refreshGitRemoteStatus = useCallback(async () => {
    if (!state.currentProjectId || !userId) { setGitRemoteConfigured(false); return; }
    try {
      const r = await api(`/projects/${state.currentProjectId}/git-remote-status?userId=${userId}`);
      setGitRemoteConfigured(r.configured);
    } catch { setGitRemoteConfigured(false); }
  }, [state.currentProjectId, userId]);

  // Server log lines (collected via SSE for the process info panel)
  const [serverLogLines, setServerLogLines] = useState([]);
  // Pulse state for the right-sidebar toggle: null | "warn" | "error"
  const [serverLogPulse, setServerLogPulse] = useState(null);

  // Project creation step progress (received via SSE from backend)
  const [projectSteps, setProjectSteps] = useState({});
  const [projectLogs, setProjectLogs] = useState({});

  // SSE
  useSSE(state.currentProjectId, state.currentChatId, userId, sessionEpoch, dispatch, refreshPreview, setUseCaseMermaid, setUseCasePulse, setDeploymentMermaid, setDeploymentPulse, setComponentMermaid, setComponentPulse, setActivityPulse, setERPulse, setContextUsage, setTokenStats, setServerLogLines, setServerLogPulse, setProjectSteps, setProjectLogs, applyPreviewState, setProjectCost, agentScreenshotRef, setSessionConfig);

  // Auto-clear the server-log pulse: warn always after 3s; error after 3s
  // when the sidebar is open, otherwise persists until the user opens it.
  useEffect(() => {
    if (!serverLogPulse) return;
    if (serverLogPulse === "warn" || state.rightSidebarOpen) {
      const t = setTimeout(() => setServerLogPulse(null), 3000);
      return () => clearTimeout(t);
    }
  }, [serverLogPulse, state.rightSidebarOpen]);

  const reloadDiagrams = useCallback(async (id) => {
    const pid = id || state.currentProjectId;
    if (!pid) return;
    // Fence: a response landing after the user switched or closed the project
    // must not clobber the new project's state — the diagram text is prepended
    // to every prompt, so a stale write here would leak one project's content
    // into another project's chat history.
    const fresh = () => diagramsPidRef.current === pid;
    try {
      const ucData = await api(`/projects/${pid}/usecase?userId=${userId}`);
      if (fresh()) setUseCaseMermaid(generateUseCaseMermaid(ucData));
    } catch { if (fresh()) setUseCaseMermaid(""); }
    try {
      const depData = await api(`/projects/${pid}/deployment?userId=${userId}`);
      if (fresh()) setDeploymentMermaid(generateUseCaseMermaid(depData));
    } catch { if (fresh()) setDeploymentMermaid(""); }
    try {
      const compData = await api(`/projects/${pid}/component?userId=${userId}`);
      if (fresh()) setComponentMermaid(generateUseCaseMermaid(compData));
    } catch { if (fresh()) setComponentMermaid(""); }
  }, [state.currentProjectId, userId]);

  // Per-project chat context reset. Everything handleSend folds into the
  // prompt (use-case/deployment diagram mermaid, dev focus, userdata notes)
  // plus per-project attachment/telemetry state must die on ANY project
  // switch or close — the prompt text is persisted as the user message, so a
  // single send carrying stale state would permanently bake project A's
  // context into project B's chat history. Keyed on currentProjectId so every
  // switch path (all SELECT_PROJECT and CLEAR_PROJECT dispatches) funnels
  // through this one reset; clearing happens BEFORE the diagram fetch starts,
  // so there is no window where the previous project's diagrams ride along.
  useEffect(() => {
    diagramsPidRef.current = state.currentProjectId; // invalidate in-flight reloads
    setUseCaseMermaid("");
    setDeploymentMermaid("");
    setComponentMermaid("");
    setDevFocus(null);
    userdataNotesRef.current = [];
    setPendingScreenshot(null);
    setContextUsage(null);
    setTokenStats(null);
    setProjectCost(null);
    if (state.currentProjectId) reloadDiagrams(state.currentProjectId);
  }, [state.currentProjectId, reloadDiagrams]);

  // Body of project switch (no lock handling). Used by both the normal
  // selectProject path and the "Open here" conflict-confirm path.
  const performSelectProject = useCallback(async (id, name) => {
    dispatch({ type: "SELECT_PROJECT", id, name });
    setLastProjectId(id);
    setLastProjectName(name);
    setServerLogLines([]);
    setPreviewState(EMPTY_PREVIEW_STATE);
    loadedPreviewInstanceRef.current = null;
    // Clear preview immediately — SSE files_changed will refresh once new server is ready
    if (iframeRef.current) iframeRef.current.src = "about:blank";
    loadProjects();

    setDeployStatus(null);

    // Load git remote status
    try {
      const r = await api(`/projects/${id}/git-remote-status?userId=${userId}`);
      setGitRemoteConfigured(r.configured);
    } catch { setGitRemoteConfigured(false); }

    // Diagram loading lives in the per-project reset effect (clear-then-
    // fetch, keyed on currentProjectId). Only a re-select of the already-open
    // project — where that effect won't re-fire — needs an explicit refresh.
    // (Inside this callback, state.currentProjectId is the pre-dispatch value.)
    if (id === state.currentProjectId) reloadDiagrams(id);

    // Load chats (server auto-creates chat-1 if none exist; legacy
    // .vca-messages.json is migrated lazily). Activate the rightmost tab.
    let activeChatId = null;
    try {
      const chats = await api(`/projects/${id}/chats?userId=${encodeURIComponent(userId)}`);
      dispatch({ type: "SET_CHATS", chats });
      if (chats.length > 0) {
        activeChatId = chats[chats.length - 1].id;
        dispatch({ type: "SELECT_CHAT", chatId: activeChatId });
      }
    } catch (err) {
      console.error("[VCA] Failed to load chats:", err);
    }

    // Load message history for the active chat
    if (activeChatId) {
      try {
        const messages = await api(`/projects/${id}/messages?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(activeChatId)}`);
        if (messages.length) {
          // keepStreamingTail: this runs on page-reload restore; if the agent is
          // mid-turn, the SSE stream_resume may have already rebuilt the live
          // placeholder before this history lands — preserve it instead of wiping.
          dispatch({ type: "SET_MESSAGES", messages: parsePersistedMessages(messages), keepStreamingTail: true });
        }
      } catch (err) {
        console.error("[VCA] Failed to load message history:", err);
      }
    }

    await ensurePreviewRunning(id);
  }, [userId, state.currentProjectId, loadProjects, reloadDiagrams, ensurePreviewRunning]);

  // Cross-user server lock helpers. The server lock is canonical (keyed by
  // the project's owner) so it covers shares. Acquire returns 409 with the
  // current holder when another user is working on the project; release is
  // idempotent and fire-and-forget.
  const releaseServerLock = useCallback((projectId) => {
    if (!projectId) return;
    api(`/projects/${encodeURIComponent(projectId)}/lock/release`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }).catch(() => {});
  }, [userId]);

  const acquireServerLock = useCallback(async (projectId, projectName) => {
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/lock`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      return { ok: true };
    } catch (err) {
      if (err?.status === 409 && err?.body?.holder) {
        dispatch({
          type: "SERVER_LOCK_HELD",
          holder: err.body.holder,
          projectId,
          projectName: projectName || "",
        });
        return { ok: false, holder: err.body.holder };
      }
      throw err;
    }
  }, [userId]);

  const takeOverServerLock = useCallback(async (projectId) => {
    return api(`/projects/${encodeURIComponent(projectId)}/lock/take-over`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }, [userId]);

  // Select project — runs the BroadcastChannel acquire handshake first,
  // then the server-side cross-user acquire, then loads the project.
  const selectProject = useCallback(async (id, name) => {
    if (!id) return;
    // Switching away from a running agent releases its lock without stopping it.
    // Silent no-op, not a throw: ProfileSwitcherDropdown chains this after
    // closeProject and the UI already disables every affordance that gets here.
    if (isAgentBusy(state) && id !== state.currentProjectId) return;
    const prevId = state.currentProjectId;
    const result = await requestAcquire(id);
    if (result?.cancelled) return; // superseded by another acquire
    if (result?.conflict) {
      dispatch({ type: "LOCK_PROMPT_CONFLICT", id, name });
      return;
    }
    const serverResult = await acquireServerLock(id, name);
    if (!serverResult.ok) {
      // Release the BC lock we just claimed so we're not orphan-holding it.
      releaseLock(id);
      return;
    }
    if (prevId && prevId !== id) {
      releaseLock(prevId);
      releaseServerLock(prevId);
    }
    await performSelectProject(id, name);
  }, [state.currentProjectId, state.isStreaming, state.projectActiveChatId, requestAcquire, releaseLock, acquireServerLock, releaseServerLock, performSelectProject]);

  // User clicked "Open here" in the conflict modal — force the takeover and
  // proceed with the project switch.
  const confirmTakeover = useCallback(async () => {
    const pending = state.pendingProjectSelection;
    if (!pending) return;
    const prevId = state.currentProjectId;
    forceTakeover(pending.id);
    if (prevId && prevId !== pending.id) {
      releaseLock(prevId);
      releaseServerLock(prevId);
    }
    // Same-browser takeover — server lock is keyed by userId so it's already
    // ours; the acquire is idempotent and just re-validates.
    const serverResult = await acquireServerLock(pending.id, pending.name);
    if (!serverResult.ok) return;
    await performSelectProject(pending.id, pending.name);
  }, [state.pendingProjectSelection, state.currentProjectId, forceTakeover, releaseLock, releaseServerLock, acquireServerLock, performSelectProject]);

  // User clicked "Take over" in the cross-user server-lock-in-use modal.
  // Verified server-side as owner-only.
  const takeOverFromOtherUser = useCallback(async () => {
    const pending = state.pendingProjectSelection;
    if (!pending) return;
    const prevId = state.currentProjectId;
    try {
      await takeOverServerLock(pending.id);
    } catch (err) {
      if (err?.status === 403) {
        // Non-owner clicked take over (shouldn't happen since we hide the
        // button, but defensive). Treat as cancel.
        dispatch({ type: "SERVER_LOCK_CANCEL" });
        return;
      }
      throw err;
    }
    dispatch({ type: "SERVER_LOCK_OK" });
    if (prevId && prevId !== pending.id) {
      releaseLock(prevId);
      releaseServerLock(prevId);
    }
    await performSelectProject(pending.id, pending.name);
  }, [state.pendingProjectSelection, state.currentProjectId, takeOverServerLock, releaseLock, releaseServerLock, performSelectProject]);

  // User clicked "Cancel" in the cross-user server-lock-in-use modal.
  const cancelServerLockHeld = useCallback(() => {
    dispatch({ type: "SERVER_LOCK_CANCEL" });
  }, []);

  // User clicked "Retake" in the cross-user server-lock-taken-over overlay.
  // Re-acquires (will succeed if previous holder released) or 409s and shows
  // the in-use modal again. Owner can use the take-over endpoint instead.
  const retakeServerLock = useCallback(async () => {
    const id = state.currentProjectId;
    if (!id) return;
    try {
      await takeOverServerLock(id);
      dispatch({ type: "SERVER_LOCK_OK" });
    } catch (err) {
      if (err?.status === 403) {
        // Non-owner retake — fall back to a plain acquire (works only if the
        // current holder released in the meantime).
        const r = await acquireServerLock(id, state.currentProjectName);
        if (r.ok) dispatch({ type: "SERVER_LOCK_OK" });
      } else {
        throw err;
      }
    }
  }, [state.currentProjectId, state.currentProjectName, takeOverServerLock, acquireServerLock]);

  // User clicked "Cancel" in the conflict modal — drop the pending switch.
  const cancelTakeover = useCallback(() => {
    dispatch({ type: "LOCK_DISMISS_CONFLICT" });
  }, []);

  // User clicked "Retake control" on the taken-over overlay — re-run the
  // acquire handshake against the current project.
  const reclaimProject = useCallback(async () => {
    const id = state.currentProjectId;
    if (!id) return;
    const result = await requestAcquire(id);
    if (result?.cancelled) return;
    if (result?.conflict) {
      // Another tab still holds it — re-prompt with the current project so
      // the user can confirm a forced takeover.
      dispatch({ type: "LOCK_PROMPT_CONFLICT", id, name: state.currentProjectName });
      return;
    }
    dispatch({ type: "LOCK_RECLAIM" });
  }, [state.currentProjectId, state.currentProjectName, requestAcquire]);

  // Delete project
  const deleteProject = useCallback(async (id, alsoUndeploy) => {
    void alsoUndeploy; // per-project ACA undeploy removed; arg kept for callers
    // Never delete out from under a running agent.
    if (id === state.currentProjectId && isAgentBusy(state)) return;
    // Optimistically remove from UI immediately
    dispatch({ type: "REMOVE_PROJECT", id });
    if (state.currentProjectId === id) {
      dispatch({ type: "CLEAR_PROJECT" });
      setLastProjectId(null);
      setLastProjectName("");
      setDeployStatus(null);
      setPreviewState(EMPTY_PREVIEW_STATE);
      loadedPreviewInstanceRef.current = null;
      if (iframeRef.current) iframeRef.current.src = "about:blank";
    }
    await api(`/projects/${id}`, { method: "DELETE", body: JSON.stringify({ userId }) });
    loadProjects();
  }, [userId, state.currentProjectId, state.isStreaming, state.projectActiveChatId, loadProjects]);

  // Unlink a project that was shared with the current user. The same teardown
  // path as deleteProject applies if the unlinked entry happens to be the
  // currently active project — otherwise the preview iframe would keep pointing
  // at a workspace the current user can no longer access.
  const unlinkProject = useCallback(async (id) => {
    const wasActive = state.currentProjectId === id;
    // Same reasoning as deleteProject — don't tear down a project mid-turn.
    if (wasActive && isAgentBusy(state)) return;
    dispatch({ type: "REMOVE_PROJECT", id });
    if (wasActive) {
      dispatch({ type: "CLEAR_PROJECT" });
      setLastProjectId(null);
      setLastProjectName("");
      setDeployStatus(null);
      setPreviewState(EMPTY_PREVIEW_STATE);
      loadedPreviewInstanceRef.current = null;
      if (iframeRef.current) iframeRef.current.src = "about:blank";
    }
    await api(`/projects/${encodeURIComponent(id)}/unlink`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    loadProjects();
  }, [userId, state.currentProjectId, state.isStreaming, state.projectActiveChatId, loadProjects]);

  // Close the currently active project — return to the gallery without
  // deleting or unlinking. Stops the preview npm child process (so the
  // next holder doesn't fight for the port) and awaits the canonical
  // lock release so other users can open the project immediately,
  // without waiting out the 20s SSE grace timer.
  const closeProject = useCallback(async () => {
    const id = state.currentProjectId;
    if (!id) return;
    // Releasing the lock mid-turn would leave the agent writing into a workspace
    // another user can immediately claim. The Stop button is the way out.
    if (isAgentBusy(state)) return;
    // stop-process requires the server lock to still be held, so it
    // must run BEFORE lock/release. Best-effort: if the process is
    // already gone or the call fails, still proceed with the close.
    try {
      await api(`/projects/${encodeURIComponent(id)}/stop-process?userId=${encodeURIComponent(userId)}`, { method: "POST" });
    } catch (err) {
      console.error("[closeProject] stop-process failed:", err);
    }
    try {
      await api(`/projects/${encodeURIComponent(id)}/lock/release`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
    } catch (err) {
      console.error("[closeProject] lock/release failed:", err);
    }
    releaseLock(id);
    dispatch({ type: "CLEAR_PROJECT" });
    setLastProjectId(null);
    setLastProjectName("");
    setDeployStatus(null);
    setPreviewState(EMPTY_PREVIEW_STATE);
    loadedPreviewInstanceRef.current = null;
    if (iframeRef.current) iframeRef.current.src = "about:blank";
  }, [state.currentProjectId, state.isStreaming, state.projectActiveChatId, userId, releaseLock]);

  // Create project (two-phase: register metadata, then initialize workspace with SSE progress)
  const createProject = useCallback(async (name, appTemplate) => {
    // Creating switches away from the open project, releasing its lock.
    if (isAgentBusy(state)) return;
    const body = { userId, name, ...(appTemplate ? { appTemplate } : {}) };
    if (thinkingLevel) body.llmConfig = { thinkingLevel };
    // Phase 1: Register project metadata (fast)
    const prevId = state.currentProjectId;
    const { projectId } = await api("/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Register the server-side lock for the newly-minted project. Brand-new
    // ids can't conflict, but subsequent mutation endpoints (phase-3
    // git-remote/create, the user's first prompt) call requireLockHeld and
    // would 409 PROJECT_LOCK_NOT_HELD without an entry in the lock map —
    // surfacing the "project in use" overlay during creation.
    const lockResult = await acquireServerLock(projectId, name);
    if (!lockResult.ok) return;
    if (prevId && prevId !== projectId) {
      releaseServerLock(prevId);
    }
    // Reload project list and select (triggers SSE connection)
    await loadProjects();
    setPreviewState(EMPTY_PREVIEW_STATE);
    loadedPreviewInstanceRef.current = null;
    dispatch({ type: "SELECT_PROJECT", id: projectId, name });
    setLastProjectId(projectId);
    setLastProjectName(name);
    setDeployStatus(null);
    setGitRemoteConfigured(false);
    setServerLogLines([]);
    if (iframeRef.current) iframeRef.current.src = "about:blank";
    // Load chats so useSSE can open the EventSource — the backend SSE
    // endpoint and the useSSE hook both require chatId. Server auto-creates
    // chat-1 for brand-new projects.
    try {
      const chats = await api(`/projects/${projectId}/chats?userId=${encodeURIComponent(userId)}`);
      dispatch({ type: "SET_CHATS", chats });
      if (chats.length > 0) {
        dispatch({ type: "SELECT_CHAT", chatId: chats[chats.length - 1].id });
      }
    } catch (err) {
      console.error("[VCA] Failed to load chats during project creation:", err);
    }
    // Allow SSE EventSource to connect before starting initialization
    await new Promise(r => setTimeout(r, 300));
    // Phase 2: Initialize workspace (SSE events stream progress)
    await api(`/projects/${projectId}/initialize`, {
      method: "POST",
      body: JSON.stringify({ userId, name }),
    });
    // Repository setup (choose a VCS profile, then Create/Connect the remote)
    // now happens in Project Settings → Version control, not during creation.
  }, [userId, apiKey, llmProvider, llmModelId, llmEndpoint, llmApiVersion, serverManaged, refreshGitRemoteStatus, setProjectSteps, t, loadProjects, dispatch, iframeRef, state.currentProjectId, state.isStreaming, state.projectActiveChatId, acquireServerLock, releaseServerLock]);

  // Send prompt
  const handleSend = useCallback(async (text, attachments = []) => {
    if ((!text && attachments.length === 0) || state.isStreaming || !state.currentProjectId || !state.currentChatId) return;
    // Block if another chat in this project is currently running an agent.
    // The backend will 409 anyway, but skipping the round-trip is friendlier.
    if (state.projectActiveChatId && state.projectActiveChatId !== state.currentChatId) return;
    if (!llmConfigured) { openSetup(); return; }

    // Build display message
    const imageAttachments = attachments.filter(a => a.type === "image");
    const textAttachments = attachments.filter(a => a.type === "text");
    dispatch({ type: "ADD_MESSAGE", message: {
      type: "user", text, attachments,
      image: imageAttachments[0]?.dataUrl || null,
      ts: new Date().toISOString(),
      // For a live message the submitter is the current viewer; on reload the
      // persisted backend author (the real submitter) takes over.
      author: authUser?.displayName || "User",
    }});

    // Build prompt text: include text file contents
    let promptText = text || "";
    for (const a of textAttachments) {
      promptText += `\n\n--- File: ${a.name} ---\n${a.content}`;
    }
    if (!promptText.trim() && imageAttachments.length > 0) {
      promptText = "See the attached image(s).";
    }
    if (userdataNotesRef.current.length > 0) {
      promptText = `[User Data changes: ${userdataNotesRef.current.join("; ")}]\n\n${promptText}`;
      userdataNotesRef.current = [];
    }

    // Build images array
    const images = [];
    for (const a of imageAttachments) {
      const match = a.dataUrl.match(/^data:(image\/[\w+]+);base64,(.+)$/);
      if (match) {
        images.push({ type: "image", mimeType: match[1], data: match[2] });
      }
    }

    // Prepend language instruction for non-English
    if (lang && lang !== "en") {
      const langNames = { de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", cs: "Czech", sv: "Swedish", da: "Danish", fi: "Finnish", el: "Greek", ro: "Romanian", hu: "Hungarian", bg: "Bulgarian", hr: "Croatian", sk: "Slovak", sl: "Slovenian", lt: "Lithuanian", lv: "Latvian", et: "Estonian" };
      promptText = `[Respond in ${langNames[lang] || lang}]\n${promptText}`;
    }

    // Prepend dev focus if set
    if (devFocus) {
      promptText = `[Dev Focus: "${devFocus.name}" (from ${devFocus.diagramType} diagram) — prioritize changes related to this component]\n\n${promptText}`;
    }

    // Prepend diagrams if available
    if (deploymentMermaid) {
      promptText = `[Deployment Diagram]\n\`\`\`mermaid\n${deploymentMermaid}\n\`\`\`\n\n${promptText}`;
    }
    if (useCaseMermaid) {
      promptText = `[Use-Case Diagram]\n\`\`\`mermaid\n${useCaseMermaid}\n\`\`\`\n\n${promptText}`;
    }

    const body = { userId, chatId: state.currentChatId, text: promptText, displayText: text || "" };
    if (thinkingLevel) body.llmConfig = { thinkingLevel };
    if (images.length > 0) body.images = images;

    try {
      await api(`/projects/${state.currentProjectId}/prompt`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Project-level gate rejected this submit because another chat is running.
      // Sync the holder back into state so the UI immediately reflects it (the
      // SSE acquire event may have been missed during the round-trip).
      if (err?.code === "PROJECT_BUSY") {
        const holder = err?.body?.activeChatId ?? null;
        if (holder) dispatch({ type: "SET_PROJECT_ACTIVE_CHAT", chatId: holder });
      }
      dispatch({ type: "ADD_MESSAGE", message: { type: "assistant", text: `Error: ${err.message}`, streaming: false } });
    }
  }, [state.isStreaming, state.projectActiveChatId, state.currentProjectId, state.currentChatId, userId, apiKey, llmProvider, llmModelId, llmEndpoint, llmApiVersion, serverManaged, llmConfigured, openSetup, lang, useCaseMermaid, deploymentMermaid, devFocus, authUser]);

  // Abort
  const handleAbort = useCallback(async () => {
    if (!state.currentProjectId || !state.currentChatId) return;
    try {
      await api(`/projects/${state.currentProjectId}/abort`, {
        method: "POST",
        body: JSON.stringify({ userId, chatId: state.currentChatId }),
      });
    } catch (err) {
      console.error("Abort failed:", err);
    }
  }, [state.currentProjectId, state.currentChatId, userId]);

  // Compact context
  const handleCompact = useCallback(async () => {
    if (!state.currentProjectId || !state.currentChatId || state.isStreaming) return;
    if (!window.confirm(t("confirm.compact"))) return;
    try {
      // The compaction result (success, retry, or final failure) arrives over
      // SSE, so we don't add a message here — that would race the real outcome.
      await api(`/projects/${state.currentProjectId}/compact`, {
        method: "POST",
        body: JSON.stringify({ userId, chatId: state.currentChatId }),
      });
    } catch (err) {
      // Only genuine request failures (e.g. lock not held) reach here now.
      console.error("Compact failed:", err);
      dispatch({ type: "ADD_MESSAGE", message: { type: "compaction", error: err.message } });
    }
  }, [state.currentProjectId, state.currentChatId, state.isStreaming, userId, t]);

  // Clears the current chat. Caller is responsible for confirming with the user.
  const clearChat = useCallback(async (chatIdToClear) => {
    const cid = chatIdToClear || state.currentChatId;
    if (!state.currentProjectId || !cid || state.isStreaming) return;
    try {
      await api(`/projects/${state.currentProjectId}/clear`, {
        method: "POST",
        body: JSON.stringify({ userId, chatId: cid }),
      });
      if (cid === state.currentChatId) {
        dispatch({ type: "SET_MESSAGES", messages: [] });
        setContextUsage(null);
        setTokenStats(null);
      }
    } catch (err) {
      console.error("Clear chat failed:", err);
    }
  }, [state.currentProjectId, state.currentChatId, state.isStreaming, userId]);

  // Switch to a different chat tab (loads its messages).
  const selectChat = useCallback(async (chatId) => {
    if (!state.currentProjectId || !chatId || chatId === state.currentChatId) return;
    dispatch({ type: "SELECT_CHAT", chatId });
    setContextUsage(null);
    setTokenStats(null);
    // Drop the previous chat's effective config; the SSE reconnect's status
    // fetch repopulates it for the newly-selected chat.
    setSessionConfig(null);
    try {
      const messages = await api(`/projects/${state.currentProjectId}/messages?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(chatId)}`);
      dispatch({ type: "SET_MESSAGES", messages: parsePersistedMessages(messages) });
    } catch (err) {
      console.error("[VCA] Failed to load chat messages:", err);
    }
  }, [state.currentProjectId, state.currentChatId, userId]);

  // Create a new chat tab and switch to it.
  const createChat = useCallback(async (name) => {
    if (!state.currentProjectId) return null;
    try {
      const chat = await api(`/projects/${state.currentProjectId}/chats`, {
        method: "POST",
        body: JSON.stringify({ userId, name }),
      });
      dispatch({ type: "ADD_CHAT", chat });
      dispatch({ type: "SELECT_CHAT", chatId: chat.id });
      dispatch({ type: "SET_MESSAGES", messages: [] });
      setContextUsage(null);
      setTokenStats(null);
      return chat;
    } catch (err) {
      console.error("[VCA] Failed to create chat:", err);
      return null;
    }
  }, [state.currentProjectId, userId]);

  // Rename a chat tab.
  const renameChat = useCallback(async (chatId, name) => {
    if (!state.currentProjectId || !chatId || !name) return;
    try {
      await api(`/projects/${state.currentProjectId}/chats/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ userId, name }),
      });
      dispatch({ type: "UPDATE_CHAT", chat: { id: chatId, name } });
    } catch (err) {
      console.error("[VCA] Failed to rename chat:", err);
    }
  }, [state.currentProjectId, userId]);

  // Delete a chat tab. If the deleted chat was current, switch to the rightmost
  // remaining one. The server auto-creates a fresh chat-1 if the last was deleted.
  const deleteChat = useCallback(async (chatId) => {
    if (!state.currentProjectId || !chatId) return;
    try {
      const { chats } = await api(`/projects/${state.currentProjectId}/chats/${chatId}?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      dispatch({ type: "SET_CHATS", chats });
      if (chatId === state.currentChatId) {
        const next = chats.length ? chats[chats.length - 1] : null;
        if (next) {
          dispatch({ type: "SELECT_CHAT", chatId: next.id });
          try {
            const messages = await api(`/projects/${state.currentProjectId}/messages?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(next.id)}`);
            dispatch({ type: "SET_MESSAGES", messages: parsePersistedMessages(messages) });
          } catch { /* ignore */ }
        }
        setContextUsage(null);
        setTokenStats(null);
      }
    } catch (err) {
      console.error("[VCA] Failed to delete chat:", err);
    }
  }, [state.currentProjectId, state.currentChatId, userId]);

  // Export a chat as CSV (one row per event) from the chat tab's 3-dot menu.
  // Fetches the raw persisted rows so model / delta cost / tool calls are all
  // present. No-ops silently on an empty chat.
  const downloadChatCsv = useCallback(async (chat) => {
    if (!state.currentProjectId || !chat?.id) return;
    try {
      const messages = await api(`/projects/${state.currentProjectId}/messages?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(chat.id)}`);
      if (!Array.isArray(messages) || messages.length === 0) return;
      const csv = buildChatCsv(messages, chat.name);
      downloadTextFile(`${csvSlug(chat.name)}-chat-${yyyymmdd(new Date())}.csv`, csv, "text/csv;charset=utf-8");
    } catch (err) {
      console.error("[VCA] Failed to export chat CSV:", err);
    }
  }, [state.currentProjectId, userId]);

  // First-run setup. The guided wizard opens on first load when no LLM is
  // configured — the AI Model Config tab is an admin tool and a poor first
  // experience. Gate on `isAdmin` here: serverConfig resolves before authUser
  // (the /auth/me fetch waits for serverConfig), so firing solely on
  // serverConfig would show the wizard to a user who can't save anything, and
  // the effect wouldn't re-fire when isAdmin later flips to true. env-var
  // (serverManaged) deployments are excluded entirely — the backend ignores
  // vca-settings.json there, so nothing the wizard writes would take effect.
  useEffect(() => {
    if (serverConfig === null) return;
    if (llmConfigured || serverManaged) { setShowSetupWizard(false); return; }
    if (!isAdmin || setupSkippedRef.current) return;
    setShowSetupWizard(true);
  }, [serverConfig, llmConfigured, serverManaged, isAdmin]);

  // Single source of truth for "don't let the user walk away from this project".
  const agentBusy = isAgentBusy(state);

  // Desktop only: the OS window ✕ and Cmd+Q would tear down the in-process
  // server running the turn, and neither can be greyed out from here — so push
  // the state (and the localized notice) to the main process, which refuses the
  // close instead. Optional chaining no-ops in the browser build and in older
  // desktop builds whose preload predates setAgentBusy.
  useEffect(() => {
    window.vcaDesktop?.setAgentBusy?.({
      busy: agentBusy,
      title: t("desktop.busyCloseTitle"),
      message: t("desktop.busyCloseMessage", { name: state.currentProjectName || "" }),
    });
  }, [agentBusy, state.currentProjectName, t]);

  const ctx = useMemo(() => ({
    state, dispatch, agentBusy, userId, authUser, authEnabled, isAdmin, apiKey, setApiKey,
    llmProvider, setLlmProvider, llmModelId, setLlmModelId, llmEndpoint, setLlmEndpoint, llmApiVersion, setLlmApiVersion, thinkingLevel, setThinkingLevel,
    sessionConfig, setSessionConfig,
    imageProvider, setImageProvider, imageModelId, setImageModelId, imageApiKey, setImageApiKey,
    serverConfig, serverManaged, imageServerManaged, imageConfigured, llmConfigured, reloadServerConfig,
    selectProject, deleteProject, unlinkProject, closeProject, createProject, loadProjects,
    confirmTakeover, cancelTakeover, reclaimProject,
    takeOverFromOtherUser, cancelServerLockHeld, retakeServerLock, releaseServerLock,
    handleSend, handleAbort, handleCompact, clearChat, refreshPreview, reloadMessages, reloadDiagrams,
    selectChat, createChat, renameChat, deleteChat, downloadChatCsv,
    iframeRef, theme, toggleTheme, deployStatus, refreshDeployStatus,
    gitRemoteConfigured, refreshGitRemoteStatus,
    setShowSettings, setShowNewProject, setShowProjectsGallery, setShowCommits, setShowGit, setShowSkills, setShowDeploy,
    openSetup,
    addScreenshotAttachment, pendingScreenshot, clearPendingScreenshot,
    onboardingStep, advanceOnboarding, dismissOnboarding,
    useCaseMermaid, setUseCaseMermaid, useCasePulse, setUseCasePulse,
    deploymentMermaid, setDeploymentMermaid, deploymentPulse, setDeploymentPulse,
    componentMermaid, setComponentMermaid, componentPulse, setComponentPulse,
    activityPulse, setActivityPulse,
    erPulse, setERPulse,
    contextUsage, tokenStats, projectCost,
    devFocus, setDevFocus,
    userdataNotesRef,
    sidebarWidth, setSidebarWidth,
    t, lang, setLang,
    serverLogLines, setServerLogLines,
    serverLogPulse, setServerLogPulse,
    previewState, applyPreviewState,
    captureScreenshotRef,
    agentScreenshotRef,
    projectSteps, setProjectSteps,
    projectLogs, setProjectLogs,
    architectMode, setArchitectMode,
    sidebarHandlePulse,
  }), [state, agentBusy, userId, authUser, authEnabled, isAdmin, apiKey, llmProvider, llmModelId, llmEndpoint, llmApiVersion, thinkingLevel, sessionConfig, imageProvider, imageModelId, imageApiKey, serverConfig, serverManaged, imageServerManaged, imageConfigured, llmConfigured, reloadServerConfig, selectProject, deleteProject, unlinkProject, closeProject, createProject, loadProjects, confirmTakeover, cancelTakeover, reclaimProject, takeOverFromOtherUser, cancelServerLockHeld, retakeServerLock, releaseServerLock, handleSend, handleAbort, handleCompact, clearChat, selectChat, createChat, renameChat, deleteChat, refreshPreview, reloadMessages, reloadDiagrams, theme, toggleTheme, deployStatus, refreshDeployStatus, gitRemoteConfigured, refreshGitRemoteStatus, addScreenshotAttachment, pendingScreenshot, clearPendingScreenshot, onboardingStep, advanceOnboarding, dismissOnboarding, useCaseMermaid, useCasePulse, deploymentMermaid, deploymentPulse, componentMermaid, componentPulse, activityPulse, erPulse, contextUsage, tokenStats, projectCost, devFocus, sidebarWidth, t, lang, setLang, serverLogLines, previewState, applyPreviewState, captureScreenshotRef, projectSteps, projectLogs, architectMode, sidebarHandlePulse, serverLogPulse, openSetup]);

  if (needsLogin) {
    return (
      <Tooltip.Provider delayDuration={300}>
        <LoginScreen t={t} />
      </Tooltip.Provider>
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      <Tooltip.Provider delayDuration={300}>
        <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px`, "--right-sidebar-width": "340px" }}>
          <div className={`preview-flip-container${architectMode ? " flipped" : ""}${(architectMode || showArchitect) ? " flip-3d" : ""}`}>
            <div className="preview-flip-front">
              <PreviewPane />
            </div>
            <div className="preview-flip-back">
              {showArchitect && <ArchitectView onClose={() => setArchitectMode(false)} />}
            </div>
          </div>
          <Sidebar />
          <SidebarToggle />
          <RightSidebar />
          <RightSidebarToggle />

          <ProjectLockConflictDialog />
          <ProjectLockTakenOverOverlay />
          <ServerLockInUseDialog />
          <ServerLockTakenOverOverlay />

          {showSetupWizard && (
            <SetupWizard
              onDone={() => setShowSetupWizard(false)}
              onSkip={skipSetup}
              onOpenSettings={() => { skipSetup(); setShowSettings(true); }}
            />
          )}
          <LlmNotConfiguredNotice open={showNotConfigured} onOpenChange={setShowNotConfigured} />

          <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
          <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
          <ProjectsGalleryDialog open={showProjectsGallery} onOpenChange={setShowProjectsGallery} />
          <CommitsDialog open={showCommits} onOpenChange={setShowCommits} />
          <GitDialog open={showGit} onOpenChange={setShowGit} />
          <DeployDialog open={showDeploy} onOpenChange={setShowDeploy} />
          <SkillsDialog open={showSkills} onOpenChange={setShowSkills} />

          <SessionExpiredDialog />
        </div>
      </Tooltip.Provider>
    </AppContext.Provider>
  );
}

