/** Values accepted by the exact JSON boundary. Runtime validation also rejects lossy numbers. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface ArtifactMetadata {
  id: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  createdAt: string;
}

export interface EventQuery { asOfSeq?: number; afterSeq?: number; limit?: number }
export interface StepQuery { attemptId?: string; asOfSeq?: number; eventId?: string }
export interface ArtifactRange { start?: number; end?: number }

export interface RunInput {
  id?: string;
  runId?: string;
  ticketId: string;
  assignmentId: string;
  title?: string;
  source?: string;
  rootSessionId?: string;
  createdAt?: string;
}

export interface EventInput {
  id?: string;
  eventId?: string;
  runId: string;
  stepId: string;
  attemptId?: string;
  kind: string;
  payload?: JsonValue;
  parents?: string[];
  inputRefs?: string[];
  createdAt?: string;
}

/** Minimal adapter contract; the backend owns lifecycle and real DSH handles. */
export interface Backend {
  modelProfile?(sessionId: string): string;
  getAgent?(sessionId: string): unknown;
  start(options: {
    parent: unknown;
    childId: string;
    prompt: string;
    label: string;
    maxOutputTokens: number;
  }): Promise<AgentHandle> | AgentHandle;
  deliver(message: {
    recipientId: string; senderId: string; runId: string; messageId: string; text: string;
  }): Promise<{ includedInRequest?: boolean; persisted?: boolean; [key: string]: unknown }>;
}

export interface AgentHandle {
  result: Promise<unknown>;
  dispose(): unknown;
}
