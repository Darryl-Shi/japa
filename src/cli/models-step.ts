// The models step of `japa setup`: which provider and model japa (the CoS) runs on, connecting japa to that
// provider -- signing in (OAuth) or an API key, through pi-ai's own login flows -- and whether background jobs
// and memory upkeep use the same model.
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envKeyName } from "../kernel/boot.ts";
import { message } from "../kernel/loader.ts";
import { checkModel, loadSettings, readUserSettings, saveSettings, setPath } from "../kernel/settings.ts";
import type { SetupContext } from "./context.ts";
import { Cancelled, type Choice, type Prompter } from "./prompt.ts";

export type ModelsStepOptions = {
  env?: NodeJS.ProcessEnv;
  /** Opens a sign-in link in the user's browser, when there is one to open it in. */
  openUrl?: (url: string) => void;
};

/** Listed first, in this order; the other providers follow by name. */
const FEATURED = ["anthropic", "openai", "google", "openrouter", "github-copilot", "xai", "zai", "deepseek", "mistral"];

type Role = { provider: string; model: string };
const COS: Role = { provider: "Which AI provider should japa use?", model: "Which model should japa use?" };
const WORKER: Role = { provider: "Which provider for background jobs?", model: "Which model for background jobs?" };
const MEMORY: Role = { provider: "Which provider for memory upkeep?", model: "Which model for memory upkeep?" };

/** Opens `url` with the desktop's opener; does nothing over SSH or without a desktop. */
export function openInBrowser(url: string): void {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
        ? "xdg-open"
        : undefined;
  if (command === undefined) return;
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No opener: the link is on screen.
  }
}

/** This install's stable id, for sign-in flows that register the device (`<home>/device-id`). */
function deviceId(home: string): string {
  const file = join(home, "device-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const id = randomUUID();
  writeFileSync(file, `${id}\n`);
  return id;
}

/** An error's message followed by its causes': pi-ai wraps the provider's own error. */
function describe(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e !== undefined && parts.length < 4; e = (e as { cause?: unknown }).cause) {
    const text = message(e);
    if (text && !parts.includes(text)) parts.push(text);
    if (!(e instanceof Error)) break;
  }
  return parts.join(": ");
}

async function chooseProvider(ctx: SetupContext, p: Prompter, question: string, initial?: string): Promise<string> {
  const stored = new Set((await ctx.credentials.list().catch(() => [])).map((c) => c.providerId));
  const rank = (id: string) => (FEATURED.includes(id) ? FEATURED.indexOf(id) : FEATURED.length);
  const providers = ctx.models
    .getProviders()
    .filter((pr) => ctx.models.getModels(pr.id).length > 0)
    .toSorted((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  const choices: Choice<string>[] = providers.map((pr) => ({
    label: pr.name,
    value: pr.id,
    hint: stored.has(pr.id) ? "connected" : pr.auth.oauth ? "sign in or API key" : undefined,
  }));
  return p.select(question, choices, initial);
}

/** pi-ai's login prompts and notices, through `p`. */
function interactionFor(p: Prompter, openUrl: (url: string) => void, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    prompt: async (q: AuthPrompt) => {
      switch (q.type) {
        case "select":
          return p.select(
            q.message,
            q.options.map((o) => ({ label: o.label, value: o.id, hint: o.description })),
          );
        case "secret": {
          const value = await p.secret(q.message, { signal: q.signal });
          if (value === "") throw new Error("nothing was entered");
          return value;
        }
        case "text":
        case "manual_code":
          return p.text(q.message, { placeholder: q.placeholder, signal: q.signal });
      }
    },
    notify: (event: AuthEvent) => {
      switch (event.type) {
        case "auth_url":
          p.box(event.instructions ?? "Open this link to sign in.", "Sign in");
          p.link(event.url);
          openUrl(event.url);
          break;
        case "device_code":
          p.box(`Open the link below and enter the code ${event.userCode}`, "Sign in");
          p.link(event.verificationUri);
          openUrl(event.verificationUri);
          break;
        case "info":
          p.note([event.message, ...(event.links ?? []).map((l) => `${l.label ?? "Link"}: ${l.url}`)].join("\n"));
          break;
        case "progress":
          p.note(event.message);
          break;
      }
    },
  };
}

/** Runs `provider`'s pi-ai login of `type`, which stores the credential; whether it succeeded. */
async function login(
  ctx: SetupContext,
  p: Prompter,
  provider: string,
  type: "oauth" | "api_key",
  openUrl: (url: string) => void,
): Promise<boolean> {
  const name = ctx.models.getProvider(provider)!.name;
  const abort = new AbortController();
  let quit = false;
  // Quitting during a sign-in also stops the flow (and its local callback server).
  const asking: Prompter = {
    ...p,
    select: (...args) => p.select(...args).catch(onQuit),
    text: (...args) => p.text(...args).catch(onQuit),
    secret: (...args) => p.secret(...args).catch(onQuit),
  };
  function onQuit(error: unknown): never {
    if (error instanceof Cancelled) {
      quit = true;
      abort.abort(error);
    }
    throw error;
  }

  try {
    await ctx.models.login(provider, type, interactionFor(asking, openUrl, abort.signal), {
      getDeviceId: () => deviceId(ctx.home),
    });
  } catch (error) {
    if (quit) throw new Cancelled();
    p.warn(`Couldn't connect to ${name}: ${describe(error)}`);
    return false;
  }
  p.note(`Connected to ${name}.`);
  return true;
}

/**
 * Connects japa to `provider`: keeps the stored login, saves the API key this shell has in its environment (the
 * background service doesn't see the shell's), signs in, or takes an API key -- whichever the user picks among
 * those the provider supports. A failed sign-in says why and asks again. Returns whether japa is connected.
 */
async function connect(
  ctx: SetupContext,
  p: Prompter,
  provider: string,
  env: NodeJS.ProcessEnv,
  openUrl: (url: string) => void,
): Promise<boolean> {
  const { name, auth } = ctx.models.getProvider(provider)!;
  const envVar = await envKeyName(ctx.models, provider);
  const inShell = envVar !== undefined && env[envVar] ? envVar : undefined;

  for (;;) {
    const stored: Credential | undefined = await ctx.credentials.read(provider).catch(() => undefined);
    type How = "keep" | "oauth" | "env" | "api_key" | "skip";
    const choices: Choice<How>[] = [];
    if (stored) {
      choices.push({ label: stored.type === "oauth" ? "Keep the current sign-in" : "Keep the current API key", value: "keep" });
    }
    if (auth.oauth) {
      choices.push({
        label: auth.oauth.loginLabel ?? `Sign in with ${auth.oauth.name}`,
        value: "oauth",
        hint: auth.oauth.isSubscription ? "uses your subscription" : undefined,
      });
    }
    if (inShell) choices.push({ label: `Use ${inShell} from this shell`, value: "env", hint: "saves it for the background service" });
    if (auth.apiKey?.login) choices.push({ label: `Enter ${auth.apiKey.name}`, value: "api_key" });
    if (!stored) choices.push({ label: "Skip for now", value: "skip", hint: "japa can't answer until it's connected" });

    const how = await p.select(`How should japa connect to ${name}?`, choices, choices[0]!.value);
    switch (how) {
      case "keep":
        return true;
      case "skip":
        return false;
      case "env":
        await ctx.credentials.modify(provider, async () => ({ type: "api_key", key: env[inShell!]!.trim() }));
        p.note(`Saved ${inShell} for japa.`);
        return true;
      case "oauth":
      case "api_key":
        if (await login(ctx, p, provider, how, openUrl)) return true;
    }
  }
}

/** Picks one of `provider`'s models -- those its login can use, when it narrows them -- preselecting `initial`. */
async function chooseModel(
  ctx: SetupContext,
  p: Prompter,
  question: string,
  provider: string,
  initial?: string,
): Promise<string> {
  if (ctx.models.getProvider(provider)?.refreshModels) {
    await p.wait("Loading models", ctx.models.refresh({ providers: [provider] })).catch(() => {});
  }
  const available = await ctx.models.getAvailable(provider).catch(() => []);
  const models = available.length > 0 ? available : ctx.models.getModels(provider);
  const choices: Choice<string>[] = models.map((m) => ({
    label: m.name,
    value: m.id,
    hint: m.name === m.id ? undefined : m.id,
  }));
  return p.select(question, choices, models.some((m) => m.id === initial) ? initial : undefined);
}

/**
 * Chooses `models.cos` and connects japa to its provider, then either uses it for `models.worker` and
 * `models.consolidation` too or chooses those (connecting their providers when nothing is stored for them yet).
 * Always saves; returns true.
 */
export async function chooseModels(ctx: SetupContext, p: Prompter, options: ModelsStepOptions = {}): Promise<boolean> {
  const { env = process.env, openUrl = openInBrowser } = options;
  const current = loadSettings(ctx.home).models;
  const asked = new Set<string>();

  const choose = async (role: Role, now: ModelRef | undefined, fallbackProvider?: string): Promise<ModelRef> => {
    const provider = await chooseProvider(ctx, p, role.provider, now?.provider ?? fallbackProvider);
    const needsLogin = role === COS || (await ctx.credentials.read(provider).catch(() => undefined)) === undefined;
    if (!asked.has(provider) && needsLogin) await connect(ctx, p, provider, env, openUrl);
    asked.add(provider);
    const modelId = await chooseModel(ctx, p, role.model, provider, now?.provider === provider ? now.modelId : undefined);
    return { provider, modelId };
  };

  const cos = await choose(COS, current.cos, "anthropic");

  // Preselect what's there: a rerun with custom job/memory models keeps them on Enter.
  const shared = current.worker === undefined && current.consolidation === undefined;
  const cosName = ctx.models.getModel(cos.provider, cos.modelId)?.name ?? cos.modelId;
  const sameForAll = await p.confirm(`Use ${cosName} for background jobs and memory upkeep too?`, shared);
  let worker: ModelRef | undefined;
  let consolidation: ModelRef | undefined;
  if (!sameForAll) {
    // Unset means the CoS model, so Enter keeps whichever model each role runs on now.
    worker = await choose(WORKER, current.worker ?? cos);
    consolidation = await choose(MEMORY, current.consolidation ?? cos);
  }

  for (const ref of [cos, worker, consolidation]) if (ref !== undefined) checkModel(ctx.models, ref);

  const user = readUserSettings(ctx.home);
  setPath(user, "models.cos", cos);
  setPath(user, "models.worker", worker);
  setPath(user, "models.consolidation", consolidation);
  saveSettings(ctx.home, user);

  return true;
}
