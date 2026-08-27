import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentCancelCause } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session';

export interface RetryConfig {
  enabled: boolean;
  maxRetries: number;
  retryDelayMs: number;
  backoffMultiplier: number;
  retryPrompt: string;
}

export interface LoopDetectorConfig {
  enabled: boolean;
  threshold: number;
  maxRepeatLength: number;
  checkInterval: number;
  retry: RetryConfig;
}

export const LoopDetectorConfig: LoopDetectorConfig = {
  enabled: true,
  threshold: 3,
  maxRepeatLength: 100,
  checkInterval: 5000,
  retry: {
    enabled: true,
    maxRetries: 3,
    retryDelayMs: 1000,
    backoffMultiplier: 2,
    retryPrompt: 'You were detected to be looping on repeated text. Try again with a different structure and avoid repeating the same segment.',
  },
};

type TimerId = ReturnType<typeof setTimeout>;

interface AgentHistoryEntry {
  agent: Agent;
  texts: string[];
  attempts: number;
}

export class LoopDetectorService {
  static Config = LoopDetectorConfig;
  private agentHistories = new Map<SessionId, AgentHistoryEntry>();
  private retryTimers = new Map<SessionId, TimerId>();

  constructor(
    private readonly ctx: Context,
    private readonly config: LoopDetectorConfig,
  ) {}

  async install(): Promise<void> {
    this.ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: Agent; message: UserMessage }) => {
      if (!this.config.enabled) return;
      const text = this.flattenMessage(message);
      if (text.length === 0) return;
      this.addHistory(agent, text);
    });

    this.ctx.effect(() => {
      const timer = setInterval(() => {
        this.checkAllLoops();
      }, this.config.checkInterval);
      return () => clearInterval(timer);
    });
  }

  private flattenMessage(message: UserMessage): string {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
      else if ('value' in block && typeof block.value === 'string') parts.push(block.value);
    }
    return parts.join('\n');
  }

  private addHistory(agent: Agent, text: string): void {
    let entry = this.agentHistories.get(agent.id) ?? {
      agent,
      texts: [],
      attempts: 1,
    };
    entry.agent = agent;
    entry.texts.push(text);
    if (entry.texts.length > 10) entry.texts.shift();
    this.agentHistories.set(agent.id, entry);
  }

  private getAttempts(agentId: SessionId): number {
    return this.agentHistories.get(agentId)?.attempts ?? 1;
  }

  private nextAttempt(agentId: SessionId): number {
    const entry = this.agentHistories.get(agentId);
    if (!entry) return 1;
    const next = entry.attempts + 1;
    entry.attempts = next;
    return next;
  }

  private resetAttempts(agentId: SessionId): void {
    const entry = this.agentHistories.get(agentId);
    if (entry) entry.attempts = 1;
  }

  private retryMessage(attempt: number): string {
    return `[retry #${attempt}] ${this.config.retry.retryPrompt}`;
  }

  private scheduleRetry(agent: Agent, attempt: number, repeats: string[]): void {
    const delayMs =
      this.config.retry.retryDelayMs *
      Math.pow(
        this.config.retry.backoffMultiplier,
        Math.max(attempt - 1, 0),
      );

    this.ctx.logger.warn(
      `Detected loop for agent ${agent.id} (attempt ${attempt}); retrying in ${delayMs}ms with fresh follow-up`,
    );

    const timer = setTimeout(() => {
      this.performRetry(agent, attempt, repeats);
    }, delayMs);

    this.retryTimers.set(agent.id, timer);
  }

  private performRetry(agent: Agent, attempt: number, repeats: string[]): void {
    const entry = this.agentHistories.get(agent.id);
    if (!entry) return;

    const recent = entry.texts.slice(-this.config.threshold).join('\n');
    const content = [
      {
        type: 'text' as const,
        text: `${this.retryMessage(attempt)}\n\nRecent repeated segment sample:\n${repeats[0] ?? ''}\n\nRecent history:\n${recent}`,
      },
    ];

    try {
      agent.followup(createUserMessage({ content, source: { kind: 'plugin' as const, plugin: 'dsh-loop-detector' } }));
      this.resetAttempts(agent.id);
    } catch (error) {
      this.ctx.logger.error(`Failed to retry agent ${agent.id}: ${error}`);
      this.abortAgent(agent.id);
    }
  }

  private checkAllLoops(): void {
    for (const [agentId, entry] of this.agentHistories.entries()) {
      if (entry.texts.length < this.config.threshold) continue;

      const repeats = this.findRepeatingSegments(entry.texts, this.config.maxRepeatLength);
      if (repeats.length === 0) continue;

      const agent = this.ctx.agents.get(agentId as SessionId) as Agent | undefined;
      if (!agent) {
        this.cleanupAgentState(entry.agent.id);
        continue;
      }

      const currentAttempt = this.getAttempts(entry.agent.id);
      if (this.config.retry.enabled && currentAttempt <= this.config.retry.maxRetries) {
        this.scheduleRetry(agent, this.nextAttempt(entry.agent.id), repeats);
        continue;
      }

      this.ctx.logger.warn(
        `Detected loop for agent ${agentId}, repeating segments: ${repeats.join(', ')}`,
      );
      this.abortAgent(entry.agent.id);
    }
  }

  private abortAgent(agentId: SessionId): void {
    const agent = this.ctx.agents.get(agentId) as Agent | undefined;
    if (!agent) return;
    agent.cancel({ kind: 'hook', reason: 'plugin:loop-detector' } as AgentCancelCause);
    this.cleanupAgentState(agentId);
  }

  private cleanupAgentState(agentId: SessionId): void {
    this.agentHistories.delete(agentId);
    const timer = this.retryTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(agentId);
    }
  }

  private findRepeatingSegments(history: string[], minLength: number): string[] {
    const repeats: string[] = [];
    if (history.length < 2) return repeats;
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const segments = this.getCommonSegments(last, prev, minLength);
    repeats.push(...segments);
    return [...new Set(repeats)];
  }

  private getCommonSegments(a: string, b: string, minLength: number): string[] {
    const segments: string[] = [];
    const aLen = a.length;
    const bLen = b.length;
    if (aLen < minLength || bLen < minLength) return segments;

    for (let i = 0; i <= aLen - minLength; i++) {
      for (let j = minLength; j <= aLen - i; j++) {
        const substr = a.substring(i, i + j);
        if (b.includes(substr)) {
          segments.push(substr);
        }
      }
    }

    return segments.sort((a, b) => b.length - a.length);
  }
}

export default function apply(ctx: Context, config: LoopDetectorConfig): void {
  const service = new LoopDetectorService(ctx, config);
  ctx.effect(() => {
    void service.install();
    return () => undefined;
  }, 'loop-detector');
}
