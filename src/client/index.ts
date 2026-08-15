/**
 * dsh-DO browser half: the floating orb (draggable suggestion panel + real
 * GitHub `dsh-plugin` search) and the right-click "add workspace" flow that
 * reuses the sidebar's native add-workspace button.
 *
 * @module dsh-do/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout SlotMap merge that declares `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-slots SlotMap/registration vocabulary.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { openAddWorkspaceDialog, setWorkspacesService } from './addWorkspace.ts'
import { FloatingOrb } from './FloatingOrb.tsx'

/** Required services: the slot registry and the workspaces face. */
export const inject = ['slots', 'workspaces']

/** Selectors matching the sidebar's native add-workspace button in both shipped locales. */
const ADD_WORKSPACE_BUTTON_SELECTOR = 'button[aria-label="添加工作区"], button[aria-label="Add workspace"]'

/**
 * Browser plugin body: right-click wiring for the native add-workspace
 * button plus the shell.overlay entry that renders the orb and dialogs.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  setWorkspacesService(ctx.workspaces)

  ctx.effect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest(ADD_WORKSPACE_BUTTON_SELECTOR)
      if (button === null) return
      // Reuse the existing button: a right-click opens the paste-a-path dialog
      // instead of the native pick flow.
      event.preventDefault()
      openAddWorkspaceDialog(event.clientX, event.clientY)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, 'dsh-do: add-workspace context menu')

  ctx.slots.inject('shell.overlay', () => {
    const dispose = ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-do',
      order: 90,
    }, FloatingOrb)
    return dispose
  })
}
