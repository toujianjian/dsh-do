/**
 * dsh-DO browser half: a GitHub search entry in the sidebar footer
 * (`sidebar.footer.action`, GitHub icon) whose panel searches GitHub for
 * `dsh-plugin` projects with per-hit "AI install", plus the right-click
 * "add workspace" flow that reuses the sidebar's native add-workspace button.
 *
 * @module dsh-do/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Required services: the slot registry and the workspaces face. */
export declare const inject: string[];
/**
 * Browser plugin body: the sidebar-footer GitHub search entry plus the
 * right-click wiring for the native add-workspace button.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map