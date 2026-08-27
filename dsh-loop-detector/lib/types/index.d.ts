import type { Context } from '@deepseek-ai/cordis';
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
export declare const LoopDetectorConfig: LoopDetectorConfig;
export declare class LoopDetectorService {
    private readonly ctx;
    private readonly config;
    static Config: LoopDetectorConfig;
    private agentHistories;
    private retryTimers;
    constructor(ctx: Context, config: LoopDetectorConfig);
    install(): Promise<void>;
    private flattenMessage;
    private addHistory;
    private getAttempts;
    private nextAttempt;
    private resetAttempts;
    private retryMessage;
    private scheduleRetry;
    private performRetry;
    private checkAllLoops;
    private abortAgent;
    private cleanupAgentState;
    private findRepeatingSegments;
    private getCommonSegments;
}
export default function apply(ctx: Context, config: LoopDetectorConfig): void;
