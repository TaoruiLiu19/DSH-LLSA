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

/** Host-visible request settings, not a verified provider limit or billing cap. */
export interface RequestLimitObservation {
  requestedMaxOutputTokens: number | null;
  observedStatus: 'explicit' | 'not_set' | 'invalid';
  observationBoundary: 'llm_stream_options';
  reservationMaxOutputTokens: number;
  reservationSource: 'request_option' | 'configured_estimate';
  providerEffectiveLimit: 'unknown';
}

export type TokenAdmission = { scope: 'run' } | { scope: 'coordinator_turn'; turn: number; startSeq: number };
export interface CallAccountingContext {
  accountingScope: 'shared_coordinator' | 'ticket_execution' | 'standalone';
  ticketId: string | null;
  assignmentId: string | null;
  attributionBasis: 'host_run_binding';
  requestLimits: RequestLimitObservation;
}

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
  canStartFree?(): boolean;
  isFreeRoute?(provider: string, model: string): boolean;
  modelProfile?(sessionId: string): string;
  getAgent?(sessionId: string): unknown;
  start(options: {
    parent: unknown;
    childId: string;
    prompt: string;
    label: string;
    maxOutputTokens: number;
    paid?: boolean;
  }): Promise<AgentHandle> | AgentHandle;
  deliver(message: {
    recipientId: string; senderId: string; runId: string; messageId: string; text: string;
  }): Promise<{ includedInRequest?: boolean; persisted?: boolean; [key: string]: unknown }>;
}

export interface AgentHandle {
  result: Promise<unknown>;
  dispose(): unknown;
}
