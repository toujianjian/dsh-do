import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { HarnessError, boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { isDeepStrictEqual } from "node:util";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/ai-install.js
/**
* "AI install" bridge: the browser half POSTs a generated install prompt to
* `/dsh-do/ai-install`; the host creates a fresh agent session and follows up
* with that prompt, so a brand-new session starts installing the plugin on
* its own. The created session appears in the normal session list.
*
* @module dsh-do/ai-install
*/
/** Route and body budget for the bridge. */
const AI_INSTALL_PATH = "/dsh-do/ai-install";
const MAX_BODY_BYTES = 65536;
/** Read and JSON-parse a bounded request body. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text.length === 0 ? void 0 : JSON.parse(text);
}
/** Write a JSON response with a stable cache policy. */
function json(res, status, value) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(JSON.stringify(value));
}
/**
* The DeepSeek Harness home / installation root, honoring `$DSH_HOME` and
* defaulting to `~/.dsh` — the directory under which profiles (and thus plugin
* installs) live.
*/
function resolveDshHome() {
	const configured = process.env.DSH_HOME;
	if (typeof configured === "string" && configured.trim() !== "") return configured;
	return join(homedir(), ".dsh");
}
/** Sub-directory under the DSH home where AI-install workspaces live. */
const INSTALL_WORKSPACES_DIR = "dsh-do-installs";
/**
* Create a dedicated workspace for one AI-install session: a fresh folder under
* the DSH home (`$DSH_HOME/dsh-do-installs/install-<uuid>`), registered with
* the durable workspace registry so it shows up as a real workspace in the
* sidebar and owns a stable cwd the install agent works inside. The folder is
* always newly minted (a random suffix), so concurrent installs never collide
* and the install agent never runs inside another user workspace.
* @param child - the plugin's sibling context (for `workspaceRegistry`).
* @returns the absolute existing directory to use as the session cwd.
*/
async function createInstallWorkspace(child) {
	const dir = join(resolveDshHome(), INSTALL_WORKSPACES_DIR, `install-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const registry = child.get("workspaceRegistry");
	if (registry !== void 0 && typeof registry.create === "function") await registry.create(dir, "DSH 插件安装");
	return dir;
}
/**
* Resolve the model route the spawned install agent needs to assemble its
* persona: the deployment default selection first, then any live agent.
* The cwd is handled separately (a freshly created install workspace); only
* `{{model}}` is resolved here.
*/
function resolveModelRoute(child) {
	const defaultModel = child.get("agentDefaultModel");
	let provider;
	let model;
	if (typeof defaultModel?.currentSelection === "function") try {
		const selection = defaultModel.currentSelection();
		if (selection !== void 0 && typeof selection.provider === "string" && selection.provider !== "" && typeof selection.model === "string" && selection.model !== "") {
			provider = selection.provider;
			model = selection.model;
		}
	} catch {}
	for (const agent of child.agents.list()) {
		if (provider !== void 0 && model !== void 0) break;
		const candidateProvider = agent.options?.provider;
		const candidateModel = agent.options?.model;
		if (candidateProvider === void 0 || candidateModel === void 0) continue;
		if (typeof candidateProvider === "string" && candidateProvider !== "" && typeof candidateModel === "string" && candidateModel !== "") {
			provider = candidateProvider;
			model = candidateModel;
		}
	}
	if (provider === void 0 || model === void 0) return void 0;
	return {
		provider,
		model
	};
}
/**
* Install the `POST /dsh-do/ai-install` route. Lazy sibling injection for the
* web server; the agents service is required to spawn the install session.
* @param ctx - the plugin context.
*/
function installAiInstallRoute(ctx) {
	ctx.inject([
		"webServer",
		"agents",
		"agentDefaultModel"
	], (child) => {
		const server = child.get("webServer");
		child.effect(() => server.register({
			kind: "exact",
			path: AI_INSTALL_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, {
						ok: false,
						error: "method not allowed (use POST)"
					});
					return;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					json(res, 400, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
					return;
				}
				const prompt = typeof body === "object" && body !== null && typeof body.prompt === "string" ? body.prompt.trim() : "";
				if (prompt.length === 0) {
					json(res, 400, {
						ok: false,
						error: "prompt is required"
					});
					return;
				}
				try {
					const sessionId = `dsh-do-install-${randomUUID()}`;
					const route = resolveModelRoute(child);
					if (route === void 0) {
						json(res, 500, {
							ok: false,
							error: "no model route available (agentDefaultModel has no selection and no live agent has provider/model)"
						});
						return;
					}
					const cwd = await createInstallWorkspace(child);
					const agentPresets = child.get("agentPresets");
					const presetId = agentPresets !== void 0 && typeof agentPresets.defaultId === "string" && agentPresets.defaultId !== "" ? agentPresets.defaultId : void 0;
					(await child.agents.create({
						sessionId,
						agentOptions: route,
						meta: {
							cwd,
							...presetId !== void 0 ? { agentPreset: presetId } : {}
						},
						setup: async (agentCtx) => {
							if (presetId !== void 0) await agentCtx.get("agentPresets")?.mount(agentCtx, presetId);
						}
					})).agent.followup(createUserMessage({
						content: [{
							type: "text",
							text: prompt
						}],
						source: {
							kind: "plugin",
							plugin: "dsh-do",
							form: "notice",
							summary: boundContextSummary(`AI install: ${prompt.slice(0, 60)}`)
						}
					}));
					json(res, 200, {
						ok: true,
						sessionId
					});
				} catch (error) {
					json(res, 500, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
		}, "dsh-do.ai-install-route()"));
	});
}
//#endregion
//#region lib/types/checkpoint.js
/**
* File-per-loop checkpoint store. Each loop owns one `<root>/loop-<id>.json`;
* every write is an atomic whole-file publish (same-directory temp + fsync +
* rename), and writes to one file are serialized through an in-flight chain so
* concurrent transitions cannot interleave whole-file replacements.
*
* @module dsh-do/checkpoint
*/
const FILE_PREFIX = "loop-";
const FILE_SUFFIX = ".json";
/** Serialize one loop to its checkpoint document. */
function serializeCheckpoint(loop) {
	return `${JSON.stringify({
		version: 1,
		loop
	}, null, 2)}\n`;
}
const PHASES = [
	"active",
	"completed",
	"blocked",
	"cancelled"
];
/** Tolerant parse of one checkpoint file; returns the loop or a reason. */
function parseCheckpoint(text, fileName) {
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: `file ${fileName} is not valid JSON`
		};
	}
	if (typeof document !== "object" || document === null) return {
		ok: false,
		error: `file ${fileName} is not a JSON object`
	};
	const { version, loop } = document;
	if (version !== 1) return {
		ok: false,
		error: `file ${fileName} has unsupported version ${String(version)}`
	};
	if (typeof loop !== "object" || loop === null) return {
		ok: false,
		error: `file ${fileName} has no loop record`
	};
	const state = loop;
	if (typeof state.id !== "string" || typeof state.sessionId !== "string" || typeof state.objective !== "string") return {
		ok: false,
		error: `file ${fileName} has an invalid loop record`
	};
	if (typeof state.maxRounds !== "number" || !Number.isSafeInteger(state.maxRounds) || state.maxRounds < 1) return {
		ok: false,
		error: `file ${fileName} has an invalid maxRounds`
	};
	if (typeof state.phase !== "string" || !PHASES.includes(state.phase)) return {
		ok: false,
		error: `file ${fileName} has an invalid phase`
	};
	if (typeof state.armed !== "boolean") return {
		ok: false,
		error: `file ${fileName} has an invalid armed flag`
	};
	if (typeof state.roundsStarted !== "number" || !Number.isSafeInteger(state.roundsStarted) || state.roundsStarted < 0) return {
		ok: false,
		error: `file ${fileName} has an invalid roundsStarted`
	};
	const blockedReason = state.blockedReason;
	if (blockedReason !== void 0) {
		const reason = blockedReason;
		if (typeof reason.code !== "string" || typeof reason.message !== "string") return {
			ok: false,
			error: `file ${fileName} has an invalid blockedReason`
		};
	}
	for (const key of ["startedAt", "updatedAt"]) if (typeof state[key] !== "number") return {
		ok: false,
		error: `file ${fileName} has an invalid ${key}`
	};
	return {
		ok: true,
		loop: {
			id: state.id,
			sessionId: state.sessionId,
			objective: state.objective,
			maxRounds: state.maxRounds,
			phase: state.phase,
			armed: state.armed,
			roundsStarted: state.roundsStarted,
			...blockedReason === void 0 ? {} : { blockedReason: {
				code: blockedReason.code,
				message: blockedReason.message
			} },
			...typeof state.completedSummary === "string" ? { completedSummary: state.completedSummary } : {},
			...typeof state.cancelledReason === "string" ? { cancelledReason: state.cancelledReason } : {},
			startedAt: state.startedAt,
			updatedAt: state.updatedAt
		}
	};
}
/** Durably replace `path` with `data` (same-directory temp + fsync + rename). */
async function writeAtomic(path, data) {
	const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(tmp, "wx", 384);
		try {
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* File-per-loop checkpoint store. Reads are a tolerant directory scan; writes
* are atomic and serialized per file.
*/
var LoopStore = class {
	root;
	options;
	chains = /* @__PURE__ */ new Map();
	constructor(root, options = {}) {
		this.root = root;
		this.options = options;
	}
	path(loopId) {
		return join(this.root, `${FILE_PREFIX}${loopId}${FILE_SUFFIX}`);
	}
	/** Load every checkpoint file; returns loops keyed by session id. */
	async load() {
		const result = /* @__PURE__ */ new Map();
		let entries;
		try {
			entries = await readdir(this.root);
		} catch (error) {
			if (error.code === "ENOENT") return result;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.startsWith(FILE_PREFIX) || !entry.endsWith(FILE_SUFFIX)) continue;
			const filePath = join(this.root, entry);
			let text;
			try {
				text = await readFile(filePath, "utf8");
			} catch (error) {
				if (error.code === "ENOENT") continue;
				this.options.onError?.(`dsh-do: could not read checkpoint ${entry}: ${String(error)}`);
				continue;
			}
			const parsed = parseCheckpoint(text, entry);
			if (!parsed.ok) {
				this.options.onError?.(`dsh-do: skipping checkpoint ${entry}: ${parsed.error}`);
				continue;
			}
			const existing = result.get(parsed.loop.sessionId);
			if (existing === void 0 || parsed.loop.updatedAt > existing.updatedAt) result.set(parsed.loop.sessionId, parsed.loop);
		}
		return result;
	}
	/** Atomically persist one loop, serialized per file. */
	write(loop) {
		const target = this.path(loop.id);
		const next = (this.chains.get(target) ?? Promise.resolve()).catch(() => void 0).then(async () => {
			await mkdir(this.root, {
				recursive: true,
				mode: 448
			});
			await writeAtomic(target, serializeCheckpoint(loop));
		});
		this.chains.set(target, next);
		next.catch(() => void 0).finally(() => {
			if (this.chains.get(target) === next) this.chains.delete(target);
		});
		return next;
	}
};
//#endregion
//#region lib/types/loop.js
/**
* Pure loop domain: durable state shape, identities, and deterministic
* transitions. No runtime dependency beyond `node:crypto`; type-only imports
* keep the module side-effect free.
*
* @module dsh-do/loop
*/
/** Mint a loop identity from its string form. */
function LoopId(value) {
	return value;
}
/** Create a fresh, armed, active loop. */
function createLoop(input) {
	const now = input.now ?? Date.now();
	return {
		id: LoopId(`loop-${randomUUID()}`),
		sessionId: input.sessionId,
		objective: input.objective,
		maxRounds: input.maxRounds,
		phase: "active",
		armed: true,
		roundsStarted: 0,
		startedAt: now,
		updatedAt: now
	};
}
function touch(loop, now = Date.now()) {
	return {
		...loop,
		updatedAt: now
	};
}
/** Bump the highest admitted round; no-op for non-increasing values. */
function markRoundAdmitted(loop, round, now) {
	if (round <= loop.roundsStarted) return loop;
	return touch({
		...loop,
		roundsStarted: round
	}, now);
}
/** Arm or disarm the loop without changing its phase. */
function armLoop(loop, armed, now) {
	if (loop.armed === armed) return loop;
	return touch({
		...loop,
		armed
	}, now);
}
/** Mark the loop completed and disarm it. */
function markCompleted(loop, summary, now) {
	return touch({
		...loop,
		phase: "completed",
		armed: false,
		...summary === void 0 ? {} : { completedSummary: summary }
	}, now);
}
/** Mark the loop blocked and disarm it. */
function markBlocked(loop, reason, now) {
	return touch({
		...loop,
		phase: "blocked",
		armed: false,
		blockedReason: reason
	}, now);
}
/** Mark the loop cancelled and disarm it. */
function markCancelled(loop, reason, now) {
	return touch({
		...loop,
		phase: "cancelled",
		armed: false,
		...reason === void 0 ? {} : { cancelledReason: reason }
	}, now);
}
/** Narrow an arbitrary source to a {@link LoopMessageSource}. */
function isLoopSource(source) {
	return typeof source === "object" && source !== null && source.kind === "loop";
}
/**
* Highest loop round admitted into the session log. The durable log is the
* ground truth for round accounting; the checkpoint's `roundsStarted` is only
* a hint for sessions whose log is unavailable.
*/
function admittedRounds(agent, loopId) {
	let max = 0;
	for (const event of agent.session.events) {
		if (event.type !== "user/message") continue;
		const source = event.data.source;
		if (isLoopSource(source) && source.loopId === loopId && Number.isSafeInteger(source.round) && source.round > max) max = source.round;
	}
	return max;
}
/** Effective admitted-round count: durable log wins over the checkpoint hint. */
function effectiveRounds(agent, loop) {
	if (agent === void 0) return loop.roundsStarted;
	return Math.max(admittedRounds(agent, loop.id), loop.roundsStarted);
}
//#endregion
//#region lib/types/controller.js
/**
* Owner of the session-keyed loop registry and its durable checkpoints.
* Every mutation is applied to the live map and then published through the
* store; persistence failures are logged but never fail the mutation.
*
* @module dsh-do/controller
*/
/** Error codes surfaced to tools and the driver. */
const LOOP_ERROR = {
	ALREADY_ACTIVE: "LOOP_ALREADY_ACTIVE",
	NOT_ACTIVE: "LOOP_NOT_ACTIVE"
};
/**
* Session-keyed loop registry. One loop per session; `start` creates a fresh
* loop, re-arms a disarmed active loop, or replaces a terminal one.
*/
var LoopController = class {
	store;
	logger;
	loops = /* @__PURE__ */ new Map();
	constructor(store, logger) {
		this.store = store;
		this.logger = logger;
	}
	/** Load persisted loops into the registry. Idempotent; call once at startup. */
	async restore() {
		if (this.store === void 0) return;
		const loaded = await this.store.load();
		for (const [sessionId, loop] of loaded) this.loops.set(sessionId, loop);
		if (loaded.size > 0) this.logger.info(`dsh-do: restored ${loaded.size} checkpointed loop(s)`);
	}
	get(sessionId) {
		return this.loops.get(sessionId);
	}
	/** Create a fresh loop, or re-arm a disarmed one. Terminal loops are replaced. */
	start(sessionId, objective, maxRounds) {
		const existing = this.loops.get(sessionId);
		if (existing !== void 0 && existing.phase === "active") {
			if (existing.armed) throw new HarnessError("a loop is already active for this session; inspect it with loop_status, stop it with loop_cancel, or let it finish", LOOP_ERROR.ALREADY_ACTIVE);
			return this.commit(armLoop(existing, true));
		}
		const loop = createLoop({
			sessionId,
			objective,
			maxRounds
		});
		return this.commit(loop);
	}
	/** Mark the loop completed and disarm it. */
	complete(sessionId, summary) {
		return this.commit(markCompleted(this.requireActive(sessionId, "loop_done"), summary));
	}
	/** Mark the loop blocked and disarm it. */
	block(sessionId, code, message) {
		return this.commit(markBlocked(this.requireActive(sessionId, "loop driver"), {
			code,
			message
		}));
	}
	/** Mark the loop cancelled and disarm it. */
	cancel(sessionId, reason) {
		return this.commit(markCancelled(this.requireActive(sessionId, "loop_cancel"), reason));
	}
	/** Arm or disarm the loop without changing its phase. */
	arm(sessionId, armed) {
		const loop = this.loops.get(sessionId);
		if (loop === void 0) return void 0;
		return this.commit(armLoop(loop, armed));
	}
	/** Bump the highest admitted round and persist. */
	recordAdmitted(sessionId, loopId, round) {
		const loop = this.loops.get(sessionId);
		if (loop === void 0 || loop.id !== loopId) return;
		this.commit(markRoundAdmitted(loop, round));
	}
	requireActive(sessionId, caller) {
		const loop = this.loops.get(sessionId);
		if (loop === void 0 || loop.phase !== "active") throw new HarnessError(`${caller} requires an active loop for this session`, LOOP_ERROR.NOT_ACTIVE);
		return loop;
	}
	commit(loop) {
		this.loops.set(loop.sessionId, loop);
		if (this.store !== void 0) this.store.write(loop).catch((error) => {
			this.logger.warn(`dsh-do: checkpoint write failed for loop ${loop.id}: ${String(error)}`);
		});
		return loop;
	}
};
//#endregion
//#region lib/types/prompt.js
/**
* Render the complete round instruction retained in session history.
* @param objective - the loop's concrete completion objective.
* @param round - the next positive round number.
* @param maxRounds - the loop's round budget.
* @returns a fresh one-block prompt for `Agent.followup()`.
*/
function renderLoopRoundPrompt(objective, round, maxRounds) {
	return [{
		type: "text",
		text: `<loop_round>
Objective: ${JSON.stringify(objective)}
Round: ${round}/${maxRounds}

Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. If the objective is achieved, call loop_done with a short summary. If you are genuinely blocked, call loop_cancel with the concrete reason. Otherwise leave the loop active for the next round.
</loop_round>`
	}];
}
/**
* Render the closing-message instruction injected after an autonomous loop
* round reports `loop_done` or `loop_cancel`, so the model still addresses
* the user once before the turn ends.
* @param objective - the terminal loop's objective, echoed for grounding.
* @param ending - the validated terminal report.
* @returns a fresh one-block context for `ToolRunContext.deferContext()`.
*/
function renderLoopWrapupContext(objective, ending) {
	const heading = `Objective: ${JSON.stringify(objective)}\n`;
	if (ending.kind === "completed") return [{
		type: "text",
		text: `<loop_complete>
${heading}${ending.summary === void 0 ? "" : `Summary: ${JSON.stringify(ending.summary)}\n`}The loop is complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Note anything the user should review or do next. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.
</loop_complete>`
	}];
	return [{
		type: "text",
		text: `<loop_cancelled>
${heading}${ending.reason === void 0 ? "" : `Reason: ${JSON.stringify(ending.reason)}\n`}The loop is cancelled and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue. Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.
</loop_cancelled>`
	}];
}
//#endregion
//#region lib/types/driver.js
/**
* Round-continuation driver: after an armed active loop's agent goes idle,
* queue the next `<loop_round>` followup until the loop completes, blocks at
* its budget, or is cancelled. Mirrors the harness goal-round driver's
* race fences: competing-prompt detection, inbox claim/discard tracking, and
* the `agent/pre-step` reservation waterfall that rejects stale or foreign
* round prompts without disturbing other claimed messages.
*
* @module dsh-do/driver
*/
function renderThrown(value) {
	return value instanceof Error ? value.message : String(value);
}
/** Whether the queued record matches one exact reservation. */
function sameQueued(content, source, attempt) {
	return source.loopId === attempt.loopId && source.round === attempt.round && isDeepStrictEqual(content, attempt.content);
}
/**
* Install the round-continuation driver for one plugin context. The driver
* effect owns its teardown (joins every in-flight run, disarms every loop).
* When `restore` is supplied, listeners are installed only after it settles,
* and agents already idle at that point are nudged so a restored armed loop
* resumes without waiting for the next status transition.
*/
function installLoopDriver(ctx, controller, restore) {
	const states = /* @__PURE__ */ new Map();
	function stateFor(agent) {
		let state = states.get(agent);
		if (state === void 0) {
			state = {
				agent,
				attempt: void 0,
				competingQueued: false,
				requested: false,
				run: void 0,
				stopping: false
			};
			states.set(agent, state);
		}
		return state;
	}
	/** Read only when the exact Agent remains live. */
	function loopOf(state) {
		if (ctx.agents.get(state.agent.id) !== state.agent) return void 0;
		return controller.get(state.agent.session.id);
	}
	/** Whether this exact lifecycle is quiescent with no competing prompt. */
	function readyToDrive(state) {
		return ctx.fiber.state === 2 && !state.stopping && ctx.agents.get(state.agent.id) === state.agent && state.agent.status === "idle" && !state.competingQueued;
	}
	/** Remove automatic authority while preserving the durable phase. */
	function disarm(state) {
		try {
			const loop = loopOf(state);
			if (loop !== void 0 && loop.armed) controller.arm(state.agent.session.id, false);
		} catch (error) {
			ctx.logger.warn(`dsh-do: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`);
		}
	}
	/** Preserve claimed step context when the driver drops only its own round. */
	function restoreOtherClaimed(agent, messages, messageId) {
		const retained = messages.filter((message) => message.id !== messageId && !isLoopSource(message.source));
		for (const message of retained.toReversed()) {
			if (agent.inbox.nextStep.some((candidate) => candidate.id === message.id) || agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) continue;
			agent.inbox.prepend("next-step", message);
		}
	}
	/** Fail closed unless the queued prompt still owns the exact live revision. */
	function validReservation(state, content, source) {
		const attempt = state.attempt;
		const loop = loopOf(state);
		return ctx.fiber.state === 2 && !state.stopping && attempt !== void 0 && attempt.phase === "claimed" && !attempt.stale && sameQueued(content, source, attempt) && loop !== void 0 && loop.id === source.loopId && loop.phase === "active" && loop.armed && source.round === effectiveRounds(state.agent, loop) + 1;
	}
	/** Process admitted work at quiescence, then reserve at most one next round. */
	async function drive(state) {
		const { agent } = state;
		if (!readyToDrive(state)) return;
		if (state.attempt !== void 0) {
			state.attempt = void 0;
			state.requested = true;
			return;
		}
		const loop = loopOf(state);
		if (loop === void 0 || loop.phase !== "active" || !loop.armed) return;
		const rounds = effectiveRounds(agent, loop);
		if (rounds >= loop.maxRounds) {
			try {
				controller.block(agent.session.id, "round-limit", `Loop reached its configured limit of ${loop.maxRounds} rounds.`);
			} catch (error) {
				ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" at its round limit: ${renderThrown(error)}`);
			}
			return;
		}
		const round = rounds + 1;
		const content = renderLoopRoundPrompt(loop.objective, round, loop.maxRounds);
		const message = createUserMessage({
			content,
			source: {
				kind: "loop",
				loopId: loop.id,
				round
			}
		});
		state.attempt = {
			loopId: loop.id,
			round,
			messageId: message.id,
			content,
			phase: "queued",
			stale: false,
			cancelled: false
		};
		try {
			agent.followup(message);
		} catch (error) {
			state.attempt = void 0;
			ctx.logger.warn(`dsh-do: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`);
			const latest = loopOf(state);
			if (latest !== void 0 && latest.id === loop.id && latest.phase === "active" && latest.armed) try {
				controller.block(agent.session.id, "queue-failed", `Could not queue loop round ${round}: ${renderThrown(error)}`);
			} catch (blockError) {
				ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" after a queue failure: ${renderThrown(blockError)}`);
			}
		}
	}
	/** Coalesce triggers onto one agent-local serialized driver. */
	function requestDrive(state) {
		if (state.stopping) return;
		state.requested = true;
		if (state.run !== void 0) return;
		let run;
		try {
			run = ctx.agents.withoutInitiator(async () => {
				while (state.requested && !state.stopping) {
					state.requested = false;
					try {
						await drive(state);
					} catch (error) {
						ctx.logger.warn(`dsh-do: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`);
						disarm(state);
					}
				}
			});
		} catch (error) {
			ctx.logger.warn(`dsh-do: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state);
			return;
		}
		state.run = run;
		const retire = () => {
			state.run = void 0;
			if (state.requested && !state.stopping) requestDrive(state);
		};
		run.then(retire, (error) => {
			ctx.logger.warn(`dsh-do: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state);
			retire();
		});
	}
	ctx.effect(async function* () {
		if (restore !== void 0) await restore;
		ctx.on("agent/error", ({ agent }) => {
			disarm(stateFor(agent));
		});
		ctx.on("agent/created", ({ agent }) => {
			stateFor(agent);
		});
		ctx.on("agent/disposed", ({ agent }) => {
			states.delete(agent);
		});
		ctx.on("agent/session-start", ({ agent }) => {
			const state = stateFor(agent);
			state.attempt = void 0;
			state.competingQueued = false;
		});
		ctx.on("agent/status", ({ agent, status }) => {
			const state = stateFor(agent);
			if (status === "idle") {
				state.competingQueued = false;
				const attempt = state.attempt;
				const loop = loopOf(state);
				if ((attempt?.phase === "queued" || attempt?.phase === "claimed" || attempt?.cancelled) && loop?.phase === "active" && loop.armed) {
					state.attempt = void 0;
					try {
						controller.arm(agent.session.id, false);
					} catch (error) {
						ctx.logger.warn(`dsh-do: could not disarm agent "${agent.id}" after a cancelled round: ${renderThrown(error)}`);
						disarm(state);
					}
				}
				requestDrive(state);
			}
		});
		ctx.on("agent/inbox/inserted", ({ agent, message }) => {
			if (!agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) return;
			const state = stateFor(agent);
			const attempt = state.attempt;
			if (attempt !== void 0 && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) return;
			state.competingQueued = true;
			if (attempt?.phase === "queued") attempt.stale = true;
		});
		ctx.on("agent/inbox/claimed", ({ agent, message }) => {
			const attempt = stateFor(agent).attempt;
			if (attempt !== void 0 && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) attempt.phase = "claimed";
		});
		ctx.on("agent/inbox/discarded", ({ agent, message }) => {
			const attempt = stateFor(agent).attempt;
			if (attempt !== void 0 && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) attempt.cancelled = true;
		});
		ctx.on("session/event", (session, event) => {
			const agent = ctx.agents.get(session.id);
			if (agent === void 0 || agent.session !== session) return;
			const state = stateFor(agent);
			if (event.type === "user/message") {
				const source = event.data.source;
				if (isLoopSource(source)) {
					if (state.attempt !== void 0 && state.attempt.messageId === event.data.id) state.attempt.phase = "admitted";
					controller.recordAdmitted(session.id, source.loopId, source.round);
				}
				return;
			}
			if (event.type !== "turn/end") return;
			const reason = event.data.reason;
			if (reason.kind === "max-tokens") {
				disarm(state);
				return;
			}
			if (reason.kind !== "aborted") return;
			if (state.attempt?.phase === "claimed" || state.attempt?.phase === "admitted") state.attempt.cancelled = true;
			else disarm(state);
		});
		ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
			const submitted = messages.find((message) => isLoopSource(message.source));
			if (submitted === void 0 || !isLoopSource(submitted.source)) return next();
			const { content, source } = submitted;
			const state = stateFor(agent);
			let valid = false;
			try {
				valid = validReservation(state, content, source);
			} catch (error) {
				ctx.logger.warn(`dsh-do: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
			}
			if (!valid) {
				const attempt = state.attempt;
				if (attempt !== void 0 && source.loopId === attempt.loopId && source.round === attempt.round) {
					attempt.stale = true;
					state.attempt = void 0;
				}
				restoreOtherClaimed(agent, messages, submitted.id);
				requestDrive(state);
				return { kind: "reject" };
			}
			let decision;
			try {
				decision = await next();
			} catch (error) {
				if (signal.aborted) throw error;
				state.attempt = void 0;
				requestDrive(state);
				throw error;
			}
			if (signal.aborted) {
				if (decision.kind === "enter") restoreOtherClaimed(agent, decision.messages, submitted.id);
				return decision;
			}
			if (decision.kind === "reject") {
				state.attempt = void 0;
				const loop = loopOf(state);
				if (loop !== void 0 && loop.id === source.loopId && loop.phase === "active" && loop.armed) try {
					controller.block(agent.session.id, "prompt-rejected", "Loop round was rejected before entering its step.");
				} catch (error) {
					ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" after a rejected round: ${renderThrown(error)}`);
				}
				return decision;
			}
			try {
				valid = validReservation(state, content, source);
			} catch (error) {
				ctx.logger.warn(`dsh-do: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
				valid = false;
			}
			if (!valid) {
				state.attempt = void 0;
				restoreOtherClaimed(agent, decision.messages, submitted.id);
				requestDrive(state);
				return { kind: "reject" };
			}
			return decision;
		});
		for (const agent of ctx.agents.list()) {
			stateFor(agent);
			requestDrive(stateFor(agent));
		}
		yield async () => {
			const waits = [];
			for (const state of states.values()) {
				state.stopping = true;
				disarm(state);
				const attempt = state.attempt;
				if (attempt !== void 0) {
					attempt.stale = true;
					if (state.agent.status === "running") {
						state.agent.cancel({ kind: "parent" });
						waits.push(state.agent.whenIdle());
					}
				}
				if (state.run !== void 0) waits.push(state.run);
			}
			await Promise.allSettled(waits);
			states.clear();
		};
	}, "dsh-do.driver()");
}
//#endregion
//#region lib/types/tools.js
/** Execution-time authority checks for the model-facing loop tools. */
function reject(message, code = "LOOP_TOOL_AUTHORITY_REQUIRED") {
	throw new HarnessError(message, code);
}
/** Locate the open turn enclosing a model tool call. */
function openTurn(agent) {
	const events = agent.session.events;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const boundary = events[index];
		if (boundary?.type === "turn/end") reject("loop tools require an open model turn", "LOOP_TOOL_DRIVER_REQUIRED");
		if (boundary?.type === "turn/start") return { events: events.slice(index + 1) };
	}
	return reject("loop tools require an open model turn", "LOOP_TOOL_DRIVER_REQUIRED");
}
function loopToolExecution(ctx, exec) {
	const agent = exec.agent;
	if (agent === void 0) return reject("loop tools require a calling agent", "LOOP_TOOL_AGENT_REQUIRED");
	if (ctx.agents.get(agent.id) !== agent || agent.status !== "running" || ctx.agents.currentInitiator() !== agent) return reject("loop tools require the exact live calling agent inside its active driver", "LOOP_TOOL_DRIVER_REQUIRED");
	return {
		agent,
		...openTurn(agent)
	};
}
/**
* Whether host-attested human input appears in the current root-agent turn.
* An omitted source resolves to `user`, so non-human producers must supply
* their own source rather than inheriting this authority.
*/
function hasDirectHumanInput(ctx, execution) {
	if (!ctx.agents.roots().includes(execution.agent)) return false;
	return execution.events.some((event) => event.type === "user/message" && event.data.source.kind === "user");
}
/** Require authority originating in a human message accepted by a runtime root. */
function requireDirectHuman(ctx, execution) {
	if (!hasDirectHumanInput(ctx, execution)) reject("this loop operation requires a direct human turn on a top-level agent");
}
/** Whether this turn is the current loop's exact admitted round. */
function isMatchingLoopRound(execution, loop) {
	const rounds = effectiveRounds(execution.agent, loop);
	return execution.events.some((event) => event.type === "user/message" && isLoopSource(event.data.source) && event.data.source.loopId === loop.id && event.data.source.round === rounds);
}
/** Resolve completion authority from either direct human input or the exact loop round. */
function completionAuthority(ctx, execution, loop) {
	if (hasDirectHumanInput(ctx, execution)) return { kind: "direct-human" };
	if (isMatchingLoopRound(execution, loop)) return { kind: "loop-round" };
	return reject("loop_done and loop_cancel require a direct human turn or the current loop round");
}
/** Stable compact model result; `armed` is an observation, not replay state. */
function loopValue(agent, loop) {
	if (loop === void 0) return { loop: null };
	return { loop: {
		id: loop.id,
		objective: loop.objective,
		phase: loop.phase,
		armed: loop.armed,
		roundsStarted: effectiveRounds(agent, loop),
		maxRounds: loop.maxRounds,
		...loop.blockedReason === void 0 ? {} : { blockedReason: {
			code: loop.blockedReason.code,
			message: loop.blockedReason.message
		} },
		...loop.completedSummary === void 0 ? {} : { completedSummary: loop.completedSummary },
		...loop.cancelledReason === void 0 ? {} : { cancelledReason: loop.cancelledReason },
		startedAt: loop.startedAt,
		updatedAt: loop.updatedAt
	} };
}
/** Reusable canonical output declaration for all four loop controls. */
const LOOP_OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: { loop: { oneOf: [{
			type: "null",
			required: true
		}, {
			type: "object",
			additionalProperties: false,
			required: true,
			properties: {
				id: {
					type: "string",
					required: true
				},
				objective: {
					type: "string",
					required: true
				},
				phase: {
					type: "string",
					required: true,
					enum: [
						"active",
						"completed",
						"blocked",
						"cancelled"
					]
				},
				armed: {
					type: "boolean",
					required: true
				},
				roundsStarted: {
					type: "integer",
					required: true
				},
				maxRounds: {
					type: "integer",
					required: true
				},
				blockedReason: {
					type: "object",
					additionalProperties: false,
					properties: {
						code: {
							type: "string",
							required: true
						},
						message: {
							type: "string",
							required: true
						}
					}
				},
				completedSummary: { type: "string" },
				cancelledReason: { type: "string" },
				startedAt: {
					type: "number",
					required: true
				},
				updatedAt: {
					type: "number",
					required: true
				}
			}
		}] } }
	},
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
/** Generic, args-only pending presentation shared by the loop tools. */
function present(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind,
		...rawInput === void 0 ? {} : { rawInput }
	};
}
const START_DESCRIPTION = "Start one Claude Code-style autonomous loop for the current session: the driver then auto-continues across turns, re-queueing the objective as <loop_round> prompts until the model calls loop_done, the round budget is exhausted, or the loop is cancelled. Use when a direct human request is a long-running objective that should keep iterating in this same session. If an active loop exists but is disarmed (e.g. after a cancelled round), this re-arms it with the stored objective. Execution rejects non-human and subagent authority.";
const STATUS_DESCRIPTION = "Read the current loop for this session, including its exact id, objective, phase, rounds started, round budget, blocked reason when present, and whether it is armed to continue. Call this before loop_done or loop_cancel.";
const DONE_DESCRIPTION = "Mark the current loop complete with an optional short summary. Allowed only from a direct human turn or the current loop round; otherwise rejected. When called from a loop round, the driver ends the autonomous run and asks the model to write the closing message.";
const CANCEL_DESCRIPTION = "Mark the current loop cancelled with an optional concrete reason. Allowed only from a direct human turn or the current loop round; otherwise rejected. When called from a loop round, the driver ends the autonomous run and asks the model to write the closing message.";
/** Register the four loop tools. */
function registerLoopTools(ctx, controller, config) {
	ctx.tools.register(defineTool({
		name: "loop_start",
		description: START_DESCRIPTION,
		parameters: {
			objective: {
				type: "string",
				required: true,
				description: "The concrete completion objective to keep iterating toward across turns."
			},
			max_rounds: {
				type: "number",
				description: "Optional positive safe-integer cap on automatic continuation rounds (defaults to the configured defaultMaxRounds)."
			}
		},
		output: LOOP_OUTPUT,
		execute(args, exec) {
			const execution = loopToolExecution(ctx, exec);
			requireDirectHuman(ctx, execution);
			const maxRounds = args.max_rounds === void 0 ? config.defaultMaxRounds : args.max_rounds;
			if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new HarnessError("max_rounds must be a positive safe integer", "LOOP_TOOL_INVALID_ROUNDS");
			const loop = controller.start(execution.agent.session.id, args.objective, maxRounds);
			return Promise.resolve(loopValue(execution.agent, loop));
		},
		presentCall: (args) => present("Start loop", "other", args.objective)
	}));
	ctx.tools.register(defineTool({
		name: "loop_status",
		description: STATUS_DESCRIPTION,
		parameters: {},
		output: LOOP_OUTPUT,
		execute(_args, exec) {
			const execution = loopToolExecution(ctx, exec);
			return Promise.resolve(loopValue(execution.agent, controller.get(execution.agent.session.id)));
		},
		presentCall: () => present("Read loop status", "read")
	}));
	ctx.tools.register(defineTool({
		name: "loop_done",
		description: DONE_DESCRIPTION,
		parameters: { summary: {
			type: "string",
			description: "Optional one-line summary of what was achieved."
		} },
		output: LOOP_OUTPUT,
		execute(args, exec) {
			const execution = loopToolExecution(ctx, exec);
			const agent = execution.agent;
			const loop = controller.get(agent.session.id);
			if (loop === void 0 || loop.phase !== "active") return Promise.reject(new HarnessError("loop_done requires an active loop for this session", "LOOP_NOT_ACTIVE"));
			completionAuthority(ctx, execution, loop);
			if (isMatchingLoopRound(execution, loop)) exec.deferContext(createUserMessage({
				content: renderLoopWrapupContext(loop.objective, {
					kind: "completed",
					...args.summary === void 0 ? {} : { summary: args.summary }
				}),
				source: {
					kind: "plugin",
					plugin: "dsh-do",
					form: "notice",
					summary: boundContextSummary(`loop_done: ${loop.objective}`)
				}
			}));
			return Promise.resolve(loopValue(agent, controller.complete(agent.session.id, args.summary)));
		},
		presentCall: (args) => present("Complete loop", "other", args.summary)
	}));
	ctx.tools.register(defineTool({
		name: "loop_cancel",
		description: CANCEL_DESCRIPTION,
		parameters: { reason: {
			type: "string",
			description: "Optional concrete reason the loop cannot continue."
		} },
		output: LOOP_OUTPUT,
		execute(args, exec) {
			const execution = loopToolExecution(ctx, exec);
			const agent = execution.agent;
			const loop = controller.get(agent.session.id);
			if (loop === void 0 || loop.phase !== "active") return Promise.reject(new HarnessError("loop_cancel requires an active loop for this session", "LOOP_NOT_ACTIVE"));
			completionAuthority(ctx, execution, loop);
			if (isMatchingLoopRound(execution, loop)) exec.deferContext(createUserMessage({
				content: renderLoopWrapupContext(loop.objective, {
					kind: "cancelled",
					...args.reason === void 0 ? {} : { reason: args.reason }
				}),
				source: {
					kind: "plugin",
					plugin: "dsh-do",
					form: "notice",
					summary: boundContextSummary(`loop_cancel: ${loop.objective}`)
				}
			}));
			return Promise.resolve(loopValue(agent, controller.cancel(agent.session.id, args.reason)));
		},
		presentCall: (args) => present("Cancel loop", "other", args.reason)
	}));
}
//#endregion
//#region lib/types/index.js
/** Cordis plugin name. */
const name = "loop";
/** Required services. */
const inject = [
	"agents",
	"tools",
	"systemPrompt"
];
/** Config schema. */
const Config = z.object({
	defaultMaxRounds: z.number().step(1).min(1).default(20),
	checkpointDir: z.string().default(""),
	persist: z.boolean().default(true)
});
/** Derive the checkpoint root from configuration or the DSH home directory. */
function resolveCheckpointDir(checkpointDir) {
	if (checkpointDir !== "") return checkpointDir;
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "loops");
}
/** Model-visible policy guidance rendered as a system-prompt section. */
const LOOP_GUIDANCE = `Use loop tools for a Claude Code-style autonomous loop: when a direct human request is a long-running objective that should keep iterating across turns, call loop_start with the objective and an optional round budget; the loop then auto-continues until the model calls loop_done, the budget is exhausted, or the loop is cancelled. A cancelled round disarms the loop until loop_start re-arms it. Prefer goal tools for goal-scoped continuation and one mechanism per task.`;
/** Apply the plugin. */
function apply(ctx, config) {
	const controller = new LoopController(config.persist ? new LoopStore(resolveCheckpointDir(config.checkpointDir), { onError: (message) => ctx.logger.warn(message) }) : void 0, ctx.logger);
	const restore = controller.restore().catch((error) => {
		ctx.logger.warn(`dsh-do: checkpoint restore failed; continuing in memory: ${String(error)}`);
	});
	ctx.effect(async function* () {
		await restore;
		registerLoopTools(ctx, controller, { defaultMaxRounds: config.defaultMaxRounds });
	}, "dsh-do.tools()");
	ctx.effect(function* () {
		installLoopDriver(ctx, controller, restore);
	}, "dsh-do.driver()");
	installAiInstallRoute(ctx);
	ctx.systemPrompt.section({
		name: "tool:loop",
		order: 121,
		text: LOOP_GUIDANCE
	});
}
//#endregion
export { Config, apply, inject, name, resolveCheckpointDir };
