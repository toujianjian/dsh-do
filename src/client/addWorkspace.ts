/**
 * Module-level state bridging the DOM context-menu listener and the React
 * dialog component: the listener opens the dialog, the component renders it.
 * Kept tiny and dependency-free for the demo.
 *
 * @module dsh-do/client/addWorkspace
 */
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'

/** The dialog's open state and the anchor position of the triggering right-click. */
export interface AddWorkspaceDialogState {
  readonly open: boolean
  readonly x: number
  readonly y: number
}

let state: AddWorkspaceDialogState = { open: false, x: 0, y: 0 }
const listeners = new Set<() => void>()

/** The workspaces service face captured at plugin apply time (root-scoped UI has no other handle). */
let workspacesService: IWorkspaces | undefined

export function setWorkspacesService(service: IWorkspaces): void {
  workspacesService = service
}

export function getWorkspacesService(): IWorkspaces | undefined {
  return workspacesService
}

/** Read the current dialog state (useSyncExternalStore snapshot). */
export function getAddWorkspaceDialogState(): AddWorkspaceDialogState {
  return state
}

/** Subscribe to dialog state changes; returns the disposer. */
export function subscribeAddWorkspaceDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Open the dialog at the given viewport coordinates (from a right-click). */
export function openAddWorkspaceDialog(x: number, y: number): void {
  state = { open: true, x, y }
  for (const listener of listeners) listener()
}

/** Close the dialog. */
export function closeAddWorkspaceDialog(): void {
  state = { open: false, x: 0, y: 0 }
  for (const listener of listeners) listener()
}
