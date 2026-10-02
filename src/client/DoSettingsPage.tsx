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
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import {
	AGENT_DEFAULT_MODEL_NS,
	buildLoopSectionValue,
	buildRetryResetOps,
	buildRetrySaveOps,
	indexSections,
	isOverridden,
	readActiveModel,
	readLoopDraft,
	readRetryDraft,
	resolveDoNamespace,
	resolveRetryTargets,
	selectRetryTarget,
	validateLoopDraft,
	validateRetryDraft,
	type LoopDraft,
	type RetryDraft,
	type RetryTarget,
	type SettingsSectionView,
} from './doSettings.ts'

/** The bridge route this page reads and writes. */
const SETTINGS_PATH = '/dsh-do/settings'

/** Stable identity of one target across namespaces. */
function targetKey(target: RetryTarget): string {
	return `${target.namespace}::${target.id}`
}

const CARD: CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	gap: '16px',
	padding: '16px',
	border: '1px solid var(--dsw-border, rgba(127,127,127,0.28))',
	borderRadius: '10px',
}

const ROW: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '6px' }
const LABEL: CSSProperties = { fontSize: '12px', opacity: 0.78 }
const HINT: CSSProperties = { fontSize: '12px', opacity: 0.6, lineHeight: 1.5 }
const ERROR: CSSProperties = { fontSize: '13px', color: 'var(--dsw-danger, #d64545)', lineHeight: 1.5 }
const OK: CSSProperties = { fontSize: '13px', color: 'var(--dsw-success, #2f9e6b)', lineHeight: 1.5 }
const TITLE: CSSProperties = { fontSize: '14px', fontWeight: 600 }
const ACTIONS: CSSProperties = { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }
const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px' }

/** A labelled text control. */
function TextField(props: { label: string; value: string; hint?: string; onChange: (next: string) => void }): ReactElement {
	return (
		<label style={ROW}>
			<span style={LABEL}>{props.label}</span>
			<Input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
			{props.hint === undefined ? null : <span style={HINT}>{props.hint}</span>}
		</label>
	)
}

/** A labelled checkbox. */
function CheckField(props: { label: string; checked: boolean; hint?: string; onChange: (next: boolean) => void }): ReactElement {
	return (
		<label style={{ ...ROW, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
			<input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
			<span style={LABEL}>{props.label}</span>
			{props.hint === undefined ? null : <span style={HINT}>{props.hint}</span>}
		</label>
	)
}

/** A labelled select. */
function SelectField<T extends string>(props: {
	label: string
	value: T
	options: ReadonlyArray<{ value: T; label: string }>
	onChange: (next: T) => void
}): ReactElement {
	return (
		<label style={ROW}>
			<span style={LABEL}>{props.label}</span>
			<select value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>
				{props.options.map((option) => (
					<option key={option.value} value={option.value}>{option.label}</option>
				))}
			</select>
		</label>
	)
}

/** The Host's answer to a read or a write. */
interface BridgeResponse {
	readonly ok?: boolean
	readonly error?: string
	readonly sections?: SettingsSectionView[]
}

/** Call the settings bridge and unwrap its answer. */
async function callBridge(init?: RequestInit): Promise<BridgeResponse> {
	const response = await fetch(SETTINGS_PATH, {
		...init,
		headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) },
	})
	let body: BridgeResponse
	try {
		body = (await response.json()) as BridgeResponse
	} catch {
		throw new Error(`HTTP ${response.status}`)
	}
	if (body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`)
	return body
}

/**
 * The settings page body.
 * @param props - the section owner share (the shell supplies `close`).
 */
export function DoSettingsPage(props: SettingsSectionOwnerProps): ReactElement {
	const [sections, setSections] = useState<readonly SettingsSectionView[] | undefined>(undefined)
	const [loadError, setLoadError] = useState<string | undefined>(undefined)
	const [saveError, setSaveError] = useState<string | undefined>(undefined)
	const [saved, setSaved] = useState(false)
	const [busy, setBusy] = useState(false)
	const [chosenKey, setChosenKey] = useState<string | undefined>(undefined)
	const [loop, setLoop] = useState<LoopDraft | undefined>(undefined)
	const [retry, setRetry] = useState<RetryDraft | undefined>(undefined)
	/** The section revisions the drafts were read at, for write fencing. */
	const [revisions, setRevisions] = useState<{ loop?: number; retry?: number }>({})
	/** Namespace dsh-DO's own section was served under, resolved per response. */
	const [doNamespace, setDoNamespace] = useState<string | undefined>(undefined)

	const byNs = useMemo(() => indexSections(sections ?? []), [sections])
	const targets = useMemo(() => resolveRetryTargets(byNs), [byNs])
	// The active provider's policy is the default selection, but an explicit
	// choice wins so switching providers is not undone by a refresh.
	const target = useMemo(() => {
		if (chosenKey !== undefined) {
			const chosen = targets.find((candidate) => targetKey(candidate) === chosenKey)
			if (chosen !== undefined) return chosen
		}
		return selectRetryTarget(targets, readActiveModel(byNs.get(AGENT_DEFAULT_MODEL_NS)?.value))
	}, [targets, chosenKey, byNs])

	/** Adopt a Host response: replace the sections and re-seed both forms. */
	const adopt = useCallback((next: readonly SettingsSectionView[], selected: RetryTarget | undefined) => {
		const map = indexSections(next)
		// The Host files dsh-DO's section under a namespace this build cannot know
		// in advance (the registered one on 0.1.x, the profile entry id on 0.2.x),
		// so it is resolved from the served sections on every response.
		const doNs = resolveDoNamespace(map)
		setSections(next)
		setDoNamespace(doNs)
		setLoop(readLoopDraft(doNs === undefined ? undefined : map.get(doNs)?.value))
		setRevisions({
			loop: doNs === undefined ? undefined : map.get(doNs)?.revision,
			...(selected === undefined ? {} : { retry: map.get(selected.namespace)?.revision }),
		})
		setRetry(selected === undefined ? undefined : readRetryDraft(map.get(selected.namespace)?.value, selected.path))
	}, [])

	const load = useCallback(async () => {
		setLoadError(undefined)
		try {
			const body = await callBridge()
			const next = body.sections ?? []
			const map = indexSections(next)
			adopt(next, selectRetryTarget(resolveRetryTargets(map), readActiveModel(map.get(AGENT_DEFAULT_MODEL_NS)?.value)))
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : String(error))
		}
	}, [adopt])

	useEffect(() => {
		void load()
	}, [load])

	// Re-seed the retry form whenever the selection changes, so the controls
	// always show the policy of the provider named above them.
	useEffect(() => {
		if (target === undefined) {
			setRetry(undefined)
			return
		}
		setRetry(readRetryDraft(byNs.get(target.namespace)?.value, target.path))
		setRevisions((current) => ({ ...current, retry: byNs.get(target.namespace)?.revision }))
	}, [target, byNs])

	const problem = (loop === undefined ? undefined : validateLoopDraft(loop)) ?? (retry === undefined ? undefined : validateRetryDraft(retry))

	/** Apply one namespace's operations, then adopt whatever the Host accepted. */
	const write = useCallback(
		async (ns: string, ops: readonly unknown[], expectedRevision: number | undefined): Promise<void> => {
			const body = await callBridge({
				method: 'POST',
				body: JSON.stringify({ ns, ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
			})
			if (body.sections !== undefined) adopt(body.sections, target)
		},
		[adopt, target],
	)

	const save = useCallback(async () => {
		if (loop === undefined || problem !== undefined || doNamespace === undefined) return
		setBusy(true)
		setSaveError(undefined)
		setSaved(false)
		try {
			await write(doNamespace, [{ op: 'set', path: [], value: buildLoopSectionValue(loop) }], revisions.loop)
			if (retry !== undefined && target !== undefined) await write(target.namespace, buildRetrySaveOps(target, retry), revisions.retry)
			setSaved(true)
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}, [loop, retry, target, problem, revisions, write, doNamespace])

	const resetRetry = useCallback(async () => {
		if (target === undefined) return
		setBusy(true)
		setSaveError(undefined)
		setSaved(false)
		try {
			await write(target.namespace, buildRetryResetOps(target), revisions.retry)
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}, [target, revisions, write])

	if (loadError !== undefined) {
		return (
			<div style={CARD}>
				<span style={TITLE}>dsh-DO</span>
				<span style={ERROR}>读取设置失败：{loadError}</span>
				<div style={ACTIONS}>
					<Button onClick={() => void load()}>重试</Button>
				</div>
			</div>
		)
	}
	if (loop === undefined) {
		return (
			<div style={CARD}>
				<span style={HINT}>正在读取设置…</span>
			</div>
		)
	}

	const retryOverridden = target !== undefined && isOverridden(byNs.get(target.namespace)?.user, target.path)

	return (
		<div style={STACK}>
			<div style={CARD}>
				<span style={TITLE}>循环（dsh-DO）</span>
				<TextField
					label="默认最大轮次"
					value={loop.defaultMaxRounds}
					hint="模型未指定 max_rounds 时，一次循环最多自动续跑多少轮。"
					onChange={(next) => setLoop({ ...loop, defaultMaxRounds: next })}
				/>
				<TextField
					label="检查点目录"
					value={loop.checkpointDir}
					hint="留空则使用 $DSH_HOME/loops。改动只影响之后写入的检查点，不会迁移或复活已有循环。"
					onChange={(next) => setLoop({ ...loop, checkpointDir: next })}
				/>
				<CheckField
					label="持久化循环状态"
					checked={loop.persist}
					hint="关闭后循环只存在于内存，进程重启不会恢复。"
					onChange={(next) => setLoop({ ...loop, persist: next })}
				/>
			</div>

			<div style={CARD}>
				<span style={TITLE}>模型循环检测</span>
				<span style={HINT}>
					检测到模型连续重复同一个工具调用时，自动中断该轮、压缩历史并重发请求。若该会话正由循环或目标驱动接管，则只投递纠正提示而不中断，以免停掉你正在跑的循环。
				</span>
				<CheckField label="启用检测" checked={loop.detectionEnabled} onChange={(next) => setLoop({ ...loop, detectionEnabled: next })} />
				<TextField
					label="重复阈值（连续相同调用次数）"
					value={loop.repeatThreshold}
					hint="不小于 2。"
					onChange={(next) => setLoop({ ...loop, repeatThreshold: next })}
				/>
				<CheckField
					label="恢复前压缩历史"
					checked={loop.detectionCompact}
					hint="关闭后只中断并重发，不做压缩。"
					onChange={(next) => setLoop({ ...loop, detectionCompact: next })}
				/>
				<TextField
					label="单轮最大干预次数"
					value={loop.maxInterventions}
					hint="达到上限后只投递纠正提示，避免恢复流程自己变成循环。"
					onChange={(next) => setLoop({ ...loop, maxInterventions: next })}
				/>
			</div>

			<div style={CARD}>
				<span style={TITLE}>输出上限自动继续</span>
				<span style={HINT}>模型回答被输出 token 上限截断（max-tokens）时，自动发一轮「从断点接着写」，不再停下等你。</span>
				<CheckField label="启用自动继续" checked={loop.continueEnabled} onChange={(next) => setLoop({ ...loop, continueEnabled: next })} />
				<TextField
					label="最大连续继续次数"
					value={loop.maxContinuations}
					hint="同一段回答连续被截断超过这个次数就停下并提示，防止无限续写。"
					onChange={(next) => setLoop({ ...loop, maxContinuations: next })}
				/>
				<CheckField
					label="只在循环运行中自动继续"
					checked={loop.continueOnlyWhileLooping}
					hint="关闭后普通对话被截断也会自动继续。"
					onChange={(next) => setLoop({ ...loop, continueOnlyWhileLooping: next })}
				/>
			</div>

			<div style={CARD}>
				<span style={TITLE}>模型自动切换</span>
				<span style={HINT}>
					当前模型报 429 等错误、且该提供方的重试策略已经放弃后，按顺序换下一个候选模型重发同一请求。下一条你亲自发的消息会先回到你选的模型。所有候选都失败时按原样报错。
				</span>
				<CheckField label="启用自动切换" checked={loop.fallbackEnabled} onChange={(next) => setLoop({ ...loop, fallbackEnabled: next })} />
				<label style={ROW}>
					<span style={LABEL}>候选模型（按顺序，每行一个 provider/model）</span>
					<textarea
						value={loop.fallbackCandidates}
						rows={4}
						style={{ font: 'inherit', padding: '6px 8px', borderRadius: '6px' }}
						onChange={(event) => setLoop({ ...loop, fallbackCandidates: event.target.value })}
					/>
				</label>
				<TextField
					label="触发切换的错误码"
					value={loop.fallbackCodes}
					hint="逗号分隔。默认 RATE_LIMIT, QUOTA, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE。"
					onChange={(next) => setLoop({ ...loop, fallbackCodes: next })}
				/>
			</div>

			<div style={CARD}>
				<span style={TITLE}>断连重试策略</span>
				{target === undefined || retry === undefined ? (
					<span style={HINT}>当前部署没有暴露可编辑的重试策略命名空间。</span>
				) : (
					<>
						<SelectField
							label="提供方"
							value={targetKey(target)}
							options={targets.map((candidate) => ({ value: targetKey(candidate), label: candidate.label }))}
							onChange={(next) => setChosenKey(next)}
						/>
						<SelectField
							label="模式"
							value={retry.mode}
							options={[
								{ value: 'normal', label: 'normal（只重试可重试错误码）' },
								{ value: 'always', label: 'always（任何失败都重试）' },
							]}
							onChange={(next) => setRetry({ ...retry, mode: next })}
						/>
						{retry.mode === 'normal' ? (
							<TextField
								label="最大重试次数"
								value={String(retry.maxRetries)}
								hint="DSH 内置默认 5。"
								onChange={(next) => setRetry({ ...retry, maxRetries: Number(next) })}
							/>
						) : null}
						<TextField
							label="初始退避时长（毫秒）"
							value={String(retry.initialDelayMs)}
							hint="DSH 内置默认 500。"
							onChange={(next) => setRetry({ ...retry, initialDelayMs: Number(next) })}
						/>
						<TextField
							label="最大退避时长（毫秒）"
							value={String(retry.maxDelayMs)}
							hint="DSH 内置默认 10000。"
							onChange={(next) => setRetry({ ...retry, maxDelayMs: Number(next) })}
						/>
						<TextField
							label="抖动比例（0-1）"
							value={String(retry.jitterRatio)}
							hint="DSH 内置默认 0.1。"
							onChange={(next) => setRetry({ ...retry, jitterRatio: Number(next) })}
						/>
						<span style={HINT}>
							可重试错误码沿用适配器内置列表（RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE），不在此处覆写。
							{retryOverridden ? ' 该提供方已有用户覆写。' : ' 当前继承组合默认值。'}
						</span>
						<div style={ACTIONS}>
							<Button variant="outline" disabled={busy || !retryOverridden} onClick={() => void resetRetry()}>
								重置为组合默认
							</Button>
						</div>
					</>
				)}
			</div>

			{problem === undefined ? null : <span style={ERROR}>{problem}</span>}
			{saveError === undefined ? null : <span style={ERROR}>保存失败：{saveError}</span>}
			{saved && saveError === undefined ? <span style={OK}>已保存。</span> : null}
			<div style={ACTIONS}>
				<Button disabled={busy || problem !== undefined} onClick={() => void save()}>
					{busy ? '保存中…' : '保存'}
				</Button>
				<Button variant="outline" disabled={busy} onClick={() => void load()}>
					放弃修改并重新读取
				</Button>
				<Button variant="outline" onClick={props.close}>
					关闭
				</Button>
			</div>
		</div>
	)
}
