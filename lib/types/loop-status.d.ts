/**
 * The loop status surface: one `loop` session projection registered exactly the
 * way the harness goal plugin registers `goal`, plus a `loops` service that a
 * terminal client can read the same way it reads `goals`.
 *
 * The projection is what makes a loop visible while it runs. Without it a loop
 * that the driver stopped (a cancelled round, an aborted turn, a model that ran
 * out of output budget) simply goes quiet: the checkpoint records `armed:false`
 * and nothing else tells the human that work stopped, or why.
 *
 * @module dsh-do/loop-status
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LoopController } from './controller.js';
import { type LoopState } from './loop.js';
/**
 * The session-projection registry, declared locally: it ships with the runtime
 * (`@deepseek-ai/dsh-session-projection`) but is not part of the DSH type
 * surface this package builds against. Only the face this module uses is
 * declared, and the registration is gated behind `ctx.inject`, so a profile
 * without the registry simply never runs it.
 */
interface SessionProjectionDefinition {
    readonly key: string;
    readonly schema: {
        parse(value: unknown): unknown;
    };
    readonly init: () => unknown;
    readonly apply: (state: never, event: never) => unknown;
    readonly view: (state: never) => unknown;
    readonly stateVersion: number;
}
interface SessionProjectionRegistry {
    register(definition: SessionProjectionDefinition): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Optional: present only when the session-projection registry is mounted. */
        sessionProjections?: SessionProjectionRegistry;
        /** Status surface for live loops; registered by this plugin. */
        loops: LoopsService;
    }
}
/**
 * Snapshot of one loop, flat and JSON-shaped so any carrier can render it.
 * This is the read face a status line, a panel, or a projection consumer uses.
 */
export interface LoopStatusView {
    /** `active` while the loop may still take rounds. */
    readonly phase: LoopState['phase'];
    /** Whether the driver may queue the next round by itself. */
    readonly armed: boolean;
    readonly loopId: string;
    /** Admitted rounds, counted from the durable session log. */
    readonly roundsStarted: number;
    readonly maxRounds: number;
    readonly objective: string;
    /** Minimum delay between rounds, when the loop was given a cadence. */
    readonly intervalMs?: number;
    /**
     * Why an active loop is not continuing. Present exactly when it is active and
     * disarmed, which is the state a human cannot otherwise distinguish from
     * "still working".
     */
    readonly pausedReason?: {
        readonly code: string;
        readonly message: string;
        readonly at: number;
    };
    /** Terminal outcome, mirroring the checkpoint's own fields. */
    readonly completedSummary?: string;
    readonly blockedReason?: {
        readonly code: string;
        readonly message: string;
    };
    readonly cancelledReason?: string;
}
/** The projection/state a status consumer holds for one session. */
export interface LoopProjectionState {
    /** Loop id of the most recent admitted round, or null before any round ran. */
    readonly loopId: string | null;
    /** Highest round admitted into the log, folded from the durable events. */
    readonly roundsStarted: number;
    /** Epoch ms of the most recent admitted round, when the event carries one. */
    readonly lastRoundAt: number | null;
}
/**
 * Pure fold of one loop round event into the projection state. Replay-safe by
 * construction: it depends only on the events, never on live plugin state.
 */
export declare function applyLoopProjection(state: LoopProjectionState | null, event: {
    type?: string;
    data?: unknown;
}): LoopProjectionState | null;
/**
 * Build the flat, JSON-only view of one loop. Reads leaf fields and constructs
 * an owned object: no live Cordis/DSH object crosses this boundary.
 * @param agent - live agent owning the loop, used for durable round accounting.
 */
export declare function loopStatusView(loop: LoopState, agent?: Agent): LoopStatusView;
/**
 * One-line human summary, shared by every surface so the wording of a stop is
 * identical in the client panel, the TUI status line, and the model's own
 * `loop_status` output.
 */
export declare function renderLoopStatusLine(view: LoopStatusView): string;
/** The `loops` service a terminal client reads. Mirrors the `goals` service shape. */
export interface LoopsService {
    /** The status of one agent's loop, or `undefined` when it has none. */
    get(agent: Agent): LoopStatusView | undefined;
    /** Every live loop, keyed by session id. */
    list(): ReadonlyMap<string, LoopStatusView>;
}
/**
 * Install the loop status surface: a `loops` service and a `loop` session
 * projection. Both are effects of the calling fiber, so unloading the plugin
 * removes the service, the projection key, and every snapshot contribution.
 * @param controller - the loop registry this surface reports on.
 */
export declare function installLoopStatus(ctx: Context, controller: LoopController): void;
export {};
