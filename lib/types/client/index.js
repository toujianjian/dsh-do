import { openAddWorkspaceDialog, setWorkspacesService } from "./addWorkspace.js";
import { DoSettingsPage } from "./DoSettingsPage.js";
import { GitHubSearchButton } from "./GitHubSearchButton.js";
/** Required services: the slot registry and the workspaces face. */
export const inject = ['slots', 'workspaces'];
/** Selectors matching the sidebar's native add-workspace button in both shipped locales. */
const ADD_WORKSPACE_BUTTON_SELECTOR = 'button[aria-label="添加工作区"], button[aria-label="Add workspace"]';
/**
 * Browser plugin body: the sidebar-footer GitHub search entry plus the
 * right-click wiring for the native add-workspace button.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => setWorkspacesService(ctx.workspaces), 'dsh-do: workspace dialog state');
    ctx.effect(() => {
        const onContextMenu = (event) => {
            const target = event.target;
            if (!(target instanceof Element))
                return;
            const button = target.closest(ADD_WORKSPACE_BUTTON_SELECTOR);
            if (button === null)
                return;
            // Reuse the existing button: a right-click opens the paste-a-path dialog
            // instead of the native pick flow.
            event.preventDefault();
            openAddWorkspaceDialog(event.clientX, event.clientY);
        };
        document.addEventListener('contextmenu', onContextMenu);
        return () => document.removeEventListener('contextmenu', onContextMenu);
    }, 'dsh-do: add-workspace context menu');
    ctx.slots.inject('sidebar.footer.action', () => {
        const dispose = ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-do-github',
            order: 10,
            label: 'GitHub 插件搜索',
        }, GitHubSearchButton);
        return dispose;
    });
    // The dsh-DO settings page. `slots.inject` waits for the settings shell to
    // declare `settings.section`, so a deployment without a settings surface keeps
    // the sidebar entry and simply shows no page.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-do',
        order: 40,
        label: 'dsh-DO',
    }, DoSettingsPage));
}
//# sourceMappingURL=index.js.map