window.__ModuleLoader__.load({
	id: "dsh-do",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/addWorkspace.ts
		let state = {
			open: false,
			x: 0,
			y: 0
		};
		const listeners = /* @__PURE__ */ new Set();
		/** The workspaces service face captured at plugin apply time (root-scoped UI has no other handle). */
		let workspacesService;
		function setWorkspacesService(service) {
			workspacesService = service;
			return () => {
				if (workspacesService !== service) return;
				workspacesService = void 0;
				closeAddWorkspaceDialog();
			};
		}
		function getWorkspacesService() {
			return workspacesService;
		}
		/** Read the current dialog state (useSyncExternalStore snapshot). */
		function getAddWorkspaceDialogState() {
			return state;
		}
		/** Subscribe to dialog state changes; returns the disposer. */
		function subscribeAddWorkspaceDialog(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** Open the dialog at the given viewport coordinates (from a right-click). */
		function openAddWorkspaceDialog(x, y) {
			state = {
				open: true,
				x,
				y
			};
			for (const listener of listeners) listener();
		}
		/** Apply an asynchronous result only to the exact dialog opening that requested it. */
		function isCurrentWorkspaceDialog(snapshot) {
			return state === snapshot && state.open;
		}
		/** Close the dialog. */
		function closeAddWorkspaceDialog() {
			state = {
				open: false,
				x: 0,
				y: 0
			};
			for (const listener of listeners) listener();
		}
		//#endregion
		//#region src/client/doSettings.ts
		/**
		* Pure logic for the dsh-DO settings page: what the page reads from the
		* resolved settings sections, how a staged retry policy is validated, and which
		* write operations a save produces.
		*
		* Kept free of React and Cordis so the decisions the page makes are testable
		* under `node --test`, mirroring the `github.ts` / `GitHubSearchButton.tsx`
		* split this plugin already uses.
		*
		* @module dsh-do/client/do-settings
		*/
		/** DeepSeek Harness's built-in retry defaults, mirrored from `dsh-llm`. */
		const RETRY_DEFAULTS = {
			mode: "normal",
			maxRetries: 5,
			initialDelayMs: 500,
			maxDelayMs: 1e4,
			jitterRatio: .1
		};
		/** Largest delay a Node timer accepts without clamping. */
		const MAX_TIMER_DELAY_MS = 2147483647;
		/** The retry-policy settings namespace of the first-party DeepSeek adapter. */
		const DEEPSEEK_NS = "llm-deepseek";
		/** The retry-policy settings namespace of the multi-provider pi-ai adapter. */
		const PI_AI_NS = "llm-pi-ai";
		/** The namespace recording which provider/model new agents use. */
		const AGENT_DEFAULT_MODEL_NS = "agent-default-model";
		/**
		* The namespace dsh-DO's own configuration is filed under on DSH 0.1.x, where a
		* plugin registers a namespace. 0.2.x keys sections by profile entry id instead;
		* use {@link resolveDoNamespace} rather than this constant to locate the section.
		*/
		const DSH_DO_NS = "dsh-do";
		/** Read a plain-object property without trusting its shape. */
		function field(value, key) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
			return value[key];
		}
		/** Read a finite number, or undefined when absent or of another type. */
		function numberOf(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : void 0;
		}
		/**
		* Read one provider's retry policy out of a resolved settings section.
		*
		* Absent fields fall back to the Host's built-in defaults, so the page shows
		* what the adapter would actually use rather than an empty form.
		*
		* @param section - the resolved section, or undefined before the first read.
		* @param path - path from the section root to the `retryPolicy` object.
		* @returns the effective policy.
		*/
		function readRetryDraft(section, path) {
			let node = section;
			for (const segment of path) node = field(node, segment);
			const mode = field(node, "mode");
			const backoff = field(node, "backoff");
			return {
				mode: mode === "always" ? "always" : "normal",
				maxRetries: numberOf(field(node, "maxRetries")) ?? RETRY_DEFAULTS.maxRetries,
				initialDelayMs: numberOf(field(backoff, "initialDelayMs")) ?? RETRY_DEFAULTS.initialDelayMs,
				maxDelayMs: numberOf(field(backoff, "maxDelayMs")) ?? RETRY_DEFAULTS.maxDelayMs,
				jitterRatio: numberOf(field(backoff, "jitterRatio")) ?? RETRY_DEFAULTS.jitterRatio
			};
		}
		/** Whether the user layer carries an override at this path. */
		function isOverridden(userSection, path) {
			let node = userSection;
			for (const segment of path) {
				if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
				const record = node;
				if (!Object.hasOwn(record, segment)) return false;
				node = record[segment];
			}
			return node !== void 0;
		}
		/**
		* Validate a staged retry policy against the Host's own constraints.
		*
		* The Host re-validates everything; this exists so the page can refuse a draft
		* it knows is unacceptable instead of sending a write that will be rejected.
		*
		* @param draft - the staged values.
		* @returns the first problem, or undefined when the draft is acceptable.
		*/
		function validateRetryDraft(draft) {
			const integer = (value, label, min, max) => {
				if (!Number.isSafeInteger(value)) return `${label} 必须是整数。`;
				if (value < min) return `${label} 不能小于 ${min}。`;
				if (value > max) return `${label} 不能大于 ${max}。`;
			};
			if (draft.mode === "normal") {
				const problem = integer(draft.maxRetries, "最大重试次数", 0, 1e3);
				if (problem !== void 0) return problem;
			}
			const initial = integer(draft.initialDelayMs, "初始退避时长（毫秒）", 0, MAX_TIMER_DELAY_MS);
			if (initial !== void 0) return initial;
			const max = integer(draft.maxDelayMs, "最大退避时长（毫秒）", 0, MAX_TIMER_DELAY_MS);
			if (max !== void 0) return max;
			if (draft.initialDelayMs > draft.maxDelayMs) return "初始退避时长不能大于最大退避时长。";
			if (!Number.isFinite(draft.jitterRatio)) return "抖动比例必须是数字。";
			if (draft.jitterRatio < 0 || draft.jitterRatio > 1) return "抖动比例必须在 0 到 1 之间。";
		}
		/**
		* Build the complete `retryPolicy` object one save writes.
		*
		* The Host's schema requires `mode` and validates the object as a whole, so a
		* partial write that omitted it would be refused. `retryableCodes` is
		* deliberately omitted: leaving it absent keeps the adapter's built-in code
		* list, which is what a user editing delays expects.
		*
		* @param draft - the validated staged values.
		* @returns the JSON value to store at the target path.
		*/
		function buildRetryPolicy(draft) {
			const backoff = {
				initialDelayMs: draft.initialDelayMs,
				maxDelayMs: draft.maxDelayMs,
				jitterRatio: draft.jitterRatio
			};
			return draft.mode === "always" ? {
				mode: "always",
				backoff
			} : {
				mode: "normal",
				maxRetries: draft.maxRetries,
				backoff
			};
		}
		/** The operations one save of `draft` writes at `target`. */
		function buildRetrySaveOps(target, draft) {
			return [{
				op: "set",
				path: target.path,
				value: buildRetryPolicy(draft)
			}];
		}
		/** The operations one reset of `target` writes, re-inheriting the composition layer. */
		function buildRetryResetOps(target) {
			return [{
				op: "unset",
				path: target.path
			}];
		}
		/** Index the served sections by namespace. */
		function indexSections(sections) {
			const map = /* @__PURE__ */ new Map();
			for (const section of sections) map.set(section.ns, section);
			return map;
		}
		/**
		* Find the namespace dsh-DO's own loop configuration was served under.
		*
		* DSH 0.1.x files it under the registered namespace `dsh-do`; 0.2.x keys every
		* section by its profile entry id instead, and that id belongs to the deployment
		* rather than to this plugin. The section is therefore recognised by the fields
		* it carries, so a renamed entry still resolves.
		*
		* @param sections - served sections indexed by namespace.
		* @returns the namespace to read and write, or undefined when it was not served.
		*/
		function resolveDoNamespace(sections) {
			if (sections.has("dsh-do")) return DSH_DO_NS;
			for (const [ns, section] of sections) {
				const value = section.value;
				if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
				const record = value;
				if ("defaultMaxRounds" in record && "loopDetection" in record && "autoContinue" in record) return ns;
			}
		}
		/**
		* Discover every retry policy the deployment actually exposes.
		*
		* A namespace only yields a target when the Host serves it, so a deployment
		* composing one adapter shows one policy rather than an inert form for the
		* other.
		*
		* @param sections - served sections indexed by namespace.
		* @returns the targets, in a stable order.
		*/
		function resolveRetryTargets(sections) {
			const targets = [];
			if (sections.get("llm-deepseek") !== void 0) targets.push({
				id: "deepseek-official",
				namespace: DEEPSEEK_NS,
				label: "DeepSeek 官方（llm-deepseek）",
				path: ["retryPolicy"]
			});
			const providers = field(sections.get(PI_AI_NS)?.value, "providers");
			if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) for (const id of Object.keys(providers).sort()) targets.push({
				id,
				namespace: PI_AI_NS,
				label: `${id}（llm-pi-ai）`,
				path: [
					"providers",
					id,
					"retryPolicy"
				]
			});
			return targets;
		}
		/** Read the deployment's selected provider/model. */
		function readActiveModel(section) {
			const provider = field(section, "provider");
			const model = field(section, "model");
			return {
				...typeof provider === "string" && provider !== "" ? { provider } : {},
				...typeof model === "string" && model !== "" ? { model } : {}
			};
		}
		/**
		* Choose the target the page opens on: the active provider's policy when the
		* deployment exposes one, otherwise the first served policy.
		*
		* @param targets - every served target.
		* @param active - the deployment's active model.
		* @returns the selected target, or undefined when none is served.
		*/
		function selectRetryTarget(targets, active) {
			if (targets.length === 0) return void 0;
			const provider = active.provider;
			if (provider !== void 0) {
				const match = targets.find((target) => target.id === provider || target.namespace === "llm-deepseek" && provider.startsWith("deepseek"));
				if (match !== void 0) return match;
			}
			return targets[0];
		}
		/** Default failure codes that trigger a model switch (mirrors the host schema). */
		const DEFAULT_FALLBACK_CODES = [
			"RATE_LIMIT",
			"QUOTA",
			"SERVER",
			"TIMEOUT",
			"TRANSPORT",
			"EMPTY_RESPONSE"
		];
		function stringList(value) {
			return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : void 0;
		}
		/** Split a loose list: newlines, commas, semicolons (ASCII or full-width). */
		function splitList(text) {
			return text.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
		}
		/** Read the loop-configuration form out of the resolved `dsh-do` section. */
		function readLoopDraft(section) {
			const detection = field(section, "loopDetection");
			return {
				defaultMaxRounds: String(numberOf(field(section, "defaultMaxRounds")) ?? 20),
				checkpointDir: typeof field(section, "checkpointDir") === "string" ? field(section, "checkpointDir") : "",
				persist: field(section, "persist") !== false,
				detectionEnabled: field(detection, "enabled") !== false,
				repeatThreshold: String(numberOf(field(detection, "repeatThreshold")) ?? 4),
				detectionCompact: field(detection, "compact") !== false,
				maxInterventions: String(numberOf(field(detection, "maxInterventions")) ?? 2),
				continueEnabled: field(field(section, "autoContinue"), "enabled") !== false,
				maxContinuations: String(numberOf(field(field(section, "autoContinue"), "maxContinuations")) ?? 3),
				continueOnlyWhileLooping: field(field(section, "autoContinue"), "onlyWhileLooping") !== false,
				fallbackEnabled: field(field(section, "modelFallback"), "enabled") === true,
				fallbackCandidates: (stringList(field(field(section, "modelFallback"), "candidates")) ?? []).join("\n"),
				fallbackCodes: (stringList(field(field(section, "modelFallback"), "triggerCodes")) ?? DEFAULT_FALLBACK_CODES).join(", ")
			};
		}
		/**
		* Validate a staged loop-configuration draft.
		* @param draft - the staged values.
		* @returns the first problem, or undefined when the draft is acceptable.
		*/
		function validateLoopDraft(draft) {
			const rounds = Number(draft.defaultMaxRounds);
			if (!Number.isSafeInteger(rounds) || rounds < 1) return "默认最大轮次必须是大于 0 的整数。";
			const threshold = Number(draft.repeatThreshold);
			if (!Number.isSafeInteger(threshold) || threshold < 2) return "循环检测阈值必须是不小于 2 的整数。";
			const interventions = Number(draft.maxInterventions);
			if (!Number.isSafeInteger(interventions) || interventions < 1) return "最大干预次数必须是大于 0 的整数。";
			const continuations = Number(draft.maxContinuations);
			if (!Number.isSafeInteger(continuations) || continuations < 1) return "最大连续自动继续次数必须是大于 0 的整数。";
			for (const candidate of splitList(draft.fallbackCandidates)) {
				const slash = candidate.indexOf("/");
				if (slash <= 0 || slash === candidate.length - 1) return `候选模型「${candidate}」格式不对，应写作 provider/model。`;
			}
			if (draft.fallbackEnabled && splitList(draft.fallbackCandidates).length === 0) return "开启模型自动切换时至少要填一个候选模型。";
		}
		/** The single top-level value one loop-configuration save writes. */
		function buildLoopSectionValue(draft) {
			return {
				defaultMaxRounds: Number(draft.defaultMaxRounds),
				checkpointDir: draft.checkpointDir.trim(),
				persist: draft.persist,
				loopDetection: {
					enabled: draft.detectionEnabled,
					repeatThreshold: Number(draft.repeatThreshold),
					compact: draft.detectionCompact,
					maxInterventions: Number(draft.maxInterventions)
				},
				autoContinue: {
					enabled: draft.continueEnabled,
					maxContinuations: Number(draft.maxContinuations),
					onlyWhileLooping: draft.continueOnlyWhileLooping
				},
				modelFallback: {
					enabled: draft.fallbackEnabled,
					candidates: splitList(draft.fallbackCandidates),
					triggerCodes: splitList(draft.fallbackCodes).map((code) => code.toUpperCase())
				}
			};
		}
		//#endregion
		//#region src/client/DoSettingsPage.tsx
		/** The bridge route this page reads and writes. */
		const SETTINGS_PATH = "/dsh-do/settings";
		/** Stable identity of one target across namespaces. */
		function targetKey(target) {
			return `${target.namespace}::${target.id}`;
		}
		const CARD = {
			display: "flex",
			flexDirection: "column",
			gap: "16px",
			padding: "16px",
			border: "1px solid var(--dsw-border, rgba(127,127,127,0.28))",
			borderRadius: "10px"
		};
		const ROW = {
			display: "flex",
			flexDirection: "column",
			gap: "6px"
		};
		const LABEL = {
			fontSize: "12px",
			opacity: .78
		};
		const HINT = {
			fontSize: "12px",
			opacity: .6,
			lineHeight: 1.5
		};
		const ERROR = {
			fontSize: "13px",
			color: "var(--dsw-danger, #d64545)",
			lineHeight: 1.5
		};
		const OK = {
			fontSize: "13px",
			color: "var(--dsw-success, #2f9e6b)",
			lineHeight: 1.5
		};
		const TITLE = {
			fontSize: "14px",
			fontWeight: 600
		};
		const ACTIONS = {
			display: "flex",
			gap: "8px",
			alignItems: "center",
			flexWrap: "wrap"
		};
		const STACK = {
			display: "flex",
			flexDirection: "column",
			gap: "16px"
		};
		/** A labelled text control. */
		function TextField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: ROW,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: LABEL,
						children: props.label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						value: props.value,
						onChange: (event) => props.onChange(event.target.value)
					}),
					props.hint === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: HINT,
						children: props.hint
					})
				]
			});
		}
		/** A labelled checkbox. */
		function CheckField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: {
					...ROW,
					flexDirection: "row",
					alignItems: "center",
					gap: "8px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: props.checked,
						onChange: (event) => props.onChange(event.target.checked)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: LABEL,
						children: props.label
					}),
					props.hint === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: HINT,
						children: props.hint
					})
				]
			});
		}
		/** A labelled select. */
		function SelectField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: ROW,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: LABEL,
					children: props.label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
					value: props.value,
					onChange: (event) => props.onChange(event.target.value),
					children: props.options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: option.value,
						children: option.label
					}, option.value))
				})]
			});
		}
		/** Call the settings bridge and unwrap its answer. */
		async function callBridge(init) {
			const response = await fetch(SETTINGS_PATH, {
				...init,
				headers: {
					accept: "application/json",
					...init?.body === void 0 ? {} : { "content-type": "application/json" }
				}
			});
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			if (body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
			return body;
		}
		/**
		* The settings page body.
		* @param props - the section owner share (the shell supplies `close`).
		*/
		function DoSettingsPage(props) {
			const [sections, setSections] = (0, react.useState)(void 0);
			const [loadError, setLoadError] = (0, react.useState)(void 0);
			const [saveError, setSaveError] = (0, react.useState)(void 0);
			const [saved, setSaved] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [chosenKey, setChosenKey] = (0, react.useState)(void 0);
			const [loop, setLoop] = (0, react.useState)(void 0);
			const [retry, setRetry] = (0, react.useState)(void 0);
			/** The section revisions the drafts were read at, for write fencing. */
			const [revisions, setRevisions] = (0, react.useState)({});
			/** Namespace dsh-DO's own section was served under, resolved per response. */
			const [doNamespace, setDoNamespace] = (0, react.useState)(void 0);
			const byNs = (0, react.useMemo)(() => indexSections(sections ?? []), [sections]);
			const targets = (0, react.useMemo)(() => resolveRetryTargets(byNs), [byNs]);
			const target = (0, react.useMemo)(() => {
				if (chosenKey !== void 0) {
					const chosen = targets.find((candidate) => targetKey(candidate) === chosenKey);
					if (chosen !== void 0) return chosen;
				}
				return selectRetryTarget(targets, readActiveModel(byNs.get(AGENT_DEFAULT_MODEL_NS)?.value));
			}, [
				targets,
				chosenKey,
				byNs
			]);
			/** Adopt a Host response: replace the sections and re-seed both forms. */
			const adopt = (0, react.useCallback)((next, selected) => {
				const map = indexSections(next);
				const doNs = resolveDoNamespace(map);
				setSections(next);
				setDoNamespace(doNs);
				setLoop(readLoopDraft(doNs === void 0 ? void 0 : map.get(doNs)?.value));
				setRevisions({
					loop: doNs === void 0 ? void 0 : map.get(doNs)?.revision,
					...selected === void 0 ? {} : { retry: map.get(selected.namespace)?.revision }
				});
				setRetry(selected === void 0 ? void 0 : readRetryDraft(map.get(selected.namespace)?.value, selected.path));
			}, []);
			const load = (0, react.useCallback)(async () => {
				setLoadError(void 0);
				try {
					const next = (await callBridge()).sections ?? [];
					const map = indexSections(next);
					adopt(next, selectRetryTarget(resolveRetryTargets(map), readActiveModel(map.get(AGENT_DEFAULT_MODEL_NS)?.value)));
				} catch (error) {
					setLoadError(error instanceof Error ? error.message : String(error));
				}
			}, [adopt]);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			(0, react.useEffect)(() => {
				if (target === void 0) {
					setRetry(void 0);
					return;
				}
				setRetry(readRetryDraft(byNs.get(target.namespace)?.value, target.path));
				setRevisions((current) => ({
					...current,
					retry: byNs.get(target.namespace)?.revision
				}));
			}, [target, byNs]);
			const problem = (loop === void 0 ? void 0 : validateLoopDraft(loop)) ?? (retry === void 0 ? void 0 : validateRetryDraft(retry));
			/** Apply one namespace's operations, then adopt whatever the Host accepted. */
			const write = (0, react.useCallback)(async (ns, ops, expectedRevision) => {
				const body = await callBridge({
					method: "POST",
					body: JSON.stringify({
						ns,
						ops,
						...expectedRevision === void 0 ? {} : { expectedRevision }
					})
				});
				if (body.sections !== void 0) adopt(body.sections, target);
			}, [adopt, target]);
			const save = (0, react.useCallback)(async () => {
				if (loop === void 0 || problem !== void 0 || doNamespace === void 0) return;
				setBusy(true);
				setSaveError(void 0);
				setSaved(false);
				try {
					await write(doNamespace, [{
						op: "set",
						path: [],
						value: buildLoopSectionValue(loop)
					}], revisions.loop);
					if (retry !== void 0 && target !== void 0) await write(target.namespace, buildRetrySaveOps(target, retry), revisions.retry);
					setSaved(true);
				} catch (error) {
					setSaveError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}, [
				loop,
				retry,
				target,
				problem,
				revisions,
				write,
				doNamespace
			]);
			const resetRetry = (0, react.useCallback)(async () => {
				if (target === void 0) return;
				setBusy(true);
				setSaveError(void 0);
				setSaved(false);
				try {
					await write(target.namespace, buildRetryResetOps(target), revisions.retry);
				} catch (error) {
					setSaveError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}, [
				target,
				revisions,
				write
			]);
			if (loadError !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: CARD,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: TITLE,
						children: "dsh-DO"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: ERROR,
						children: ["读取设置失败：", loadError]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: ACTIONS,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => void load(),
							children: "重试"
						})
					})
				]
			});
			if (loop === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: CARD,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: HINT,
					children: "正在读取设置…"
				})
			});
			const retryOverridden = target !== void 0 && isOverridden(byNs.get(target.namespace)?.user, target.path);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: STACK,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: CARD,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: TITLE,
								children: "循环（dsh-DO）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "默认最大轮次",
								value: loop.defaultMaxRounds,
								hint: "模型未指定 max_rounds 时，一次循环最多自动续跑多少轮。",
								onChange: (next) => setLoop({
									...loop,
									defaultMaxRounds: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "检查点目录",
								value: loop.checkpointDir,
								hint: "留空则使用 $DSH_HOME/loops。改动只影响之后写入的检查点，不会迁移或复活已有循环。",
								onChange: (next) => setLoop({
									...loop,
									checkpointDir: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckField, {
								label: "持久化循环状态",
								checked: loop.persist,
								hint: "关闭后循环只存在于内存，进程重启不会恢复。",
								onChange: (next) => setLoop({
									...loop,
									persist: next
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: CARD,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: TITLE,
								children: "模型循环检测"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: HINT,
								children: "检测到模型连续重复同一个工具调用时，自动中断该轮、压缩历史并重发请求。若该会话正由循环或目标驱动接管，则只投递纠正提示而不中断，以免停掉你正在跑的循环。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckField, {
								label: "启用检测",
								checked: loop.detectionEnabled,
								onChange: (next) => setLoop({
									...loop,
									detectionEnabled: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "重复阈值（连续相同调用次数）",
								value: loop.repeatThreshold,
								hint: "不小于 2。",
								onChange: (next) => setLoop({
									...loop,
									repeatThreshold: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckField, {
								label: "恢复前压缩历史",
								checked: loop.detectionCompact,
								hint: "关闭后只中断并重发，不做压缩。",
								onChange: (next) => setLoop({
									...loop,
									detectionCompact: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "单轮最大干预次数",
								value: loop.maxInterventions,
								hint: "达到上限后只投递纠正提示，避免恢复流程自己变成循环。",
								onChange: (next) => setLoop({
									...loop,
									maxInterventions: next
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: CARD,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: TITLE,
								children: "输出上限自动继续"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: HINT,
								children: "模型回答被输出 token 上限截断（max-tokens）时，自动发一轮「从断点接着写」，不再停下等你。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckField, {
								label: "启用自动继续",
								checked: loop.continueEnabled,
								onChange: (next) => setLoop({
									...loop,
									continueEnabled: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "最大连续继续次数",
								value: loop.maxContinuations,
								hint: "同一段回答连续被截断超过这个次数就停下并提示，防止无限续写。",
								onChange: (next) => setLoop({
									...loop,
									maxContinuations: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckField, {
								label: "只在循环运行中自动继续",
								checked: loop.continueOnlyWhileLooping,
								hint: "关闭后普通对话被截断也会自动继续。",
								onChange: (next) => setLoop({
									...loop,
									continueOnlyWhileLooping: next
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: CARD,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: TITLE,
								children: "模型自动切换"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: HINT,
								children: "当前模型报 429 等错误、且该提供方的重试策略已经放弃后，按顺序换下一个候选模型重发同一请求。下一条你亲自发的消息会先回到你选的模型。所有候选都失败时按原样报错。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckField, {
								label: "启用自动切换",
								checked: loop.fallbackEnabled,
								onChange: (next) => setLoop({
									...loop,
									fallbackEnabled: next
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: ROW,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: LABEL,
									children: "候选模型（按顺序，每行一个 provider/model）"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									value: loop.fallbackCandidates,
									rows: 4,
									style: {
										font: "inherit",
										padding: "6px 8px",
										borderRadius: "6px"
									},
									onChange: (event) => setLoop({
										...loop,
										fallbackCandidates: event.target.value
									})
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "触发切换的错误码",
								value: loop.fallbackCodes,
								hint: "逗号分隔。默认 RATE_LIMIT, QUOTA, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE。",
								onChange: (next) => setLoop({
									...loop,
									fallbackCodes: next
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: CARD,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: TITLE,
							children: "断连重试策略"
						}), target === void 0 || retry === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: HINT,
							children: "当前部署没有暴露可编辑的重试策略命名空间。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectField, {
								label: "提供方",
								value: targetKey(target),
								options: targets.map((candidate) => ({
									value: targetKey(candidate),
									label: candidate.label
								})),
								onChange: (next) => setChosenKey(next)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectField, {
								label: "模式",
								value: retry.mode,
								options: [{
									value: "normal",
									label: "normal（只重试可重试错误码）"
								}, {
									value: "always",
									label: "always（任何失败都重试）"
								}],
								onChange: (next) => setRetry({
									...retry,
									mode: next
								})
							}),
							retry.mode === "normal" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "最大重试次数",
								value: String(retry.maxRetries),
								hint: "DSH 内置默认 5。",
								onChange: (next) => setRetry({
									...retry,
									maxRetries: Number(next)
								})
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "初始退避时长（毫秒）",
								value: String(retry.initialDelayMs),
								hint: "DSH 内置默认 500。",
								onChange: (next) => setRetry({
									...retry,
									initialDelayMs: Number(next)
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "最大退避时长（毫秒）",
								value: String(retry.maxDelayMs),
								hint: "DSH 内置默认 10000。",
								onChange: (next) => setRetry({
									...retry,
									maxDelayMs: Number(next)
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: "抖动比例（0-1）",
								value: String(retry.jitterRatio),
								hint: "DSH 内置默认 0.1。",
								onChange: (next) => setRetry({
									...retry,
									jitterRatio: Number(next)
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: HINT,
								children: ["可重试错误码沿用适配器内置列表（RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE），不在此处覆写。", retryOverridden ? " 该提供方已有用户覆写。" : " 当前继承组合默认值。"]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: ACTIONS,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									disabled: busy || !retryOverridden,
									onClick: () => void resetRetry(),
									children: "重置为组合默认"
								})
							})
						] })]
					}),
					problem === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: ERROR,
						children: problem
					}),
					saveError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: ERROR,
						children: ["保存失败：", saveError]
					}),
					saved && saveError === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: OK,
						children: "已保存。"
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: ACTIONS,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								disabled: busy || problem !== void 0,
								onClick: () => void save(),
								children: busy ? "保存中…" : "保存"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								disabled: busy,
								onClick: () => void load(),
								children: "放弃修改并重新读取"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								onClick: props.close,
								children: "关闭"
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:F:\开发\开源\GitHub\dsh loop\src\client\AddWorkspaceDialog.module.css.mjs
		const css$1 = ".XgsC0q_backdrop{z-index:1000;background:0 0;position:fixed;inset:0}.XgsC0q_card{box-sizing:border-box;color:#1f2328;background:#fff;border:1px solid #c9ced3;border-radius:12px;flex-direction:column;gap:8px;width:340px;max-width:calc(100vw - 16px);padding:12px;font-size:13px;line-height:18px;display:flex;position:fixed;box-shadow:0 8px 32px #0000002e}.XgsC0q_cardMobile{left:8px;right:8px;bottom:calc(16px + env(safe-area-inset-bottom,0px));box-sizing:border-box;color:#1f2328;background:#fff;border:1px solid #c9ced3;border-radius:14px;flex-direction:column;gap:10px;padding:14px;font-size:14px;line-height:20px;display:flex;position:fixed;box-shadow:0 8px 32px #00000038}.XgsC0q_heading{color:#1f2328;font-size:14px;font-weight:600}.XgsC0q_hint{color:#3f4753;font-size:12px;line-height:17px}.XgsC0q_input{box-sizing:border-box;width:100%;color:inherit;background:#fff;border:1px solid #c9ced3;border-radius:6px;outline:none;padding:6px 8px;font-size:13px;line-height:20px}.XgsC0q_input:focus{border-color:#0969da}.XgsC0q_failure{color:#d1242f;word-break:break-word;font-size:12px;line-height:17px}.XgsC0q_actions{justify-content:flex-end;gap:8px;display:flex}.XgsC0q_cancel,.XgsC0q_submit{cursor:pointer;border:none;border-radius:6px;padding:5px 12px;font-size:13px;line-height:18px}.XgsC0q_cancel{color:#1f2328;background:0 0}.XgsC0q_cancel:hover{background:#80808024}.XgsC0q_submit{color:#fff;background:#0969da}.XgsC0q_submit:disabled,.XgsC0q_cancel:disabled{opacity:.55;cursor:default}";
		const tagId$1 = "dsh-do/AddWorkspaceDialog.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-do";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var AddWorkspaceDialog_module_css_default = {
			"cancel": "XgsC0q_cancel",
			"input": "XgsC0q_input",
			"actions": "XgsC0q_actions",
			"submit": "XgsC0q_submit",
			"backdrop": "XgsC0q_backdrop",
			"card": "XgsC0q_card",
			"heading": "XgsC0q_heading",
			"cardMobile": "XgsC0q_cardMobile",
			"hint": "XgsC0q_hint",
			"failure": "XgsC0q_failure"
		};
		//#endregion
		//#region src/client/AddWorkspaceDialog.tsx
		/** Dialog width used to clamp the anchor so the dialog stays on screen. */
		const DIALOG_WIDTH = 340;
		/**
		* The "add workspace" dialog opened by a right-click on the sidebar's native
		* add-workspace button: paste any directory path (Windows or POSIX), submit,
		* and the host registers it as a real Workspace via `ctx.workspaces.create`.
		* @returns the dialog, or null while closed.
		*/
		function AddWorkspaceDialog() {
			const state = (0, react.useSyncExternalStore)(subscribeAddWorkspaceDialog, getAddWorkspaceDialogState);
			const [value, setValue] = (0, react.useState)("");
			const [pending, setPending] = (0, react.useState)(false);
			const [failure, setFailure] = (0, react.useState)(null);
			const [mobile, setMobile] = (0, react.useState)(false);
			const inputRef = (0, react.useRef)(null);
			const request = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => () => {
				request.current = void 0;
			}, []);
			(0, react.useEffect)(() => {
				request.current = void 0;
				setPending(false);
				if (!state.open) return;
				setValue("");
				setFailure(null);
				setMobile(window.matchMedia("(max-width: 480px)").matches);
				const frame = requestAnimationFrame(() => {
					inputRef.current?.focus();
					inputRef.current?.select();
				});
				const onKeyDown = (event) => {
					if (event.key === "Escape") closeAddWorkspaceDialog();
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					cancelAnimationFrame(frame);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [state]);
			const submit = (0, react.useCallback)(async () => {
				if (request.current !== void 0 || !isCurrentWorkspaceDialog(state)) return;
				const path = value.trim();
				if (path.length === 0) {
					setFailure("请输入一个目录路径（Windows 如 C:\\work\\repo，POSIX 如 /home/user/repo）");
					return;
				}
				const workspaces = getWorkspacesService();
				if (workspaces === void 0) {
					setFailure("workspaces 服务尚未就绪，请稍后再试");
					return;
				}
				const token = Symbol("workspace-request");
				request.current = token;
				const current = () => request.current === token && isCurrentWorkspaceDialog(state);
				setPending(true);
				setFailure(null);
				try {
					await workspaces.create({ path });
					if (current()) closeAddWorkspaceDialog();
				} catch (error) {
					if (current()) {
						const message = error instanceof Error ? error.message : String(error);
						setFailure(`添加失败：${message}`);
					}
				} finally {
					if (current()) setPending(false);
					if (request.current === token) request.current = void 0;
				}
			}, [value, state]);
			if (!state.open) return null;
			const left = mobile ? void 0 : Math.max(8, Math.min(state.x, window.innerWidth - DIALOG_WIDTH - 8));
			const top = mobile ? void 0 : Math.max(8, Math.min(state.y, window.innerHeight - 180));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: AddWorkspaceDialog_module_css_default.backdrop,
				role: "presentation",
				onPointerDown: (event) => {
					if (event.target === event.currentTarget) closeAddWorkspaceDialog();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: mobile ? AddWorkspaceDialog_module_css_default.cardMobile : AddWorkspaceDialog_module_css_default.card,
					style: mobile ? void 0 : {
						left,
						top
					},
					role: "dialog",
					"aria-label": "添加工作区",
					onSubmit: (event) => {
						event.preventDefault();
						submit();
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: AddWorkspaceDialog_module_css_default.heading,
							children: "添加工作区"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: AddWorkspaceDialog_module_css_default.hint,
							children: "粘贴目录路径（多系统兼容：Windows 或 POSIX 路径均可），回车确认。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							ref: inputRef,
							className: AddWorkspaceDialog_module_css_default.input,
							type: "text",
							spellCheck: false,
							placeholder: "C:\\work\\repo 或 /home/user/repo",
							value,
							disabled: pending,
							onChange: (event) => {
								setValue(event.target.value);
							}
						}),
						failure !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: AddWorkspaceDialog_module_css_default.failure,
							role: "status",
							children: failure
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AddWorkspaceDialog_module_css_default.actions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: AddWorkspaceDialog_module_css_default.cancel,
								disabled: pending,
								onClick: closeAddWorkspaceDialog,
								children: "取消"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: AddWorkspaceDialog_module_css_default.submit,
								disabled: pending || value.trim().length === 0,
								children: pending ? "添加中…" : "添加"
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region \0dsh-css:F:\开发\开源\GitHub\dsh loop\src\client\GitHubSearch.module.css.mjs
		const css = ".GcuF6a_footerButton{color:#3f4753;cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;gap:6px;padding:5px 8px;font-size:12px;line-height:16px;display:inline-flex}.GcuF6a_footerButton:hover{color:#1f2328;background:#80808024}.GcuF6a_footerLabel{white-space:nowrap}.GcuF6a_panelBackdrop{z-index:999;pointer-events:auto;position:fixed;inset:0}.GcuF6a_panel{box-sizing:border-box;color:#1f2328;background:#fff;border:1px solid #c9ced3;border-radius:14px;flex-direction:column;gap:12px;width:340px;max-width:calc(100vw - 16px);max-height:min(560px,100vh - 16px);padding:12px;font-size:13px;line-height:18px;display:flex;position:fixed;bottom:8px;left:8px;overflow-y:auto;box-shadow:0 12px 40px #00000038}.GcuF6a_panelHeader{justify-content:space-between;align-items:center;gap:8px;display:flex}.GcuF6a_panelTitle{color:#1f2328;font-size:14px;font-weight:700}.GcuF6a_close{color:#3f4753;cursor:pointer;background:0 0;border:none;border-radius:4px;padding:2px 4px;font-size:14px;line-height:16px}.GcuF6a_close:hover{background:#80808024}.GcuF6a_searchRow{gap:8px;display:flex}.GcuF6a_tabs{border-bottom:1px solid #e1e4e8;gap:4px;padding-bottom:6px;display:flex}.GcuF6a_tab,.GcuF6a_tabActive{cursor:pointer;color:#3f4753;background:0 0;border:none;border-radius:6px;padding:4px 12px;font-size:13px;line-height:18px}.GcuF6a_tab:hover{color:#1f2328;background:#8080801a}.GcuF6a_tabActive{color:#0969da;background:#0969da14;font-weight:600}.GcuF6a_searchInput{box-sizing:border-box;color:#1f2328;background:#fff;border:1px solid #c9ced3;border-radius:8px;outline:none;flex:1;min-width:0;padding:7px 10px;font-size:13px;line-height:18px}.GcuF6a_searchInput:focus{border-color:#0969da}.GcuF6a_searchButton{cursor:pointer;color:#fff;background:#0969da;border:none;border-radius:8px;flex:none;padding:7px 14px;font-size:13px;line-height:18px}.GcuF6a_searchButton:disabled{opacity:.55;cursor:default}.GcuF6a_muted{color:#3f4753;font-size:12px}.GcuF6a_errorText{color:#d1242f;font-size:12px;line-height:17px}.GcuF6a_repoList{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}.GcuF6a_repoItem{background:#80808014;border-radius:8px;flex-direction:column;gap:4px;padding:8px 10px;display:flex}.GcuF6a_repoTop{justify-content:space-between;align-items:center;gap:8px;display:flex}.GcuF6a_repoName{color:#0969da;word-break:break-all;flex:1;min-width:0;font-weight:600;text-decoration:none}.GcuF6a_repoName:hover{text-decoration:underline}.GcuF6a_aiInstall{cursor:pointer;color:#1f2328;background:#fff;border:1px solid #8a919c;border-radius:6px;flex:none;padding:3px 10px;font-size:12px;line-height:16px}.GcuF6a_aiInstall:hover{background:#8080801f}.GcuF6a_aiInstall:disabled{opacity:.55;cursor:default}.GcuF6a_repoMeta{color:#3f4753;font-size:12px}.GcuF6a_repoDesc{color:#3f4753;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:12px;line-height:17px;display:-webkit-box;overflow:hidden}.GcuF6a_installOk{color:#1a7f37;font-size:12px;line-height:17px}@media (width<=480px){.GcuF6a_panel{width:auto;max-width:none;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));max-height:calc(100vh - 16px - env(safe-area-inset-bottom,0px))}.GcuF6a_searchButton{padding:9px 14px}.GcuF6a_aiInstall{padding:6px 12px;font-size:13px}.GcuF6a_repoItem{padding:10px}}";
		const tagId = "dsh-do/GitHubSearch.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-do";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var GitHubSearch_module_css_default = {
			"footerButton": "GcuF6a_footerButton",
			"tabs": "GcuF6a_tabs",
			"panelBackdrop": "GcuF6a_panelBackdrop",
			"close": "GcuF6a_close",
			"repoList": "GcuF6a_repoList",
			"repoItem": "GcuF6a_repoItem",
			"installOk": "GcuF6a_installOk",
			"repoTop": "GcuF6a_repoTop",
			"repoDesc": "GcuF6a_repoDesc",
			"panelTitle": "GcuF6a_panelTitle",
			"tab": "GcuF6a_tab",
			"footerLabel": "GcuF6a_footerLabel",
			"muted": "GcuF6a_muted",
			"searchInput": "GcuF6a_searchInput",
			"repoName": "GcuF6a_repoName",
			"panelHeader": "GcuF6a_panelHeader",
			"aiInstall": "GcuF6a_aiInstall",
			"repoMeta": "GcuF6a_repoMeta",
			"searchRow": "GcuF6a_searchRow",
			"tabActive": "GcuF6a_tabActive",
			"searchButton": "GcuF6a_searchButton",
			"errorText": "GcuF6a_errorText",
			"panel": "GcuF6a_panel"
		};
		//#endregion
		//#region src/client/github.ts
		function parseGitHubResults(payload) {
			if (typeof payload !== "object" || payload === null || !("items" in payload) || !Array.isArray(payload.items)) throw new Error("Invalid GitHub search response");
			return payload.items.map((item) => {
				if (typeof item !== "object" || item === null) throw new Error("Invalid GitHub repository");
				const repo = item;
				if (typeof repo.full_name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name) || repo.html_url !== `https://github.com/${repo.full_name}` || typeof repo.stargazers_count !== "number" || !Number.isSafeInteger(repo.stargazers_count) || repo.stargazers_count < 0 || !(repo.description === null || typeof repo.description === "string") || !(repo.language === null || typeof repo.language === "string")) throw new Error("Invalid GitHub repository");
				return {
					full_name: repo.full_name,
					html_url: repo.html_url,
					description: repo.description,
					stargazers_count: repo.stargazers_count,
					language: repo.language
				};
			});
		}
		/** One request lane: superseded or disposed responses never own the UI. */
		function createRequestLane() {
			let current;
			return {
				begin() {
					current?.abort();
					const controller = new AbortController();
					current = controller;
					return {
						signal: controller.signal,
						isCurrent: () => current === controller && !controller.signal.aborted
					};
				},
				cancel() {
					current?.abort();
					current = void 0;
				}
			};
		}
		//#endregion
		//#region src/client/GitHubSearchButton.tsx
		/** GitHub Octocat mark (official path, rendered in the current text color). */
		function GitHubIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				viewBox: "0 0 16 16",
				width: "18",
				height: "18",
				fill: "currentColor",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					fillRule: "evenodd",
					d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
				})
			});
		}
		/** Build the install prompt handed to a brand-new session for one repo. */
		function installPromptFor(repo) {
			return [
				`请帮我安装 DSH 插件：${repo.full_name}`,
				`仓库：${repo.html_url}`,
				"",
				"步骤：",
				"1. 先确认它是有效的 DSH 插件（package.json 含 dsh.bundle，且 patch/产物完整可加载）；",
				"2. 用 dsh plugin --profile web add github:<owner>/<repo> 安装（若它是 npm 包则用包名）；",
				"3. 验证安装结果（bundle 层已注册、--dump-config 能看到），并告诉我是否需要重启 profile 生效。"
			].join("\n");
		}
		/**
		* Sidebar GitHub button: opens a search panel with two tabs — "项目" (GitHub
		* `dsh-plugin` repositories, default) and "插件" (GitHub keyword search for
		* `dsh-plugin`) — each hit carrying an "AI install" button that opens a
		* brand-new session pre-filled with an install prompt. The right-click "add
		* workspace" dialog rides along.
		* @param props - the sidebar footer action owner share (`wide` = expanded sidebar).
		* @returns the footer button, its search panel, and the workspace dialog.
		*/
		function GitHubSearchButton({ wide }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [tab, setTab] = (0, react.useState)("projects");
			const [query, setQuery] = (0, react.useState)("");
			const [projects, setProjects] = (0, react.useState)({
				status: "idle",
				repos: []
			});
			const [plugins, setPlugins] = (0, react.useState)({
				status: "idle",
				repos: []
			});
			const [installs, setInstalls] = (0, react.useState)({});
			const lanes = (0, react.useRef)({
				projects: createRequestLane(),
				plugins: createRequestLane()
			});
			const installLane = (0, react.useRef)(createRequestLane());
			const alive = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				alive.current = true;
				return () => {
					alive.current = false;
					lanes.current.projects.cancel();
					lanes.current.plugins.cancel();
					installLane.current.cancel();
				};
			}, []);
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOnEscape = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", closeOnEscape);
				return () => document.removeEventListener("keydown", closeOnEscape);
			}, [open]);
			const runProjectsSearch = (0, react.useCallback)(async (rawQuery) => {
				const request = lanes.current.projects.begin();
				setProjects((current) => ({
					...current,
					status: "loading"
				}));
				try {
					const terms = rawQuery.trim();
					const q = terms.length === 0 ? "dsh" : terms;
					const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, {
						headers: { Accept: "application/vnd.github+json" },
						signal: request.signal
					});
					if (!response.ok) throw new Error(`GitHub API ${response.status}`);
					const repos = parseGitHubResults(await response.json());
					if (!alive.current || !request.isCurrent()) return;
					setProjects({
						status: "done",
						repos
					});
				} catch (error) {
					if (!alive.current || !request.isCurrent()) return;
					setProjects({
						status: "error",
						repos: []
					});
				}
			}, []);
			const runPluginsSearch = (0, react.useCallback)(async (rawQuery) => {
				const request = lanes.current.plugins.begin();
				setPlugins((current) => ({
					...current,
					status: "loading"
				}));
				try {
					const terms = rawQuery.trim();
					const q = terms.length === 0 ? "dsh-plugin" : terms;
					const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, {
						headers: { Accept: "application/vnd.github+json" },
						signal: request.signal
					});
					if (!response.ok) throw new Error(`GitHub API ${response.status}`);
					const repos = parseGitHubResults(await response.json());
					if (!alive.current || !request.isCurrent()) return;
					setPlugins({
						status: "done",
						repos
					});
				} catch (error) {
					if (!alive.current || !request.isCurrent()) return;
					setPlugins({
						status: "error",
						repos: []
					});
				}
			}, []);
			/** Ask the host to open a new session with the install prompt. */
			const aiInstall = (0, react.useCallback)(async (name, prompt) => {
				const request = installLane.current.begin();
				setInstalls((current) => ({
					...current,
					[name]: {
						name,
						status: "working"
					}
				}));
				try {
					const response = await fetch("/dsh-do/ai-install", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json"
						},
						body: JSON.stringify({ prompt }),
						signal: request.signal
					});
					const payload = await response.json();
					if (!alive.current || !request.isCurrent()) return;
					if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`);
					setInstalls((current) => ({
						...current,
						[name]: {
							name,
							status: "done",
							message: "已在新会话中开始安装"
						}
					}));
				} catch (error) {
					if (!alive.current || !request.isCurrent()) return;
					setInstalls((current) => ({
						...current,
						[name]: {
							name,
							status: "error",
							message: error instanceof Error ? error.message : String(error)
						}
					}));
				}
			}, []);
			const submit = (0, react.useCallback)(() => {
				if (tab === "projects") runProjectsSearch(query);
				else runPluginsSearch(query);
			}, [
				tab,
				query,
				runProjectsSearch,
				runPluginsSearch
			]);
			const projectsBusy = projects.status === "loading";
			const pluginsBusy = plugins.status === "loading";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddWorkspaceDialog, {}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: GitHubSearch_module_css_default.footerButton,
					"aria-label": "GitHub 插件搜索",
					"aria-expanded": open,
					title: "插件发现（GitHub 项目 / 插件仓库）",
					onClick: () => {
						setOpen((current) => !current);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GitHubIcon, {}), wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: GitHubSearch_module_css_default.footerLabel,
						children: "发现"
					})]
				}),
				open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: GitHubSearch_module_css_default.panelBackdrop,
					role: "presentation",
					onPointerDown: (event) => {
						if (event.target === event.currentTarget) setOpen(false);
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: GitHubSearch_module_css_default.panel,
						role: "dialog",
						"aria-label": "插件发现",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: GitHubSearch_module_css_default.panelHeader,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: GitHubSearch_module_css_default.panelTitle,
									children: "插件发现"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: GitHubSearch_module_css_default.close,
									"aria-label": "关闭",
									onClick: () => {
										setOpen(false);
									},
									children: "✕"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: GitHubSearch_module_css_default.tabs,
								role: "tablist",
								"aria-label": "搜索来源",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": tab === "projects",
									className: tab === "projects" ? GitHubSearch_module_css_default.tabActive : GitHubSearch_module_css_default.tab,
									onClick: () => {
										setTab("projects");
									},
									children: "项目"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": tab === "plugins",
									className: tab === "plugins" ? GitHubSearch_module_css_default.tabActive : GitHubSearch_module_css_default.tab,
									onClick: () => {
										setTab("plugins");
									},
									children: "插件"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								className: GitHubSearch_module_css_default.searchRow,
								onSubmit: (event) => {
									event.preventDefault();
									submit();
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: GitHubSearch_module_css_default.searchInput,
									type: "text",
									spellCheck: false,
									placeholder: tab === "projects" ? "输入关键词搜索 GitHub 项目（留空浏览 dsh 相关）" : "输入关键词搜索插件仓库（留空浏览 dsh-plugin）",
									value: query,
									onChange: (event) => {
										setQuery(event.target.value);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "submit",
									className: GitHubSearch_module_css_default.searchButton,
									disabled: projectsBusy || pluginsBusy,
									children: projectsBusy || pluginsBusy ? "搜索中…" : "搜索"
								})]
							}),
							tab === "projects" && projects.status === "idle" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: GitHubSearch_module_css_default.muted,
								children: "通用项目搜索：输入任何关键词搜 GitHub 项目（不含安装）。"
							}),
							tab === "projects" && projects.status === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: GitHubSearch_module_css_default.errorText,
								children: "搜索失败（GitHub API 限流或网络问题），稍后再试。"
							}),
							tab === "projects" && projects.status === "done" && projects.repos.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: GitHubSearch_module_css_default.muted,
								children: "没有找到匹配的 GitHub 项目"
							}),
							tab === "plugins" && plugins.status === "idle" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: GitHubSearch_module_css_default.muted,
								children: "输入仓库名/关键词自由搜索 GitHub；留空浏览 dsh-plugin 相关仓库。"
							}),
							tab === "plugins" && plugins.status === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: GitHubSearch_module_css_default.errorText,
								children: "搜索失败（GitHub API 限流或网络问题），稍后再试。"
							}),
							tab === "plugins" && plugins.status === "done" && plugins.repos.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: GitHubSearch_module_css_default.muted,
								children: "没有找到匹配的 dsh 插件仓库"
							}),
							tab === "projects" && projects.status === "done" && projects.repos.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: GitHubSearch_module_css_default.repoList,
								children: projects.repos.map((repo) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: GitHubSearch_module_css_default.repoItem,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
											className: GitHubSearch_module_css_default.repoName,
											href: repo.html_url,
											target: "_blank",
											rel: "noreferrer",
											children: repo.full_name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: GitHubSearch_module_css_default.repoMeta,
											children: [
												repo.stargazers_count,
												" ★",
												repo.language === null ? "" : ` · ${repo.language}`
											]
										}),
										repo.description !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: GitHubSearch_module_css_default.repoDesc,
											children: repo.description
										})
									]
								}, repo.full_name))
							}),
							tab === "plugins" && plugins.status === "done" && plugins.repos.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: GitHubSearch_module_css_default.repoList,
								children: plugins.repos.map((repo) => {
									const install = installs[repo.full_name];
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
										className: GitHubSearch_module_css_default.repoItem,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: GitHubSearch_module_css_default.repoTop,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
													className: GitHubSearch_module_css_default.repoName,
													href: repo.html_url,
													target: "_blank",
													rel: "noreferrer",
													children: repo.full_name
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: GitHubSearch_module_css_default.aiInstall,
													disabled: install?.status === "working",
													onClick: () => {
														aiInstall(repo.full_name, installPromptFor(repo));
													},
													children: install?.status === "working" ? "启动中…" : "AI 安装"
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: GitHubSearch_module_css_default.repoMeta,
												children: [
													repo.stargazers_count,
													" ★",
													repo.language === null ? "" : ` · ${repo.language}`
												]
											}),
											repo.description !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: GitHubSearch_module_css_default.repoDesc,
												children: repo.description
											}),
											install?.status === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: GitHubSearch_module_css_default.installOk,
												role: "status",
												children: install.message
											}),
											install?.status === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: GitHubSearch_module_css_default.errorText,
												role: "status",
												children: install.message
											})
										]
									}, repo.full_name);
								})
							})
						]
					})
				})
			] });
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the slot registry and the workspaces face. */
		const inject = ["slots", "workspaces"];
		/** Selectors matching the sidebar's native add-workspace button in both shipped locales. */
		const ADD_WORKSPACE_BUTTON_SELECTOR = "button[aria-label=\"添加工作区\"], button[aria-label=\"Add workspace\"]";
		/**
		* Browser plugin body: the sidebar-footer GitHub search entry plus the
		* right-click wiring for the native add-workspace button.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => setWorkspacesService(ctx.workspaces), "dsh-do: workspace dialog state");
			ctx.effect(() => {
				const onContextMenu = (event) => {
					const target = event.target;
					if (!(target instanceof Element)) return;
					if (target.closest(ADD_WORKSPACE_BUTTON_SELECTOR) === null) return;
					event.preventDefault();
					openAddWorkspaceDialog(event.clientX, event.clientY);
				};
				document.addEventListener("contextmenu", onContextMenu);
				return () => document.removeEventListener("contextmenu", onContextMenu);
			}, "dsh-do: add-workspace context menu");
			ctx.slots.inject("sidebar.footer.action", () => {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "dsh-do-github",
					order: 10,
					label: "GitHub 插件搜索"
				}, GitHubSearchButton);
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-do",
				order: 40,
				label: "dsh-DO"
			}, DoSettingsPage));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map