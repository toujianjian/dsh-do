/**
 * `/do-config`: view and change every dsh-DO setting from a command line.
 *
 * The TUI has no settings page, so a browser-only form left TUI users with
 * nothing but hand-editing YAML. This command closes that gap in both command
 * registries the plugin already reaches: the harness `commands` service (web
 * and headless) and the TUI's own `tui.commands` registry. Both write through
 * the `settings` service, so a change lands in `$DSH_HOME/settings.yaml` under
 * the `dsh-do:` section and is picked up live, exactly as a browser save.
 *
 * Syntax (paths are dotted, values are loose: `true`, `3`, `a,b` all work):
 *
 *     /do-config                      list every setting with its current value
 *     /do-config <path>               show one setting
 *     /do-config <path> <value>       set it
 *     /do-config reset <path>         drop the override (back to the default)
 *     /do-config file                 show where the settings file lives
 *
 * @module dsh-do/config-command
 */
import type { Context } from '@deepseek-ai/cordis'
import { DSH_DO_NS, isDoSection, plainSettings } from './settings.js'
import { isTuiCommandRegistry, TUI_COMMANDS_SERVICE } from './tui.js'

/** Command name; distinct from the TUI builtin `/config` so prefixes stay unambiguous. */
export const CONFIG_COMMAND_NAME = 'do-config'

/** One editable leaf: its dotted path, its value type, and what it does. */
export interface ConfigField {
	readonly path: string
	readonly type: 'boolean' | 'integer' | 'string' | 'list'
	readonly min?: number
	readonly help: string
}

/** Every user-editable dsh-DO setting, in display order. */
export const CONFIG_FIELDS: readonly ConfigField[] = [
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
]

/** One display group: a heading, a one-line hint, and the fields it holds. */
export interface ConfigGroup {
	readonly title: string
	readonly note: string
	readonly paths: readonly string[]
}

/**
 * Display grouping for the `/do-config` listing — the flat 13-line list was
 * unreadable, so related knobs are shown together under a heading.
 *
 * Every path here must exist in {@link CONFIG_FIELDS}, and every field must
 * appear exactly once; a test asserts the two cover each other.
 */
export const CONFIG_GROUPS: readonly ConfigGroup[] = [
	{
		title: '循环',
		note: '每轮推进与检查点',
		paths: ['defaultMaxRounds', 'checkpointDir', 'persist'],
	},
	{
		title: '自动继续',
		note: '输出被 token 上限截断时接着写',
		paths: ['autoContinue.enabled', 'autoContinue.maxContinuations', 'autoContinue.onlyWhileLooping'],
	},
	{
		title: '模型自动切换',
		note: '模型报错时改用候选模型',
		paths: ['modelFallback.enabled', 'modelFallback.candidates', 'modelFallback.triggerCodes'],
	},
	{
		title: '循环检测',
		note: '重复调用同一工具时干预',
		paths: ['loopDetection.enabled', 'loopDetection.repeatThreshold', 'loopDetection.compact', 'loopDetection.maxInterventions'],
	},
]

/** The slice of the settings service this command uses. */
export interface SettingsAccess {
	get(ns: string): unknown
	mutate(ns: string, ops: readonly unknown[]): Promise<unknown>
}

/** The DSH 0.2.x settings service face: sections are keyed by profile entry id. */
interface SettingsFormsFace {
	describe(options?: { redactSecrets?: boolean }): ReadonlyArray<{ ns: string; value: unknown }>
	mutate(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<unknown>
}

/** The namespace dsh-DO's section is actually filed under in this deployment. */
function locateDoSection(forms: SettingsFormsFace, fallback: string): string {
	for (const descriptor of forms.describe({ redactSecrets: true })) {
		if (isDoSection(descriptor.ns, descriptor.value)) return descriptor.ns
	}
	return fallback
}

/**
 * Present either generation of the settings service as one access face.
 *
 * DSH 0.1.x exposes `get(ns)` over namespaces the plugin registered itself. 0.2.x
 * dropped both the registration and `get`, deriving a section from the plugin
 * entry's own Config and keying it by profile entry id; `describe` and `mutate`
 * are what remain. The namespace is resolved per call because a live edit can
 * change which entry carries the section.
 *
 * @param service - the mounted settings service, if any.
 * @returns the access face, or undefined when neither shape is available.
 */
export function adaptSettingsAccess(service: unknown): SettingsAccess | undefined {
	const record = service as { get?: unknown; mutate?: unknown; describe?: unknown } | undefined
	if (record === undefined || record === null || typeof record.mutate !== 'function') return undefined
	if (typeof record.get === 'function') return service as SettingsAccess
	if (typeof record.describe !== 'function') return undefined
	const forms = service as SettingsFormsFace
	return {
		get: (ns) => {
			const wanted = locateDoSection(forms, ns)
			return forms.describe({ redactSecrets: true }).find((descriptor) => descriptor.ns === wanted)?.value
		},
		mutate: (ns, ops) => forms.mutate(locateDoSection(forms, ns), ops),
	}
}

/** Parsed command. */
export type ConfigCommand =
	| { readonly kind: 'list' }
	| { readonly kind: 'file' }
	| { readonly kind: 'show'; readonly path: string }
	| { readonly kind: 'set'; readonly path: string; readonly raw: string }
	| { readonly kind: 'reset'; readonly path: string }

/** Parse the text after `/do-config`. */
export function parseConfigCommand(text: string): ConfigCommand {
	const trimmed = text.trim()
	if (trimmed === '') return { kind: 'list' }
	if (trimmed === 'file' || trimmed === 'path') return { kind: 'file' }
	const space = trimmed.search(/\s/)
	const head = space < 0 ? trimmed : trimmed.slice(0, space)
	const rest = space < 0 ? '' : trimmed.slice(space + 1).trim()
	if (head === 'reset' || head === 'unset') return { kind: 'reset', path: rest }
	if (rest === '') return { kind: 'show', path: head }
	// Accept `path=value` and `path value` alike.
	return { kind: 'set', path: head, raw: rest }
}

/** Split `a=b` written as one token. */
function splitAssignment(command: ConfigCommand): ConfigCommand {
	if (command.kind !== 'show') return command
	const eq = command.path.indexOf('=')
	if (eq <= 0) return command
	return { kind: 'set', path: command.path.slice(0, eq), raw: command.path.slice(eq + 1) }
}

/** Find a field by exact path, or by a unique case-insensitive suffix (`candidates`). */
export function findField(path: string): ConfigField | undefined {
	const exact = CONFIG_FIELDS.find((field) => field.path === path)
	if (exact !== undefined) return exact
	const lower = path.toLowerCase()
	const matches = CONFIG_FIELDS.filter((field) => field.path.toLowerCase() === lower || field.path.toLowerCase().endsWith(`.${lower}`))
	return matches.length === 1 ? matches[0] : undefined
}

/**
 * Coerce a loosely typed value. Formatting is deliberately forgiving: booleans
 * accept on/off/yes/no/开/关, lists accept commas, spaces, or a JSON array.
 */
export function coerceValue(field: ConfigField, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const text = raw.trim()
	switch (field.type) {
		case 'boolean': {
			const lower = text.toLowerCase()
			if (['true', 'on', 'yes', 'y', '1', '开', '开启', '是'].includes(lower)) return { ok: true, value: true }
			if (['false', 'off', 'no', 'n', '0', '关', '关闭', '否'].includes(lower)) return { ok: true, value: false }
			return { ok: false, error: `${field.path} 需要 true/false（也接受 on/off、开/关）` }
		}
		case 'integer': {
			const value = Number(text)
			if (!Number.isSafeInteger(value)) return { ok: false, error: `${field.path} 需要整数` }
			if (field.min !== undefined && value < field.min) return { ok: false, error: `${field.path} 不能小于 ${field.min}` }
			return { ok: true, value }
		}
		case 'string':
			return { ok: true, value: text === '""' || text === "''" ? '' : text }
		case 'list': {
			if (text.startsWith('[')) {
				try {
					const parsed: unknown = JSON.parse(text)
					if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return { ok: true, value: parsed.map((item) => item.trim()).filter(Boolean) }
				} catch {
					// fall through to the loose form
				}
			}
			if (text === '' || text === '[]' || text === '-') return { ok: true, value: [] }
			return { ok: true, value: text.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean) }
		}
	}
}

/** Read a dotted path out of a plain object. */
export function readPath(value: unknown, path: string): unknown {
	let current = value
	for (const key of path.split('.')) {
		if (current === null || typeof current !== 'object') return undefined
		current = (current as Record<string, unknown>)[key]
	}
	return current
}

/** Display form of a value. */
export function formatSetting(value: unknown): string {
	if (Array.isArray(value)) return value.length === 0 ? '[]' : value.join(', ')
	if (value === '') return '""'
	if (value === undefined) return '—'
	return String(value)
}

/** Rendering options for the listing. */
export interface ListingOptions {
	/**
	 * Emit ANSI attributes. The TUI writes command output straight into its
	 * scrollback (which is colour-aware), but the harness `commands` service
	 * renders plain text — escapes there would surface as literal `[1m`.
	 */
	readonly color?: boolean
}

/** ANSI SGR sequences this module emits; attributes only, never a hue. */
const SGR_RE = /\u001B\[[0-9;]*m/g

/** Code points that occupy two terminal cells (CJK, fullwidth forms, emoji). */
function isWide(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0x303e) ||
		(codePoint >= 0x3041 && codePoint <= 0x33ff) ||
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
		(codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
		(codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
	)
}

/**
 * Terminal cell width of a string, counting CJK as two cells.
 *
 * ANSI sequences are dropped first so padding stays correct when the same text
 * is measured painted or unpainted.
 *
 * @param text - the text to measure.
 * @returns its width in terminal cells.
 */
export function displayWidth(text: string): number {
	let width = 0
	for (const char of text.replace(SGR_RE, '')) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1
	return width
}

/** Attribute wrappers; no-ops when colour is off. */
function makePainter(color: boolean): { bold: (text: string) => string; dim: (text: string) => string } {
	const wrap = (code: string) => (text: string) => (color ? `\u001B[${code}m${text}\u001B[0m` : text)
	return { bold: wrap('1'), dim: wrap('2') }
}

/**
 * Draw a rounded box around a title and its content rows.
 *
 * @param title - box heading.
 * @param rows - content rows (already painted; measurement strips ANSI).
 * @returns the box lines, all the same width.
 */
function renderBox(title: string, rows: readonly string[]): string[] {
	const inner = Math.max(displayWidth(title) + 4, ...rows.map((row) => displayWidth(row) + 2))
	const head = `╭─ ${title} ${'─'.repeat(Math.max(0, inner - displayWidth(title) - 3))}╮`
	const body = rows.map((row) => `│ ${row}${' '.repeat(Math.max(0, inner - displayWidth(row) - 1))}│`)
	return [head, ...body, `╰${'─'.repeat(inner)}╯`]
}

/** The four ways to drive this command, laid out two per row inside the box. */
function commandHelpRows(): string[] {
	const cells = ([
		['改', '/do-config <路径> <值>'],
		['看', '/do-config <路径>'],
		['还原', '/do-config reset <路径>'],
		['文件', '/do-config file'],
	] as ReadonlyArray<readonly [string, string]>).map(([label, body]) => `${label} ${body}`)
	const gap = Math.max(displayWidth(cells[0] ?? ''), displayWidth(cells[2] ?? '')) + 3
	const row = (left: string, right: string): string => `${left}${' '.repeat(Math.max(1, gap - displayWidth(left)))}${right}`
	return [row(cells[0] ?? '', cells[1] ?? ''), row(cells[2] ?? '', cells[3] ?? '')]
}

/** `（已关闭）` when a group owns an `enabled` switch that is off. */
function groupOffMark(group: ConfigGroup, resolved: unknown): string {
	for (const path of group.paths) {
		if (path === 'enabled' || path.endsWith('.enabled')) return readPath(resolved, path) === false ? '（已关闭）' : ''
	}
	return ''
}

/**
 * Every line `/do-config` prints for the full listing: a command box, then one
 * aligned block per group.
 *
 * @param resolved - the resolved dsh-DO config.
 * @param options - rendering options (see {@link ListingOptions}).
 * @returns the listing lines.
 */
export function renderConfigListing(resolved: unknown, options: ListingOptions = {}): string[] {
	const paint = makePainter(options.color === true)
	const pathWidth = Math.max(...CONFIG_FIELDS.map((field) => displayWidth(field.path)))
	const lines = renderBox('dsh-DO 设置', commandHelpRows())
	for (const group of CONFIG_GROUPS) {
		const off = groupOffMark(group, resolved)
		lines.push('', `${paint.bold(`◆ ${group.title}`)}${paint.dim(` · ${group.note}`)}${off === '' ? '' : paint.bold(off)}`)
		for (const path of group.paths) {
			const shown = formatSetting(readPath(resolved, path))
			const pad = ' '.repeat(Math.max(1, pathWidth - displayWidth(path) + 2))
			lines.push(`   ${paint.dim(path)}${pad}${paint.bold(shown)}`)
		}
	}
	lines.push('', paint.dim('改完立即生效，无需重启；也可以直接编辑设置文件里的 dsh-do: 段。'))
	return lines
}

/**
 * Detail view for one field: current value, accepted shape, and what it does.
 *
 * @param field - the field to describe.
 * @param resolved - the resolved dsh-DO config.
 * @param color - emit ANSI attributes.
 * @returns the detail lines.
 */
function renderFieldDetail(field: ConfigField, resolved: unknown, color: boolean): string[] {
	const paint = makePainter(color)
	const kind = { boolean: '开关（on/off）', integer: '整数', string: '文本', list: '列表（逗号分隔）' }[field.type]
	const floor = field.min === undefined ? '' : `，最小 ${field.min}`
	return [
		`${paint.bold(field.path)} = ${paint.bold(formatSetting(readPath(resolved, field.path)))}`,
		paint.dim(`  类型  ${kind}${floor}`),
		paint.dim(`  说明  ${field.help}`),
		paint.dim(`  改法  /do-config ${field.path} <值>`),
	]
}

/** Outcome of one command. */
export interface ConfigOutcome {
	readonly ok: boolean
	readonly lines: readonly string[]
}

/**
 * Read dsh-DO's section with every live reference unwrapped.
 *
 * The service hands the section back exactly as its schema resolved it, and a
 * schema marked volatile resolves to a live reference carrying `get()` rather
 * than to a plain object — reading that raw yields an empty shape and every
 * field renders as unset. Unwrapping here is the contract every consumer of the
 * section has to honour, on both generations of the service.
 *
 * @param settings - the access face, already known to be mounted.
 * @returns the section's current value as plain data.
 */
function readSection(settings: SettingsAccess): unknown {
	return plainSettings(settings.get(DSH_DO_NS))
}

/**
 * Run one `/do-config` command against the settings service.
 *
 * @param settings - the settings service, or undefined when none is mounted.
 * @param text - the text after the command name.
 * @param fileHint - where the settings document lives, for `file`.
 * @param options - rendering options (see {@link ListingOptions}).
 */
export async function executeConfigCommand(
	settings: SettingsAccess | undefined,
	text: string,
	fileHint: string,
	options: ListingOptions = {},
): Promise<ConfigOutcome> {
	const paint = makePainter(options.color === true)
	if (settings === undefined) {
		return { ok: false, lines: ['当前组合没有挂载 settings 服务，dsh-do 设置只能来自 cordis.patch.yml 的组合配置。'] }
	}
	const command = splitAssignment(parseConfigCommand(text))
	const resolved = readSection(settings)
	switch (command.kind) {
		case 'list':
			return { ok: true, lines: renderConfigListing(resolved, options) }
		case 'file':
			return {
				ok: true,
				lines: [`设置文件：${fileHint}`, '直接编辑其中的 `dsh-do:` 段即可，保存后自动生效（无需重启）。'],
			}
		case 'show': {
			const field = findField(command.path)
			if (field === undefined) return { ok: false, lines: [unknownPath(command.path)] }
			return { ok: true, lines: renderFieldDetail(field, resolved, options.color === true) }
		}
		case 'reset': {
			const field = findField(command.path)
			if (field === undefined) return { ok: false, lines: [unknownPath(command.path)] }
			await settings.mutate(DSH_DO_NS, [{ op: 'unset', path: field.path.split('.') }])
			const now = formatSetting(readPath(readSection(settings), field.path))
			return { ok: true, lines: [`✓ ${field.path} 已恢复默认：${paint.bold(now)}`] }
		}
		case 'set': {
			const field = findField(command.path)
			if (field === undefined) return { ok: false, lines: [unknownPath(command.path)] }
			const coerced = coerceValue(field, command.raw)
			if (!coerced.ok) return { ok: false, lines: [coerced.error] }
			await settings.mutate(DSH_DO_NS, [{ op: 'set', path: field.path.split('.'), value: coerced.value }])
			const now = formatSetting(readPath(readSection(settings), field.path))
			return { ok: true, lines: [`✓ ${field.path} = ${paint.bold(now)}（已保存，立即生效）`] }
		}
	}
}

function unknownPath(path: string): string {
	return `未知设置「${path}」。可用：${CONFIG_FIELDS.map((field) => field.path).join('，')}`
}

/** Normalize a thrown settings error into one line. */
function renderError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Register `/do-config` in every command registry the composition offers.
 *
 * @param ctx - the plugin context.
 */
export function installConfigCommand(ctx: Context): void {
	const settingsOf = (): SettingsAccess | undefined => adaptSettingsAccess(ctx.get('settings'))
	const fileHint = (): string => {
		const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '~'}/.dsh`
		return `${home.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}settings.yaml`
	}
	const run = async (text: string, color = false): Promise<ConfigOutcome> => {
		try {
			return await executeConfigCommand(settingsOf(), text, fileHint(), { color })
		} catch (error) {
			return { ok: false, lines: [`保存失败：${renderError(error)}`] }
		}
	}

	ctx.inject(['commands'], (child) => {
		child.commands.register({
			name: CONFIG_COMMAND_NAME,
			description: 'view or change dsh-DO settings (auto-continue, model fallback, loop detection, ...)',
			input: { hint: '[<path> [<value>] | reset <path> | file]' },
			handler: async (invocation) => {
				const outcome = await run(invocation.rawInput)
				return { kind: outcome.ok ? 'success' : 'error', text: outcome.lines.join('\n') }
			},
		})
	})

	ctx.inject([TUI_COMMANDS_SERVICE], (tuiCtx) => {
		const registry = tuiCtx.get(TUI_COMMANDS_SERVICE)
		if (!isTuiCommandRegistry(registry)) return
		registry.register({
			name: CONFIG_COMMAND_NAME,
			description: 'dsh-DO 设置：查看/修改自动继续、模型切换、循环检测等',
			argsHint: '[<路径> [<值>] | reset <路径> | file]',
			run: async ({ text, echo }) => {
				const outcome = await run(text, true)
				outcome.lines.forEach((line, index) => echo(index === 0 && !outcome.ok ? `⚠ ${line}` : line))
			},
		})
		tuiCtx.effect(() => () => registry.unregister(CONFIG_COMMAND_NAME))
	})
}
