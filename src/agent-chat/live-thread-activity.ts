import type { AgentActivityState } from './agent-activity-publisher';

export interface LiveThreadActivityInput {
  workspaceId: string;
  channelId: string;
  threadId: string;
  agentNpub: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  lifecycle: AgentActivityState;
  commentary?: string | null;
  activityStatus?: string | null;
  timestamp: string;
}

export interface LiveThreadActivityRecord extends LiveThreadActivityInput {
  cursor: number;
}

function key(input: Pick<LiveThreadActivityInput, 'workspaceId' | 'channelId' | 'threadId' | 'agentNpub'>): string {
  return [input.workspaceId, input.channelId, input.threadId, input.agentNpub].join('\n');
}

export class LiveThreadActivityHub {
  private cursor = 0;
  private readonly retained: LiveThreadActivityRecord[] = [];
  private readonly listeners = new Set<(record: LiveThreadActivityRecord) => void>();

  constructor(private readonly retention = 500) {}

  publish(input: LiveThreadActivityInput): LiveThreadActivityRecord {
    const record = Object.freeze({ ...input, cursor: ++this.cursor });
    this.retained.push(record);
    if (this.retained.length > this.retention) this.retained.splice(0, this.retained.length - this.retention);
    for (const listener of this.listeners) listener(record);
    return record;
  }

  latest(context: Pick<LiveThreadActivityInput, 'workspaceId' | 'channelId' | 'threadId' | 'agentNpub'>): LiveThreadActivityRecord | null {
    const contextKey = key(context);
    return this.retained.findLast((record) => key(record) === contextKey) ?? null;
  }

  after(context: Pick<LiveThreadActivityInput, 'workspaceId' | 'channelId' | 'threadId' | 'agentNpub'>, cursor: number): LiveThreadActivityRecord[] | null {
    const oldest = this.retained[0]?.cursor ?? this.cursor;
    if (cursor > 0 && cursor < oldest - 1) return null;
    const contextKey = key(context);
    return this.retained.filter((record) => record.cursor > cursor && key(record) === contextKey);
  }

  subscribe(listener: (record: LiveThreadActivityRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.retained.length = 0;
    this.listeners.clear();
    this.cursor = 0;
  }
}

export const liveThreadActivityHub = new LiveThreadActivityHub();
