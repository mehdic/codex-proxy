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
        text: `[progress: using ${this.active.label}…]`,
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
        text: `[progress: waiting for ${this.active.label}, ${seconds}s…]`,
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
