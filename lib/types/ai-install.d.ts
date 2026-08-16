import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
/** Route and body budget for the bridge. */
export declare const AI_INSTALL_PATH = "/dsh-do/ai-install";
/** Read and JSON-parse a bounded request body. */
export declare function readJsonBody(req: IncomingMessage): Promise<unknown>;
/**
 * Install the `POST /dsh-do/ai-install` route. Lazy sibling injection for the
 * web server; the agents service is required to spawn the install session.
 * @param ctx - the plugin context.
 */
export declare function installAiInstallRoute(ctx: Context): void;
