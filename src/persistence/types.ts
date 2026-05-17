import { Message, ToolConfirmationRequest } from '../core/types.js';

export type SessionStatus = 'idle' | 'running' | 'waiting_confirmation' | 'completed' | 'failed';

export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';

export interface SessionRecord {
  id: string;
  projectId: string;
  actorId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastInput?: string;
  lastError?: string;
}

export interface SessionSnapshotRecord {
  sessionId: string;
  messages: Message[];
  updatedAt: string;
}

export interface ConfirmationRequestRecord {
  id: string;
  sessionId: string;
  projectId: string;
  tool: string;
  riskLevel: 'low' | 'medium' | 'high';
  args: Record<string, unknown>;
  reason: string;
  callId?: string;
  status: ConfirmationStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface ConfirmationDecisionRecord {
  id: string;
  requestId: string;
  sessionId: string;
  decision: 'approved' | 'rejected';
  actor?: string;
  reason?: string;
  createdAt: string;
}

export interface ApprovalGrantRecord {
  requestId: string;
  sessionId: string;
  tool: string;
  callId?: string;
  args: Record<string, unknown>;
  approvedAt: string;
  approvedBy?: string;
  reason?: string;
  expiresAt?: string;
  revokedAt?: string;
  consumedAt?: string;
}

export interface ToolExecutionRecord {
  id: string;
  sessionId: string;
  tool: string;
  callId?: string;
  args: Record<string, unknown>;
  status: 'started' | 'finished' | 'failed' | 'waiting_confirmation' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  result?: Record<string, unknown>;
}

export interface SessionRestoreState {
  session?: SessionRecord;
  snapshot?: SessionSnapshotRecord;
  pendingConfirmations: ToolConfirmationRequest[];
  approvalGrants: ApprovalGrantRecord[];
}
