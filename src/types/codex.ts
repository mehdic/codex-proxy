/**
 * Types for the Codex app-server JSON-RPC protocol over stdio.
 *
 * Derived from `codex app-server generate-ts` output. Only the subset
 * needed for the proxy is included; the full schema has 400+ types.
 */

// ── JSON-RPC envelope ───────────────────────────────────────────────

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Initialize ──────────────────────────────────────────────────────

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ── Thread ──────────────────────────────────────────────────────────

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never";

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  ephemeral?: boolean | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

export interface Thread {
  id: string;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  cwd: string;
  cliVersion: string;
  name: string | null;
  turns: Turn[];
}

export type ThreadStatus = "ready" | "active" | "closed";

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
}

// ── Turn ────────────────────────────────────────────────────────────

export interface UserInput {
  type: "text";
  text: string;
  text_elements: unknown[];
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface TurnError {
  message: string;
  codexErrorInfo: unknown | null;
  additionalDetails: string | null;
}

// ── Thread Items ────────────────────────────────────────────────────

export type ThreadItem =
  | { type: "userMessage"; id: string; content: UserInput[] }
  | { type: "agentMessage"; id: string; text: string; phase: string | null }
  | { type: "commandExecution"; id: string; command: string; status: string; aggregatedOutput: string | null; exitCode: number | null }
  | { type: "fileChange"; id: string; changes: unknown[]; status: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "plan"; id: string; text: string }
  | { type: string; id: string; [key: string]: unknown };

// ── Notifications ───────────────────────────────────────────────────

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ItemStartedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ThreadStartedNotification {
  thread: Thread;
}

export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
  };
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

// ── Server Requests (approval requests from app-server) ─────────────

export interface ServerApprovalRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params: unknown;
}
