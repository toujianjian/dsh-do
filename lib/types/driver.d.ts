import type { Context } from '@deepseek-ai/cordis';
import type { LoopController } from './controller.js';
/**
 * Install the round-continuation driver for one plugin context. The driver
 * effect owns its teardown (joins every in-flight run, disarms every loop).
 * When `restore` is supplied, listeners are installed only after it settles,
 * and agents already idle at that point are nudged so a restored armed loop
 * resumes without waiting for the next status transition.
 */
export declare function installLoopDriver(ctx: Context, controller: LoopController, restore?: Promise<void>): void;
