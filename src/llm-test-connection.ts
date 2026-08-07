// Live "does this configuration actually work?" probe for the first-run setup
// wizard (and any future Test-connection button in Settings). Sends one tiny
// real inference request through the SAME resolver a chat turn uses, then maps
// whatever came back to a small set of codes the frontend turns into plain
// language.
//
// Why go through resolveLlmModelParts instead of a hand-rolled fetch: a raw
// fetch would validate a different code path than a real turn and could pass
// while chat fails — the Codex SSE transport, the AI Foundry
// `Authorization: Bearer` header, Kimi's credential-store token refresh and the
// OpenRouter OAuth→minted-key indirection all live in that resolver. Testing
// anything else would be testing the wrong thing.
//
// The ModelRuntime is built here rather than via resolveLlmModel() because the
// probe must register its keys with `allowNetwork: false`. The default
// setRuntimeApiKey() kicks off a pi model-catalog refresh whose network call is
// unbounded; behind a proxy that blackholes it, that stalls for minutes. VCA
// hand-builds every model and already passes `allowModelNetwork: false`, so the
// refresh has nothing to contribute — skipping it changes no part of the actual
// request that gets sent.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { resolveLlmModelParts, type UserLLMConfig } from "./agent-manager.js";
import { UNCHANGED_SECRET_SENTINEL } from "./admin-settings.js";

export type TestConnectionCode =
  | "OK"
  | "AUTH_INVALID"
  | "AUTH_FORBIDDEN"
  | "OAUTH_NOT_SIGNED_IN"
  | "MODEL_NOT_FOUND"
  | "NO_CREDIT"
  | "RATE_LIMITED"
  | "ENDPOINT_REQUIRED"
  | "ENDPOINT_INVALID"
  | "NETWORK_UNREACHABLE"
  | "TLS_ERROR"
  | "TIMEOUT"
  | "BUSY"
  | "UNKNOWN";

export interface TestConnectionResult {
  ok: boolean;
  code: TestConnectionCode;
  provider: string;
  modelId: string;
  latencyMs: number;
  /** Raw upstream text, truncated. Shown behind a "technical details" expander. */
  detail?: string;
}

export interface TestConnectionInput {
  provider: string;
  modelId: string;
  apiKey: string;
  endpoint: string;
  apiVersion: string;
}

// The probe costs real money on every provider that bills per token, and a
// stuck user will hammer "Try again". Keep it to a two-character prompt with a
// hard output cap, one at a time, with a cooldown between attempts.
// Do not remove the token cap "for a better test" — 16 tokens is enough to
// prove the credential, the endpoint, the transport and the model id.
const PROBE_TIMEOUT_MS = 20_000;
// Backstop for the whole operation, not just the request: model resolution can
// touch the filesystem and a credential store, and a wedged step must never
// hold the single-flight lock shut for the next caller.
const OVERALL_DEADLINE_MS = 30_000;
const PROBE_MAX_TOKENS = 16;
// Some reasoning models reject a max_tokens at or below their thinking budget
// even with reasoning off. One retry with a realistic cap covers those.
const PROBE_RETRY_MAX_TOKENS = 1024;
const COOLDOWN_MS = 3_000;

let inFlight: Promise<TestConnectionResult> | null = null;
let lastFinishedAt = 0;

export async function testLlmConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
  if (inFlight) {
    return {
      ok: false, code: "BUSY", provider: input.provider, modelId: input.modelId, latencyMs: 0,
      detail: "Another connection test is still running.",
    };
  }
  const sinceLast = Date.now() - lastFinishedAt;
  if (sinceLast < COOLDOWN_MS) {
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS - sinceLast));
  }
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<TestConnectionResult>((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false, code: "TIMEOUT", provider: input.provider, modelId: input.modelId,
      latencyMs: OVERALL_DEADLINE_MS, detail: "The connection test did not finish in time.",
    }), OVERALL_DEADLINE_MS);
  });
  inFlight = Promise.race([runTest(input), deadline]);
  try {
    return await inFlight;
  } finally {
    clearTimeout(timer);
    inFlight = null;
    lastFinishedAt = Date.now();
  }
}

async function runTest(input: TestConnectionInput): Promise<TestConnectionResult> {
  const started = Date.now();
  const done = (code: TestConnectionCode, detail?: string): TestConnectionResult => {
    const result: TestConnectionResult = {
      ok: code === "OK",
      code,
      provider: input.provider,
      modelId: input.modelId,
      latencyMs: Date.now() - started,
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
    };
    // Never log the key or the raw upstream body.
    console.log(`[llm-test] ${input.provider}/${input.modelId || "(no model)"} → ${code} in ${result.latencyMs}ms`);
    return result;
  };

  // A blank key means "use whatever is stored" — which is exactly what the
  // UNCHANGED sentinel stands for. mergeLlmConfigWithSettings (inside the
  // resolver) fills blanks from vca-settings.json only when the requested
  // provider matches the stored one, so provider A's key can never be sent to
  // provider B.
  const apiKey = input.apiKey === UNCHANGED_SECRET_SENTINEL ? "" : input.apiKey;

  const cfg: UserLLMConfig = {
    provider: input.provider as UserLLMConfig["provider"],
    apiKey,
    modelId: input.modelId || undefined,
    endpoint: input.endpoint || undefined,
    apiVersion: input.apiVersion || undefined,
    thinkingLevel: "off",
  };

  let model: any;
  let runtime: ModelRuntime;
  try {
    const parts = await resolveLlmModelParts(apiKey || undefined, cfg);
    model = parts.model;
    // Hermetic runtime, same options resolveLlmModel() uses for a chat turn.
    runtime = await ModelRuntime.create({
      credentials: parts.credentials ?? new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    for (const [p, key] of parts.runtimeApiKeys) {
      await runtime.setRuntimeApiKey(p, key, { allowNetwork: false });
    }
  } catch (err: any) {
    // The resolver throws before any network call for: no model id, an unknown
    // model for the provider, a missing endpoint, and "Not signed in with
    // ChatGPT / Kimi Code".
    const message = err?.message || String(err);
    return done(classify(message), message);
  }

  let assistant = await probe(runtime, model, PROBE_MAX_TOKENS);
  if (assistant.errorMessage && /max_tokens must be greater than/i.test(assistant.errorMessage)) {
    assistant = await probe(runtime, model, PROBE_RETRY_MAX_TOKENS);
  }

  // "length" is the expected outcome with a 16-token cap; "stop" happens when
  // the model answers a two-character prompt in fewer tokens. Both prove the
  // whole path works.
  if (assistant.stopReason === "stop" || assistant.stopReason === "length" || assistant.stopReason === "toolUse") {
    return done("OK");
  }
  const message = assistant.errorMessage || `Model stopped with "${assistant.stopReason}"`;
  if (assistant.stopReason === "aborted" && !assistant.errorMessage) return done("TIMEOUT", message);
  return done(classify(message), message);
}

async function probe(runtime: any, model: any, maxTokens: number): Promise<{ stopReason: string; errorMessage?: string }> {
  try {
    return await runtime.completeSimple(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
      { maxTokens, reasoning: "off", temperature: 0, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
  } catch (err: any) {
    // completeSimple normally folds failures into stopReason "error", but a
    // setup-time throw (bad URL, abort) can still escape.
    return { stopReason: "error", errorMessage: err?.message || String(err) };
  }
}

/**
 * Map an upstream/resolver message to a code. Ordered, first match wins, and
 * the order is load-bearing:
 *  - TIMEOUT first: an aborted TLS handshake can carry auth-shaped words.
 *  - OAuth before generic auth: a dead refresh token surfaces from pi as the
 *    misleading "No API key for provider: openai-codex".
 *  - 404 / 402 / 429 before 401: Azure's DeploymentNotFound sometimes rides a
 *    401 envelope.
 */
function classify(message: string): TestConnectionCode {
  const m = message || "";
  if (/aborted|AbortError|ETIMEDOUT|\btimed? ?out\b/i.test(m)) return "TIMEOUT";
  if (/self[- ]signed certificate|unable to verify|CERT_|DEPTH_ZERO/i.test(m)) return "TLS_ERROR";
  // "Connection error." is all the OpenAI SDK surfaces for a refused socket —
  // the ECONNREFUSED sits in a nested cause. It's the most common outcome of a
  // wrong local endpoint (LM Studio/Ollama not running), so match it by name.
  if (/ENOTFOUND|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|getaddrinfo|fetch failed|ECONNRESET|socket hang up|connection error|network error/i.test(m)) return "NETWORK_UNREACHABLE";
  if (/requires an endpoint/i.test(m)) return "ENDPOINT_REQUIRED";
  if (/Invalid URL|ERR_INVALID_URL/i.test(m)) return "ENDPOINT_INVALID";
  if (/not signed in with (chatgpt|kimi)|no api key for provider|invalid_grant|token[_ ]expired/i.test(m)) return "OAUTH_NOT_SIGNED_IN";
  if (/\b402\b|insufficient[_ ](quota|credit)|exceeded your current quota|billing/i.test(m)) return "NO_CREDIT";
  if (/\b429\b|rate[_ ]?limit|too many requests/i.test(m)) return "RATE_LIMITED";
  if (/\b404\b|model[_ ]not[_ ]found|unknown model|does not exist|DeploymentNotFound|No LLM model configured/i.test(m)) return "MODEL_NOT_FOUND";
  if (/\b401\b|invalid[_ ]?api[_ ]?key|incorrect api key|invalid x-api-key|authentication[_ ]error|unauthorized/i.test(m)) return "AUTH_INVALID";
  if (/\b403\b|forbidden|permission/i.test(m)) return "AUTH_FORBIDDEN";
  return "UNKNOWN";
}
