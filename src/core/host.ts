import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type {
  Extension as DurableExtension,
  HarnessSettings,
  Storage,
} from "@earendil-works/pi-durable";
import type { Adapters, Dispose } from "./contracts.ts";

export type AdapterFactories = {
  [K in keyof Adapters]?: (host: Host) => Adapters[K];
};

export interface Extension {
  name: string;
  adapters?: AdapterFactories;
  /** Declare native Pi Durable tools, sections, hooks, and tasks. No side effects. */
  register?(host: Host): DurableExtension;
  /** Start resources only after all adapters are bound and storage is open. */
  start?(host: Host): Promise<Dispose | void>;
}

export type HostOptions = {
  storage: Storage;
  extensions: readonly Extension[];
  bindings?: Partial<Record<keyof Adapters, string>>;
  settings?: HarnessSettings;
  report?: (error: unknown) => void;
};

const required: readonly (keyof Adapters)[] = [
  "channel",
  "models",
  "environment",
  "context",
  "memory",
  "jobs",
  "policy",
  "approvals",
];

/** Composition and lifecycle only. Assistant behavior lives in extensions. */
export class Host {
  readonly registry = createRegistry();
  readonly adapters = {} as Adapters;
  readonly report: (error: unknown) => void;
  harness!: Harness;
  private readonly stops: Dispose[] = [];
  private readonly builtins: Set<string>;
  private closing?: Promise<void>;

  private constructor(options: HostOptions) {
    this.report = options.report ?? ((error) => console.error(error));
    this.builtins = new Set(
      options.extensions.map((extension) => extension.name),
    );
    if (this.builtins.size !== options.extensions.length)
      throw new Error("Duplicate extension name");

    for (const slot of required) {
      const candidates = options.extensions.filter(
        (extension) => extension.adapters?.[slot],
      );
      const binding = options.bindings?.[slot];
      const provider = binding
        ? candidates.find((extension) => extension.name === binding)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!provider) {
        throw new Error(
          `Adapter '${slot}' needs one provider or an explicit binding (found: ${candidates.map((e) => e.name).join(", ") || "none"})`,
        );
      }
      // Lazy factories let providers depend on other slots without depending on load order.
      let value: Adapters[typeof slot] | undefined;
      let resolving = false;
      Object.defineProperty(this.adapters, slot, {
        enumerable: true,
        get: () => {
          if (resolving)
            throw new Error(`Circular adapter dependency: ${slot}`);
          if (value === undefined) {
            resolving = true;
            try {
              value = provider.adapters![slot]!(this);
            } finally {
              resolving = false;
            }
          }
          return value;
        },
      });
    }
  }

  static async open(options: HostOptions): Promise<Host> {
    let host: Host | undefined;
    try {
      host = new Host(options);
      for (const extension of options.extensions) host.register(extension);
      const { models, environment } = host.adapters;
      for (const ref of [models.root, models.worker]) {
        if (!models.models.getModel(ref.provider, ref.modelId)) {
          throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
        }
      }
      host.harness = await Harness.open(
        options.storage,
        {
          models: models.models,
          registry: host.registry,
          env: environment,
          settings: options.settings,
          onReport: host.report,
        },
        BACKGROUND_CONTEXT,
      );
      // Resolve every required slot before starting ingress.
      for (const slot of required) void host.adapters[slot];
      const settingsUI = host.adapters.channel.settings;
      if (
        typeof settingsUI?.prompt !== "function" ||
        typeof settingsUI?.notify !== "function"
      )
        throw new Error("Channel must implement the settings UI contract");
      for (const extension of options.extensions) {
        const stop = await extension.start?.(host);
        if (stop) host.stops.push(stop);
      }
      host.harness.resume();
      return host;
    } catch (error) {
      if (host?.harness) await host.close();
      else await options.storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  private register(extension: Extension): void {
    const contribution = extension.register?.(this);
    if (!contribution) return;
    if (contribution.name !== extension.name)
      throw new Error("Extension and contribution names must match");
    this.registry.install(contribution);
  }

  /** Trusted hot installation. Adapter/lifecycle changes require a host restart. */
  install(extension: Extension): void {
    if (
      this.builtins.has(extension.name) ||
      extension.name.startsWith("japa.")
    ) {
      throw new Error(
        `Cannot replace packaged extension '${extension.name}' at runtime`,
      );
    }
    if (extension.adapters || extension.start || !extension.register) {
      throw new Error(
        "Hot extensions must contain only durable contributions; adapter changes require restart",
      );
    }
    this.register(extension);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const stop of this.stops.reverse()) {
        try {
          await stop();
        } catch (error) {
          this.report(error);
        }
      }
      await this.harness.close(BACKGROUND_CONTEXT);
    })();
    return this.closing;
  }
}
