/**
 * Module-level state bridging the DOM context-menu listener and the React
 * dialog component: the listener opens the dialog, the component renders it.
 * Kept tiny and dependency-free for the demo.
 *
 * @module dsh-do/client/addWorkspace
 */
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
/** The dialog's open state and the anchor position of the triggering right-click. */
export interface AddWorkspaceDialogState {
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
}
export declare function setWorkspacesService(service: IWorkspaces): () => void;
export declare function getWorkspacesService(): IWorkspaces | undefined;
/** Read the current dialog state (useSyncExternalStore snapshot). */
export declare function getAddWorkspaceDialogState(): AddWorkspaceDialogState;
/** Subscribe to dialog state changes; returns the disposer. */
export declare function subscribeAddWorkspaceDialog(listener: () => void): () => void;
/** Open the dialog at the given viewport coordinates (from a right-click). */
export declare function openAddWorkspaceDialog(x: number, y: number): void;
/** Apply an asynchronous result only to the exact dialog opening that requested it. */
export declare function isCurrentWorkspaceDialog(snapshot: AddWorkspaceDialogState): boolean;
/** Close the dialog. */
export declare function closeAddWorkspaceDialog(): void;
//# sourceMappingURL=addWorkspace.d.ts.map