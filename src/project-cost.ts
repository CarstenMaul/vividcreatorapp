// Per-project lifetime LLM spend, persisted as `.vca-cost.json` at the
// workspace root (same pattern as `.vca-deploy.json`). Monitoring only —
// nothing reads this to gate work. pi computes per-message cost in USD
// (AssistantMessage.usage.cost.total); callers pass the deltas here.
//
// The file is keyed by workspacePath so side-calls that only know the
// workspace (commit-message generation) can attribute cost too. For linked
// projects every participant's workspace path resolves to the owner's real dir
// (sharing is metadata-only — the path accessors redirect a recipient to the
// owner), so all spend lands in one physical file reached by one path string.
// No in-memory total cache: re-reading the tiny file inside the write lock is
// cheap and always correct.
import * as fs from "fs/promises";
import * as path from "path";
import { atomicWriteJson } from "./fs-utils.js";

export interface ProjectCostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Per-component USD split, same shape as the token counts. pi reports this per
// message (AssistantMessage.usage.cost = { input, output, cacheRead,
// cacheWrite, total }); keeping the split lets the cost list show what input,
// output and cache each cost rather than only a lump total.
export interface ProjectCostUsd {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProjectCostModelBucket {
  totalUsd: number;
  tokens: ProjectCostTokens;
  // Per-component USD split (input/output/cache) as reported by pi. Optional:
  // buckets written before cost-split tracking have none, and the cost list
  // then shows only the total for those.
  cost?: ProjectCostUsd;
  // LLM provider that served this model (e.g. "anthropic", "openai-codex").
  // Optional: buckets written before provider attribution have none, and the
  // cost list falls back to showing the bare model id for those.
  provider?: string;
}

export interface ProjectCostDayBucket {
  totalUsd: number;
  tokens: ProjectCostTokens;
  // Per-model split of this day's spend, keyed by model id. Day buckets
  // written before model attribution have no entries; a day's remainder
  // (totalUsd minus the model sum) renders as "unknown model" in the UI.
  byModel: Record<string, ProjectCostModelBucket>;
}

export interface ProjectCostState {
  totalUsd: number;
  tokens: ProjectCostTokens;
  updatedAt: string;
  // Daily spend keyed by local-date "YYYY-MM-DD". Bucketed at capture time so
  // side-call spend (commit messages, summaries) is included. Files written
  // before daily tracking have no buckets — their spend shows as an "earlier"
  // remainder (totalUsd minus the bucket sum) in the cost list.
  byDay: Record<string, ProjectCostDayBucket>;
}

const COST_FILE = ".vca-cost.json";

const ZERO_TOKENS: ProjectCostTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_USD: ProjectCostUsd = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function zeroState(): ProjectCostState {
  return { totalUsd: 0, tokens: { ...ZERO_TOKENS }, updatedAt: "", byDay: {} };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function coerceTokens(raw: any): ProjectCostTokens {
  return {
    input: num(raw?.input),
    output: num(raw?.output),
    cacheRead: num(raw?.cacheRead),
    cacheWrite: num(raw?.cacheWrite),
  };
}

// Tokens and USD splits share the input/output/cacheRead/cacheWrite shape, so
// the coerce/add math is identical — these aliases keep call sites readable.
function coerceUsd(raw: any): ProjectCostUsd {
  return coerceTokens(raw);
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Local server date — in the desktop app the server runs on the user's
// machine, so buckets match the user's working days.
function dayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function coerceByModel(raw: any): Record<string, ProjectCostModelBucket> {
  const byModel: Record<string, ProjectCostModelBucket> = {};
  if (raw && typeof raw === "object") {
    for (const [modelId, bucket] of Object.entries<any>(raw)) {
      if (!modelId) continue;
      const coerced: ProjectCostModelBucket = {
        totalUsd: num(bucket?.totalUsd),
        tokens: coerceTokens(bucket?.tokens),
        ...(bucket?.cost ? { cost: coerceUsd(bucket.cost) } : {}),
        ...(typeof bucket?.provider === "string" && bucket.provider ? { provider: bucket.provider } : {}),
      };
      // Drop cost-less $0 rows: unpriced side-call artifacts (e.g. the
      // commit-message helper's azure-openai-responses / gpt-5.5 call) that
      // would otherwise render as an empty "$0.00" model the user never chose.
      // Real chat spend always carries a cost split, so priced/used models
      // survive. Because addProjectCost reads through coerce before rewriting,
      // stale entries are also dropped from the file on the next write.
      if (coerced.totalUsd === 0 && !coerced.cost) continue;
      byModel[modelId] = coerced;
    }
  }
  return byModel;
}

function coerce(raw: any): ProjectCostState {
  const byDay: Record<string, ProjectCostDayBucket> = {};
  if (raw?.byDay && typeof raw.byDay === "object") {
    for (const [key, bucket] of Object.entries<any>(raw.byDay)) {
      if (!DAY_KEY_RE.test(key) || Number.isNaN(Date.parse(`${key}T00:00:00`))) continue;
      byDay[key] = {
        totalUsd: num(bucket?.totalUsd),
        tokens: coerceTokens(bucket?.tokens),
        byModel: coerceByModel(bucket?.byModel),
      };
    }
  }
  return {
    totalUsd: num(raw?.totalUsd),
    tokens: coerceTokens(raw?.tokens),
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : "",
    byDay,
  };
}

function costFilePath(workspacePath: string): string {
  return path.join(workspacePath, COST_FILE);
}

/** Current spend state; a missing or corrupt file reads as zero. Never throws. */
export async function readProjectCost(workspacePath: string): Promise<ProjectCostState> {
  return (await readProjectCostIfExists(workspacePath)) ?? zeroState();
}

/** Like readProjectCost, but undefined when no file exists — lets project
 *  listings distinguish "never spent" (no badge) from "spent $0". */
export async function readProjectCostIfExists(workspacePath: string): Promise<ProjectCostState | undefined> {
  try {
    const raw = await fs.readFile(costFilePath(workspacePath), "utf-8");
    return coerce(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// FIFO write serialization per cost file (same shape as withChatSaveLock in
// agent-manager). One prompting chat per project means contention is rare,
// but tool-heavy turns emit message_ends in quick succession.
const writeLocks = new Map<string, Promise<void>>();

async function withCostWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  writeLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === next) {
      writeLocks.delete(key);
    }
  }
}

function addTokens(a: ProjectCostTokens, b: ProjectCostTokens): ProjectCostTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

function addUsd(a: ProjectCostUsd, b: ProjectCostUsd): ProjectCostUsd {
  return addTokens(a, b);
}

/**
 * Accumulate spend: serialized read-modify-write of the cost file. Non-finite
 * or negative deltas are ignored (unpriced models report 0; junk never lands
 * in the file). `modelId` splits the day bucket per model so a model switch
 * shows as separate summaries in the cost list; `deltaCost` is pi's per-message
 * USD split (input/output/cache) recorded per model so the list can break the
 * total down; `provider` records which backend served that model so the list
 * can show "provider / model". Returns the new state so callers can broadcast
 * it. Callers on the streaming hot path invoke this fire-and-forget.
 */
export async function addProjectCost(
  workspacePath: string,
  deltaUsd: number,
  deltaTokens?: Partial<ProjectCostTokens>,
  deltaCost?: Partial<ProjectCostUsd>,
  modelId?: string,
  provider?: string,
): Promise<ProjectCostState> {
  const usd = Number.isFinite(deltaUsd) && deltaUsd > 0 ? deltaUsd : 0;
  const tokens = {
    input: Math.max(0, num(deltaTokens?.input)),
    output: Math.max(0, num(deltaTokens?.output)),
    cacheRead: Math.max(0, num(deltaTokens?.cacheRead)),
    cacheWrite: Math.max(0, num(deltaTokens?.cacheWrite)),
  };
  const costSplit: ProjectCostUsd = {
    input: Math.max(0, num(deltaCost?.input)),
    output: Math.max(0, num(deltaCost?.output)),
    cacheRead: Math.max(0, num(deltaCost?.cacheRead)),
    cacheWrite: Math.max(0, num(deltaCost?.cacheWrite)),
  };
  const filePath = costFilePath(workspacePath);
  return withCostWriteLock(filePath, async () => {
    const current = await readProjectCost(workspacePath);
    const today = dayKey();
    const bucket = current.byDay[today] ?? { totalUsd: 0, tokens: { ...ZERO_TOKENS }, byModel: {} };
    const byModel = { ...bucket.byModel };
    // Only split out a per-model line when the delta carries actual cost. An
    // unpriced side-call (e.g. the commit-message helper on
    // azure-openai-responses / gpt-5.5) reports $0 with no cost split;
    // recording it would seed an empty "provider / model" row the user never
    // chose. Real chat spend always supplies a cost split (see message_end), so
    // used/priced models still split out.
    if (modelId && (usd > 0 || deltaCost != null)) {
      const modelBucket = byModel[modelId] ?? { totalUsd: 0, tokens: { ...ZERO_TOKENS } };
      // Same model id is bound to one provider in practice; prefer the freshly
      // supplied provider but keep any previously recorded one.
      const resolvedProvider = provider || modelBucket.provider;
      byModel[modelId] = {
        totalUsd: modelBucket.totalUsd + usd,
        tokens: addTokens(modelBucket.tokens, tokens),
        // Only record the split once a caller supplies it (or the bucket
        // already has one) — legacy buckets stay split-less and render as a
        // bare total rather than a misleading all-$0 breakdown.
        ...(deltaCost != null || modelBucket.cost ? { cost: addUsd(modelBucket.cost ?? ZERO_USD, costSplit) } : {}),
        ...(resolvedProvider ? { provider: resolvedProvider } : {}),
      };
    }
    const next: ProjectCostState = {
      totalUsd: current.totalUsd + usd,
      tokens: addTokens(current.tokens, tokens),
      updatedAt: new Date().toISOString(),
      byDay: {
        ...current.byDay,
        [today]: {
          totalUsd: bucket.totalUsd + usd,
          tokens: addTokens(bucket.tokens, tokens),
          byModel,
        },
      },
    };
    // On Windows, rename-over-existing can transiently EPERM/EBUSY when an
    // AV scanner or the search indexer briefly holds the just-replaced file.
    // Losing a delta means permanently under-reporting spend, so retry with
    // a short backoff before giving up.
    for (let attempt = 0; ; attempt++) {
      try {
        await atomicWriteJson(filePath, next, 2);
        break;
      } catch (err: any) {
        const transient = err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES";
        if (!transient || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
    return next;
  });
}
