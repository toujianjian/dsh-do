import type { Context } from '@deepseek-ai/cordis';
import type { LoopController } from './controller.js';
import type { AutoContinueSettings } from './settings.js';
/** Optional driver behaviour read live from settings. */
export interface LoopDriverOptions {
    /** Output-limit auto-continue policy; absent keeps the stop-at-max-tokens contract. */
    readonly autoContinue?: () => AutoContinueSettings;
}
/**
 * Handle exposing the driver's external wakeup to its owner.
 */
export interface LoopDriverHandle {
    /**
     * Wake the driver for one session's live agent after an external loop change
     * (a loop was started, replaced, edited, or resumed). Idempotent and safe to
     * call when no agent or loop exists: the driven pass re-reads live state and
     * declines to queue when the loop is not armed and active.
     * @param sessionId - session whose agent should be re-examined.
     */
    nudge(sessionId: string): void;
}
/**
 * Install the round-continuation driver for one plugin context. The driver
 * effect owns its teardown (joins every in-flight run, disarms every loop).
 * When `restore` is supplied, listeners are installed only after it settles,
 * and agents already idle at that point are nudged so a restored armed loop
 * resumes without waiting for the next status transition.
 * @returns the external wakeup handle the controller's change sink drives.
 */
export declare function installLoopDriver(ctx: Context, controller: LoopController, restore?: Promise<void>, options?: LoopDriverOptions): LoopDriverHandle;
