export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface PhaseSnapshot {
  text: string;
  kind: "phase" | "wait";
  itemId?: string;
  label: string;
  elapsedMs: number;
}

interface ActivePhase {
  itemId: string;
  label: string;
  startedAt: number;
  lastReportedKey: string | null;
  waitReported: boolean;
}

export const TOOL_WAIT_THRESHOLD_MS = 8_000;

const STATUS_PREFIXES: readonly string[] = [
  // Core thinking & analysis
  "Thinking",
  "Overthinking",
  "Contemplating",
  "Pondering",
  "Ruminating",
  "Deliberating",
  "Noodling",
  "Galaxy-braining",
  "Deep-diving",
  "Dissecting",
  "Deciphering",
  "Pattern-matching",
  "Connecting dots",
  "Strategizing",
  "Calculating",
  "Computing",
  "Processing",
  "Analyzing",
  // Code craft
  "Tinkering",
  "Working",
  "Drafting",
  "Debugging",
  "Refactoring",
  "Linting",
  "Type-checking",
  "Transpiling",
  "Compiling",
  "Parsing",
  "Tokenizing",
  "Serializing",
  "Memoizing",
  "Benchmarking",
  "Fuzzing",
  "Monkey-patching",
  "Hot-patching",
  "Tree-shaking",
  "Bundling",
  "Hydrating",
  "Prototyping",
  "Bootstrapping",
  "Initializing",
  "Mocking",
  "Null-checking",
  "Regex-crafting",
  "Rate-limiting",
  "Debouncing",
  "Load-testing",
  // File & search ops
  "Checking",
  "Reviewing",
  "Inspecting",
  "Tracing",
  "Reading",
  "Scanning",
  "Sorting",
  "Spelunking",
  "Excavating",
  "Sniffing out bugs",
  "Following the breadcrumbs",
  "Stack-tracing",
  "Rabbit-holing",
  "Tab-collecting",
  // Magic & chaos
  "Summoning",
  "Conjuring",
  "Spellcasting",
  "Invoking dark arts",
  "Consulting the oracle",
  "Channeling the void",
  "Entering the matrix",
  "Reticulating splines",
  "Negotiating with entropy",
  "Rolling for initiative",
  "Consulting ancient scrolls",
  "Rebooting the universe",
  // Dev culture
  "Wrangling",
  "Unraveling",
  "Untangling",
  "Herding cats",
  "Yak-shaving",
  "Rubber-ducking",
  "Speed-running",
  "Brute-forcing",
  "Bikeshedding",
  "Over-engineering",
  "Improvising",
  "Wrangling dependencies",
  "Cherry-picking",
  "Git-blaming",
  "Stash-and-dashing",
  "Stack-overflowing",
  "Waiting for CI",
  "Blaming flaky tests",
  // Vibes & copium
  "Vibing",
  "Stress-testing",
  "Caffeinating",
  "Manifesting",
  "Scheming",
  "Running on vibes",
  "Shipping and praying",
  "Crossing fingers",
  "Holding my breath",
  "Accepting my fate",
  "Pivoting gracefully",
  "Rewriting from scratch",
  "Rewriting in Rust",
  "Arguing with the linter",
  "Losing to the linter",
  "Blaming cosmic rays",
  "Blaming DNS",
  "Negotiating with the compiler",
  "Reading the docs",
  "Googling frantically",
  "Questioning life choices",
  "Procrastinating productively",
  "Scope-creeping",
  // Extra flair
  "Interpolating",
  "Extrapolating",
  "Approximating",
  "Guesstimating",
  "Aligning chakras",
  "Questioning the simulation",
  "Leveling up",
  "Muting Slack",
  "Off-by-one-ing",
  "Spaghetti-detecting",
  "Deadlock-detecting",
  "Race-conditioning",
  "Base64-encoding",
  "sudo-ing",
  "Memory-leaking (a little)",
  "Convincing myself it works",
  "Chasing rabbits",
  "Asking nicely",
] as const;

function statusPrefix(): string {
  return STATUS_PREFIXES[Math.floor(Math.random() * STATUS_PREFIXES.length)];
}

export class PhaseTracker {
  private active: ActivePhase | null = null;
  private readonly now: () => number;
  private detached = false;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now || Date.now;
  }

  observe(method: string, params: unknown): void {
    if (this.detached) return;

    if (method === "item/agentMessage/delta") {
      this.active = null;
      return;
    }

    if (method === "item/started" || method === "item/commandExecution" || method === "item/fileChange") {
      const item = getItem(params);
      const label = labelForItem(item, method);
      const itemId = getItemId(item, params);
      if (!label || !itemId) return;
      if (this.active?.itemId === itemId && this.active.label === label) return;
      this.active = {
        itemId,
        label,
        startedAt: this.now(),
        lastReportedKey: null,
        waitReported: false,
      };
      return;
    }

    if (method === "item/completed") {
      const item = getItem(params);
      const itemId = getItemId(item, params);
      if (!itemId || this.active?.itemId === itemId) this.active = null;
      return;
    }

    if (method === "turn/completed" || method === "error") {
      this.active = null;
    }
  }

  poll(): PhaseSnapshot | null {
    if (this.detached || !this.active) return null;
    const elapsedMs = Math.max(0, this.now() - this.active.startedAt);

    if (!this.active.lastReportedKey) {
      const key = `using:${this.active.itemId}:${this.active.label}`;
      this.active.lastReportedKey = key;
      return {
        text: `[${statusPrefix()}: using ${this.active.label}…]`,
        kind: "phase",
        itemId: this.active.itemId,
        label: this.active.label,
        elapsedMs,
      };
    }

    if (elapsedMs >= TOOL_WAIT_THRESHOLD_MS && !this.active.waitReported) {
      this.active.waitReported = true;
      const seconds = Math.max(1, Math.round(elapsedMs / 1000));
      return {
        text: `[${statusPrefix()}: waiting for ${this.active.label}, ${seconds}s…]`,
        kind: "wait",
        itemId: this.active.itemId,
        label: this.active.label,
        elapsedMs,
      };
    }

    return null;
  }

  detach(): void {
    this.detached = true;
    this.active = null;
  }
}

export function attachPhaseTracker(options: { now?: () => number } = {}): PhaseTracker {
  return new PhaseTracker(options);
}

function getItem(params: unknown): Record<string, unknown> | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (record.item && typeof record.item === "object") return record.item as Record<string, unknown>;
  return record;
}

function getItemId(item: Record<string, unknown> | null, params: unknown): string | undefined {
  const fromItem = typeof item?.id === "string" ? item.id : undefined;
  if (fromItem) return fromItem;
  if (params && typeof params === "object") {
    const record = params as Record<string, unknown>;
    if (typeof record.itemId === "string") return record.itemId;
  }
  return undefined;
}

function labelForItem(item: Record<string, unknown> | null, method: string): string | null {
  const type = typeof item?.type === "string" ? item.type : undefined;
  if (type === "commandExecution" || method === "item/commandExecution") return "shell";
  if (type === "fileChange" || method === "item/fileChange") return "files";
  if (type === "plan") return "plan";
  return null;
}
