import type { LoopState } from './loop.js';
/** Serialize one loop to its checkpoint document. */
export declare function serializeCheckpoint(loop: LoopState): string;
/** Tolerant parse of one checkpoint file; returns the loop or a reason. */
export declare function parseCheckpoint(text: string, fileName: string): {
    ok: true;
    loop: LoopState;
} | {
    ok: false;
    error: string;
};
/** Optional diagnostic sink for checkpoint problems. */
export interface LoopStoreOptions {
    readonly onError?: (message: string) => void;
}
/**
 * File-per-loop checkpoint store. Reads are a tolerant directory scan; writes
 * are atomic and serialized per file.
 */
export declare class LoopStore {
    private readonly root;
    private readonly options;
    private readonly chains;
    constructor(root: string, options?: LoopStoreOptions);
    private path;
    /**
     * Load every checkpoint file; returns loops keyed by session id.
     *
     * Restore is the one path where a single bad entry can take down every
     * healthy one, so each file is isolated three ways: only regular files are
     * opened (a FIFO or device named `loop-*.json` would otherwise block or
     * stream forever, freezing startup before the loop tools are registered),
     * read failures are reported and skipped, and — belt and braces — an
     * unexpected throw from the parser is skipped rather than propagated, so no
     * single record can cost the rest of the session's loops.
     */
    load(): Promise<Map<string, LoopState>>;
    /** Atomically persist one loop, serialized per file. */
    write(loop: LoopState): Promise<void>;
}
