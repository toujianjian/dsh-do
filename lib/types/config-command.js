import { DSH_DO_NS } from './settings.js';
import { isTuiCommandRegistry, TUI_COMMANDS_SERVICE } from './tui.js';
/** Command name; distinct from the TUI builtin `/config` so prefixes stay unambiguous. */
export const CONFIG_COMMAND_NAME = 'do-config';
/** Every user-editable dsh-DO setting, in display order. */
export const CONFIG_FIELDS = [
    { path: 'defaultMaxRounds', type: 'integer', min: 1, help: '未指定 max_rounds 时一次循环的最大轮次' },
    { path: 'checkpointDir', type: 'string', help: '循环检查点目录，留空用 $DSH_HOME/loops' },
    { path: 'persist', type: 'boolean', help: '持久化循环状态（重启可恢复）' },
    { path: 'loopDetection.enabled', type: 'boolean', help: '检测模型重复调用同一工具' },
    { path: 'loopDetection.repeatThreshold', type: 'integer', min: 2, help: '连续相同调用多少次算循环' },
    { path: 'loopDetection.compact', type: 'boolean', help: '恢复前压缩历史' },
    { path: 'loopDetection.maxInterventions', type: 'integer', min: 1, help: '单轮最多干预次数' },
    { path: 'autoContinue.enabled', type: 'boolean', help: '输出被 token 上限截断时自动继续' },
    { path: 'autoContinue.maxContinuations', type: 'integer', min: 1, help: '连续自动继续的最大次数' },
    { path: 'autoContinue.onlyWhileLooping', type: 'boolean', help: '只在循环运行中自动继续（false=任何会话）' },
    { path: 'modelFallback.enabled', type: 'boolean', help: '模型失败时自动切换到候选模型' },
    { path: 'modelFallback.candidates', type: 'list', help: '候选模型，按顺序，写作 provider/model，逗号分隔' },
    { path: 'modelFallback.triggerCodes', type: 'list', help: '触发切换的错误码，逗号分隔' },
];
/** Parse the text after `/do-config`. */
export function parseConfigCommand(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return { kind: 'list' };
    if (trimmed === 'file' || trimmed === 'path')
        return { kind: 'file' };
    const space = trimmed.search(/\s/);
    const head = space < 0 ? trimmed : trimmed.slice(0, space);
    const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
    if (head === 'reset' || head === 'unset')
        return { kind: 'reset', path: rest };
    if (rest === '')
        return { kind: 'show', path: head };
    // Accept `path=value` and `path value` alike.
    return { kind: 'set', path: head, raw: rest };
}
/** Split `a=b` written as one token. */
function splitAssignment(command) {
    if (command.kind !== 'show')
        return command;
    const eq = command.path.indexOf('=');
    if (eq <= 0)
        return command;
    return { kind: 'set', path: command.path.slice(0, eq), raw: command.path.slice(eq + 1) };
}
/** Find a field by exact path, or by a unique case-insensitive suffix (`candidates`). */
export function findField(path) {
    const exact = CONFIG_FIELDS.find((field) => field.path === path);
    if (exact !== undefined)
        return exact;
    const lower = path.toLowerCase();
    const matches = CONFIG_FIELDS.filter((field) => field.path.toLowerCase() === lower || field.path.toLowerCase().endsWith(`.${lower}`));
    return matches.length === 1 ? matches[0] : undefined;
}
/**
 * Coerce a loosely typed value. Formatting is deliberately forgiving: booleans
 * accept on/off/yes/no/开/关, lists accept commas, spaces, or a JSON array.
 */
export function coerceValue(field, raw) {
    const text = raw.trim();
    switch (field.type) {
        case 'boolean': {
            const lower = text.toLowerCase();
            if (['true', 'on', 'yes', 'y', '1', '开', '开启', '是'].includes(lower))
                return { ok: true, value: true };
            if (['false', 'off', 'no', 'n', '0', '关', '关闭', '否'].includes(lower))
                return { ok: true, value: false };
            return { ok: false, error: `${field.path} 需要 true/false（也接受 on/off、开/关）` };
        }
        case 'integer': {
            const value = Number(text);
            if (!Number.isSafeInteger(value))
                return { ok: false, error: `${field.path} 需要整数` };
            if (field.min !== undefined && value < field.min)
                return { ok: false, error: `${field.path} 不能小于 ${field.min}` };
            return { ok: true, value };
        }
        case 'string':
            return { ok: true, value: text === '""' || text === "''" ? '' : text };
        case 'list': {
            if (text.startsWith('[')) {
                try {
                    const parsed = JSON.parse(text);
                    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'))
                        return { ok: true, value: parsed.map((item) => item.trim()).filter(Boolean) };
                }
                catch {
                    // fall through to the loose form
                }
            }
            if (text === '' || text === '[]' || text === '-')
                return { ok: true, value: [] };
            return { ok: true, value: text.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean) };
        }
    }
}
/** Read a dotted path out of a plain object. */
export function readPath(value, path) {
    let current = value;
    for (const key of path.split('.')) {
        if (current === null || typeof current !== 'object')
            return undefined;
        current = current[key];
    }
    return current;
}
/** Display form of a value. */
export function formatSetting(value) {
    if (Array.isArray(value))
        return value.length === 0 ? '[]' : value.join(', ');
    if (value === '')
        return '""';
    if (value === undefined)
        return '—';
    return String(value);
}
/** Every line `/do-config` prints for the full listing. */
export function renderConfigListing(resolved) {
    const lines = ['dsh-do 设置（/do-config <路径> <值> 修改，/do-config reset <路径> 恢复默认）'];
    for (const field of CONFIG_FIELDS)
        lines.push(`  ${field.path} = ${formatSetting(readPath(resolved, field.path))}    # ${field.help}`);
    return lines;
}
/**
 * Run one `/do-config` command against the settings service.
 *
 * @param settings - the settings service, or undefined when none is mounted.
 * @param text - the text after the command name.
 * @param fileHint - where the settings document lives, for `file`.
 */
export async function executeConfigCommand(settings, text, fileHint) {
    if (settings === undefined) {
        return { ok: false, lines: ['当前组合没有挂载 settings 服务，dsh-do 设置只能来自 cordis.patch.yml 的组合配置。'] };
    }
    const command = splitAssignment(parseConfigCommand(text));
    const resolved = settings.get(DSH_DO_NS);
    switch (command.kind) {
        case 'list':
            return { ok: true, lines: renderConfigListing(resolved) };
        case 'file':
            return {
                ok: true,
                lines: [`设置文件：${fileHint}`, '直接编辑其中的 `dsh-do:` 段即可，保存后自动生效（无需重启）。'],
            };
        case 'show': {
            const field = findField(command.path);
            if (field === undefined)
                return { ok: false, lines: [unknownPath(command.path)] };
            return { ok: true, lines: [`${field.path} = ${formatSetting(readPath(resolved, field.path))}    # ${field.help}`] };
        }
        case 'reset': {
            const field = findField(command.path);
            if (field === undefined)
                return { ok: false, lines: [unknownPath(command.path)] };
            await settings.mutate(DSH_DO_NS, [{ op: 'unset', path: field.path.split('.') }]);
            return { ok: true, lines: [`${field.path} 已恢复默认：${formatSetting(readPath(settings.get(DSH_DO_NS), field.path))}`] };
        }
        case 'set': {
            const field = findField(command.path);
            if (field === undefined)
                return { ok: false, lines: [unknownPath(command.path)] };
            const coerced = coerceValue(field, command.raw);
            if (!coerced.ok)
                return { ok: false, lines: [coerced.error] };
            await settings.mutate(DSH_DO_NS, [{ op: 'set', path: field.path.split('.'), value: coerced.value }]);
            return { ok: true, lines: [`${field.path} = ${formatSetting(readPath(settings.get(DSH_DO_NS), field.path))}（已保存，立即生效）`] };
        }
    }
}
function unknownPath(path) {
    return `未知设置「${path}」。可用：${CONFIG_FIELDS.map((field) => field.path).join('，')}`;
}
/** Normalize a thrown settings error into one line. */
function renderError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Register `/do-config` in every command registry the composition offers.
 *
 * @param ctx - the plugin context.
 */
export function installConfigCommand(ctx) {
    const settingsOf = () => {
        const service = ctx.get('settings');
        return service !== undefined && typeof service.get === 'function' && typeof service.mutate === 'function' ? service : undefined;
    };
    const fileHint = () => {
        const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '~'}/.dsh`;
        return `${home.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}settings.yaml`;
    };
    const run = async (text) => {
        try {
            return await executeConfigCommand(settingsOf(), text, fileHint());
        }
        catch (error) {
            return { ok: false, lines: [`保存失败：${renderError(error)}`] };
        }
    };
    ctx.inject(['commands'], (child) => {
        child.commands.register({
            name: CONFIG_COMMAND_NAME,
            description: 'view or change dsh-DO settings (auto-continue, model fallback, loop detection, ...)',
            input: { hint: '[<path> [<value>] | reset <path> | file]' },
            handler: async (invocation) => {
                const outcome = await run(invocation.rawInput);
                return { kind: outcome.ok ? 'success' : 'error', text: outcome.lines.join('\n') };
            },
        });
    });
    ctx.inject([TUI_COMMANDS_SERVICE], (tuiCtx) => {
        const registry = tuiCtx.get(TUI_COMMANDS_SERVICE);
        if (!isTuiCommandRegistry(registry))
            return;
        registry.register({
            name: CONFIG_COMMAND_NAME,
            description: 'dsh-DO 设置：查看/修改自动继续、模型切换、循环检测等',
            argsHint: '[<路径> [<值>] | reset <路径> | file]',
            run: async ({ text, echo }) => {
                const outcome = await run(text);
                outcome.lines.forEach((line, index) => echo(index === 0 && !outcome.ok ? `⚠ ${line}` : line));
            },
        });
        tuiCtx.effect(() => () => registry.unregister(CONFIG_COMMAND_NAME));
    });
}
//# sourceMappingURL=config-command.js.map