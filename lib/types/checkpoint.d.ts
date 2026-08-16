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
    /** Load every checkpoint file; returns loops keyed by session id. */
    load(): Promise<Map<string, LoopState>>;
    /** Atomically persist one loop, serialized per file. */
    write(loop: LoopState): Promise<void>;
}
