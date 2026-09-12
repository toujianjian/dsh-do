/**
 * dsh-loop-detector …?DSH Standard component.
 *
 * Detects model self-loops (long repeated text segments across recent
 * messages) through the `messages.dsh/v1alpha1` `MessageObserver` protocol,
 * records detection snapshots, and contributes `loop-detector.status` /
 * `loop-detector.clear` commands.
 *
 * The MessageObserver protocol is read-only by design; this component does not
 * cancel or rewrite messages. Hosts that want automatic termination can wire
 * the exported `detectRepeat` / `LoopDetector` helpers to native agent control
 * outside the standard protocol surface.
 *
 * @module dsh-loop-detector
 */
import { type FacetModule } from '@dsh-std/sdk';
/** MessageObserver client surface this component expects after negotiation. */
export interface MessageObserverClient {
    subscribe(handler: (event: MessageObserverEvent) => void, scope?: string): () => void;
}
export interface MessageObserverEvent {
    readonly eventType: 'messages.observe';
    readonly eventVersion: '0.15';
    readonly eventId: string;
    readonly scope: string;
    readonly sequence: number;
    readonly privacyClass: 'public' | 'internal' | 'sensitive';
    readonly summary: string;
    readonly payload: {
        readonly kind: 'message.created' | 'message.received' | 'message.sent';
        readonly messageId?: string;
        readonly author?: string;
        readonly content: ReadonlyArray<{
            type: 'text';
            text: string;
        } | {
            type: 'image';
            data: string;
            mimeType: string;
        }>;
        readonly truncated?: boolean;
    };
}
/** Typed accessor for the negotiated MessageObserver client. */
export declare const messageObserverKey: import("@dsh-std/sdk").ProtocolKey<MessageObserverClient>;
export interface LoopDetectorOptions {
    threshold: number;
    minRepeatLength: number;
    maxHistory: number;
}
export declare const DEFAULT_OPTIONS: LoopDetectorOptions;
export interface LoopDetectionRecord {
    readonly scope: string;
    readonly detectedAt: number;
    readonly repeatingSegments: readonly string[];
    readonly recentTexts: readonly string[];
}
/** Pure repetition detector over the most recent message texts. */
export declare function detectRepeat(texts: readonly string[], options?: LoopDetectorOptions): readonly string[];
/** Session-scoped detector state. */
export declare class LoopDetector {
    private readonly options;
    private readonly history;
    private readonly records;
    constructor(options?: LoopDetectorOptions);
    observe(scope: string, text: string): LoopDetectionRecord | undefined;
    status(scope?: string): readonly LoopDetectionRecord[];
    clear(scope?: string): void;
}
export declare function detector(): LoopDetector;
export interface LoopDetectorCommandHandler {
    execute(input: {
        readonly rawInput: string;
    }, context: {
        readonly signal: AbortSignal;
    }): {
        kind: 'success';
        text: string;
    } | {
        kind: 'error';
        text: string;
    };
}
export declare const commandHandlers: ReadonlyRecord<string, LoopDetectorCommandHandler>;
type ReadonlyRecord<K extends string, V> = {
    readonly [P in K]: V;
};
export declare const loopDetectorFacet: FacetModule;
export default loopDetectorFacet;
