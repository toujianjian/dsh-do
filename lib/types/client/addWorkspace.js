let state = { open: false, x: 0, y: 0 };
const listeners = new Set();
/** The workspaces service face captured at plugin apply time (root-scoped UI has no other handle). */
let workspacesService;
export function setWorkspacesService(service) {
    workspacesService = service;
}
export function getWorkspacesService() {
    return workspacesService;
}
/** Read the current dialog state (useSyncExternalStore snapshot). */
export function getAddWorkspaceDialogState() {
    return state;
}
/** Subscribe to dialog state changes; returns the disposer. */
export function subscribeAddWorkspaceDialog(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
/** Open the dialog at the given viewport coordinates (from a right-click). */
export function openAddWorkspaceDialog(x, y) {
    state = { open: true, x, y };
    for (const listener of listeners)
        listener();
}
/** Close the dialog. */
export function closeAddWorkspaceDialog() {
    state = { open: false, x: 0, y: 0 };
    for (const listener of listeners)
        listener();
}
//# sourceMappingURL=addWorkspace.js.map