/**
 * The dsh-DO settings page: one settings section that owns both the plugin's
 * own configuration (loop budget, checkpointing, model-loop detection) and the
 * retry policy of whichever provider adapters the deployment serves.
 *
 * The page stages every edit locally and writes only on save, so what is on
 * screen is exactly what a save would store. Reads and writes both travel
 * through `/dsh-do/settings`; the Host remains the only authority on whether a
 * value is acceptable, and a refused write keeps the draft so the user can
 * correct it.
 *
 * @module dsh-do/client/DoSettingsPage
 */
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import { type ReactElement } from 'react';
/**
 * The settings page body.
 * @param props - the section owner share (the shell supplies `close`).
 */
export declare function DoSettingsPage(props: SettingsSectionOwnerProps): ReactElement;
//# sourceMappingURL=DoSettingsPage.d.ts.map