import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { HarnessError, boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { isDeepStrictEqual } from "node:util";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
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
function json$1(res, status, value) {
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
	try {
		const workspace = await registry.create(dir, "DSH 插件安装");
		return {
			path: dir,
			rollback: async () => {
				await registry.delete(workspace.id);
				await rmdir(dir).catch(() => void 0);
			}
		};
	} catch (error) {
		await rmdir(dir).catch(() => void 0);
		throw error;
	}
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
					res.setHeader("Allow", "POST");
					json$1(res, 405, {
						ok: false,
						error: "method not allowed (use POST)"
					});
					return;
				}
				const origin = req.headers.origin;
				let foreignOrigin = false;
				if (origin !== void 0) try {
					const url = new URL(origin);
					foreignOrigin = !["http:", "https:"].includes(url.protocol) || url.host !== req.headers.host;
				} catch {
					foreignOrigin = true;
				}
				if (foreignOrigin || req.headers["sec-fetch-site"] === "cross-site") {
					json$1(res, 403, {
						ok: false,
						error: "cross-site installation request denied"
					});
					return;
				}
				if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
					json$1(res, 415, {
						ok: false,
						error: "application/json is required"
					});
					return;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					json$1(res, 400, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
					return;
				}
				const prompt = typeof body === "object" && body !== null && typeof body.prompt === "string" ? body.prompt.trim() : "";
				if (prompt.length === 0) {
					json$1(res, 400, {
						ok: false,
						error: "prompt is required"
					});
					return;
				}
				let rollbackWorkspace;
				let disposeAgent;
				try {
					const sessionId = `dsh-do-install-${randomUUID()}`;
					const route = resolveModelRoute(child);
					if (route === void 0) {
						json$1(res, 500, {
							ok: false,
							error: "no model route available (agentDefaultModel has no selection and no live agent has provider/model)"
						});
						return;
					}
					const agentPresets = child.get("agentPresets");
					const presetId = agentPresets !== void 0 && typeof agentPresets.defaultId === "string" && agentPresets.defaultId !== "" ? agentPresets.defaultId : void 0;
					if (presetId === void 0 || typeof agentPresets?.mount !== "function" || typeof child.get("workspaceRegistry")?.create !== "function" || typeof child.get("workspaceRegistry")?.delete !== "function") {
						json$1(res, 503, {
							ok: false,
							error: "installation requires an agent preset and workspace registry"
						});
						return;
					}
					const workspace = await createInstallWorkspace(child);
					rollbackWorkspace = workspace.rollback;
					const cwd = workspace.path;
					const handle = await child.agents.create({
						sessionId,
						agentOptions: route,
						meta: {
							cwd,
							...presetId !== void 0 ? { agentPreset: presetId } : {}
						},
						setup: async (agentCtx) => {
							await agentPresets.mount(agentCtx, presetId);
						}
					});
					disposeAgent = () => handle.dispose();
					handle.agent.followup(createUserMessage({
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
					disposeAgent = void 0;
					rollbackWorkspace = void 0;
					json$1(res, 200, {
						ok: true,
						sessionId
					});
				} catch (error) {
					try {
						await disposeAgent?.();
						await rollbackWorkspace?.();
					} catch (cleanupError) {
						child.logger.warn(`dsh-do: install rollback failed: ${String(cleanupError)}`);
					}
					json$1(res, 500, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
		}, "dsh-do.ai-install-route()"));
	});
}
//#endregion
//#region lib/types/session-log.js
/**
* Read every event of a session log in log order.
*
* @param session - an agent's session, or anything else; unknown shapes are tolerated.
* @returns the session's events, or an empty array when no log can be read.
*/
function readSessionEvents(session) {
	if (typeof session !== "object" || session === null) return [];
	const carrier = session;
	if (typeof carrier.snapshotEvents === "function") {
		const snapshot = carrier.snapshotEvents();
		if (Array.isArray(snapshot)) return snapshot;
	}
	return Array.isArray(carrier.events) ? carrier.events : [];
}
//#endregion
//#region lib/types/loop.js
/**
* Pure loop domain: durable state shape, identities, and deterministic
* transitions. No runtime dependency beyond `node:crypto` and the side-effect
* free {@link module:dsh-do/session-log} reader; type-only imports keep the
* platform coupling to types.
*
* @module dsh-do/loop
*/
/** Mint a loop identity from its string form. */
function LoopId(value) {
	return value;
}
/**
* Largest delay `setTimeout` accepts, and therefore the ceiling for a loop
* cadence: a longer one could never be scheduled. Also bounds a persisted
* `intervalMs`, so a hand-edited checkpoint cannot request an absurd pace.
*/
const MAX_TIMER_DELAY_MS = 2147483647;
/** Create a fresh, armed, active loop. */
function createLoop(input) {
	const now = input.now ?? Date.now();
	return {
		id: LoopId(`loop-${randomUUID()}`),
		sessionId: input.sessionId,
		objective: input.objective,
		maxRounds: input.maxRounds,
		...input.intervalMs === void 0 ? {} : { intervalMs: input.intervalMs },
		phase: "active",
		armed: true,
		roundsStarted: 0,
		startedAt: now,
		updatedAt: now
	};
}
/**
* Replace the loop's objective in place, keeping its phase, arming, admitted
* rounds and cadence. A round already queued by the driver keeps the text it
* was queued with; every round queued afterwards restates the new objective.
*/
function editLoopObjective(loop, objective, now) {
	if (loop.objective === objective) return loop;
	return touch({
		...loop,
		objective
	}, now);
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
/**
* Arm or disarm the loop without changing its phase. Arming clears any recorded
* pause; disarming without a reason keeps the previous one, so a later
* unexplained disarm cannot erase why the loop first stopped.
*/
function armLoop(loop, armed, reason, now) {
	if (armed) {
		if (loop.armed && loop.pausedReason === void 0) return loop;
		const { pausedReason: _dropped, ...rest } = loop;
		return touch({
			...rest,
			armed: true
		}, now);
	}
	if (!loop.armed && reason === void 0) return loop;
	return touch({
		...loop,
		armed: false,
		...reason === void 0 ? {} : { pausedReason: {
			...reason,
			at: now ?? Date.now()
		} }
	}, now);
}
/** Record why an already-disarmed active loop stopped. No-op once armed. */
function markPaused(loop, reason, now) {
	if (loop.armed || loop.phase !== "active") return loop;
	return touch({
		...loop,
		pausedReason: {
			...reason,
			at: now ?? Date.now()
		}
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
	for (const event of readSessionEvents(agent.session)) {
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
/** Accepted pause causes; a record naming another one is corrupt. */
const PAUSE_CODES = [
	"round-cancelled",
	"round-aborted",
	"max-tokens",
	"agent-error",
	"driver-failed",
	"restart"
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
	if (typeof state.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(state.id) || typeof state.sessionId !== "string" || state.sessionId.length === 0 || typeof state.objective !== "string") return {
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
		if (typeof reason !== "object" || reason === null || Array.isArray(reason) || typeof reason.code !== "string" || typeof reason.message !== "string") return {
			ok: false,
			error: `file ${fileName} has an invalid blockedReason`
		};
	}
	const pausedReason = state.pausedReason;
	if (pausedReason !== void 0) {
		const reason = pausedReason;
		if (typeof reason !== "object" || reason === null || Array.isArray(reason) || !PAUSE_CODES.includes(reason.code) || typeof reason.message !== "string" || typeof reason.at !== "number" || !Number.isFinite(reason.at)) return {
			ok: false,
			error: `file ${fileName} has an invalid pausedReason`
		};
		if (state.armed === true) return {
			ok: false,
			error: `file ${fileName} records a pause while armed`
		};
		if (state.phase !== "active") return {
			ok: false,
			error: `file ${fileName} records a pause on a ${String(state.phase)} phase`
		};
	}
	for (const key of ["completedSummary", "cancelledReason"]) if (state[key] !== void 0 && typeof state[key] !== "string") return {
		ok: false,
		error: `file ${fileName} has an invalid ${key}`
	};
	if (state.phase !== "active" && state.armed === true) return {
		ok: false,
		error: `file ${fileName} has an armed ${String(state.phase)} phase`
	};
	const intervalMs = state.intervalMs;
	if (intervalMs !== void 0 && (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647)) return {
		ok: false,
		error: `file ${fileName} has an invalid intervalMs`
	};
	for (const key of ["startedAt", "updatedAt"]) if (typeof state[key] !== "number" || !Number.isFinite(state[key])) return {
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
			...intervalMs === void 0 ? {} : { intervalMs },
			phase: state.phase,
			armed: state.armed,
			...pausedReason === void 0 ? {} : { pausedReason: {
				code: pausedReason.code,
				message: pausedReason.message,
				at: pausedReason.at
			} },
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
		if (!/^[A-Za-z0-9_-]+$/.test(loopId)) throw new Error("invalid checkpoint loop id");
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
	logger;
	loops = /* @__PURE__ */ new Map();
	store;
	notifier;
	constructor(store, logger) {
		this.logger = logger;
		this.store = store;
	}
	/**
	* Register the sink that wakes the driver whenever a loop becomes armed and
	* active. Passing `undefined` detaches it, so a disposed driver is never
	* called after teardown.
	* @param notifier - the change sink, or `undefined` to detach.
	*/
	setNotifier(notifier) {
		this.notifier = notifier;
	}
	/**
	* Swap the durable store, e.g. after the user changes `persist` or
	* `checkpointDir`. In-memory loops are untouched: a store swap changes where
	* subsequent writes land, not which loops exist. Passing `undefined` disables
	* persistence without dropping live state.
	* @param store - the next store, or `undefined` for memory-only operation.
	*/
	useStore(store) {
		this.store = store;
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
	/** Every live loop, for a status surface that has no session in hand. */
	list() {
		return [...this.loops.values()];
	}
	/**
	* Start the session's loop. A terminal or disarmed loop is **replaced
	* outright**: `loop_start` and `/loop <objective>` both mean "run THIS
	* objective", so a paused loop must not silently keep its old text and
	* budget. An armed loop is never clobbered — inspect, edit, pause, cancel,
	* or let it finish first.
	*
	* Replacement mints a fresh loop id on purpose. Admitted rounds are counted
	* from session events tagged with that id, so a new id is what actually
	* resets the budget; it also invalidates any in-flight reservation still
	* carrying the old id, so a queued round from the previous loop can never be
	* admitted into the new one.
	*/
	start(sessionId, objective, maxRounds, intervalMs) {
		const existing = this.loops.get(sessionId);
		if (existing !== void 0 && existing.phase === "active" && existing.armed) throw new HarnessError("a loop is already active for this session; inspect it with loop_status, change its objective with /loop edit, stop it with loop_cancel, or let it finish", LOOP_ERROR.ALREADY_ACTIVE);
		const loop = createLoop({
			sessionId,
			objective,
			maxRounds,
			...intervalMs === void 0 ? {} : { intervalMs }
		});
		return this.commit(loop);
	}
	/**
	* Replace the active loop's objective in place, keeping its phase, arming,
	* admitted rounds and cadence. This is the mid-flight correction path: use it
	* when the budget already spent should still count, whereas `start` replaces
	* the loop and resets the budget.
	*/
	editObjective(sessionId, objective) {
		return this.commit(editLoopObjective(this.requireActive(sessionId, "loop edit"), objective));
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
	/**
	* Arm or disarm the loop without changing its phase. Disarming records why,
	* so an active-but-stopped loop can explain itself.
	* @param reason - cause of the disarm; omitted only when re-arming.
	*/
	arm(sessionId, armed, reason) {
		const loop = this.loops.get(sessionId);
		if (loop === void 0) return void 0;
		return this.commit(armLoop(loop, armed, reason));
	}
	/** Bump the highest admitted round and persist. */
	recordAdmitted(sessionId, loopId, round) {
		const loop = this.loops.get(sessionId);
		if (loop === void 0 || loop.id !== loopId) return;
		this.commit(markRoundAdmitted(loop, round));
	}
	/** Record why an already-disarmed active loop stopped. */
	recordPaused(sessionId, reason) {
		const loop = this.loops.get(sessionId);
		if (loop === void 0 || loop.phase !== "active" || loop.armed) return void 0;
		return this.commit(markPaused(loop, reason));
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
		if (loop.phase === "active" && loop.armed) try {
			this.notifier?.(loop);
		} catch (error) {
			this.logger.warn(`dsh-do: loop change notification failed for loop ${loop.id}: ${String(error)}`);
		}
		return loop;
	}
};
//#endregion
//#region lib/types/command.js
/** Cadence used when `/loop` names no interval, matching Claude Code's default. */
const DEFAULT_INTERVAL_MS = 6e5;
/**
* Claude Code derives its minimum cadence from cron's one-minute granularity
* and rounds sub-minute intervals up. A driver delay has no such limit, but the
* same floor keeps one `/loop` grammar meaning the same thing in both tools.
*/
const MIN_INTERVAL_MS = 6e4;
/** Longest accepted cadence, keeping the delay inside a 32-bit timer range. */
const MAX_INTERVAL_MS = MAX_TIMER_DELAY_MS;
/** Usage text shown for an empty or unparsable invocation. */
const LOOP_USAGE = `Usage: /loop [<interval>] [<objective>]

Run an objective as a dsh-DO autonomous loop, and keep it running.

Intervals: Ns, Nm, Nh, Nd (e.g. 30s, 5m, 2h, 1d); minimum 1 minute.
Without an interval the next round starts as soon as the model is idle.
A trailing "every <N><unit>" clause sets the interval too.

Control verbs:
  /loop                     show the current loop
  /loop pause               stop automatic continuation
  /loop resume              resume automatic continuation
  /loop edit <objective>    replace the objective, keeping the budget
  /loop done [summary]      mark the loop complete
  /loop cancel [reason]     cancel the loop
  /loop clear               cancel the loop (alias of cancel)`;
const UNIT_MS = {
	s: 1e3,
	m: 6e4,
	h: 36e5,
	d: 864e5
};
/** Whole-number unit words accepted by the trailing `every` clause. */
const UNIT_WORDS = {
	second: "s",
	seconds: "s",
	minute: "m",
	minutes: "m",
	hour: "h",
	hours: "h",
	day: "d",
	days: "d"
};
/** Convert a parsed `<N><unit>` pair to a bounded millisecond cadence. */
function toIntervalMs(count, unit) {
	const scale = UNIT_MS[unit];
	if (scale === void 0 || !Number.isSafeInteger(count) || count < 1) return void 0;
	const raw = count * scale;
	if (!Number.isSafeInteger(raw)) return void 0;
	return Math.min(Math.max(raw, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}
/**
* Extract a leading `N<unit>` interval token. Claude Code gives a leading token
* priority over a trailing `every` clause, and only treats the first
* whitespace-delimited token as an interval when it matches exactly.
*/
function leadingInterval(input) {
	const match = /^(\d+)\s*([smhd])(?=\s|$)/iu.exec(input);
	if (match === null) return {
		intervalMs: void 0,
		rest: input
	};
	const intervalMs = toIntervalMs(Number(match[1]), match[2].toLowerCase());
	if (intervalMs === void 0) return {
		intervalMs: void 0,
		rest: input
	};
	return {
		intervalMs,
		rest: input.slice(match[0].length).trim()
	};
}
/**
* Extract a trailing `every <N><unit>` or `every <N> <unit-word>` clause. A
* bare "every" followed by anything else is part of the objective, so
* "check every PR" stays a valid objective.
*/
function trailingInterval(input) {
	const match = /(?:^|\s)every\s+(\d+)\s*([a-z]+)\s*$/iu.exec(input);
	if (match === null) return {
		intervalMs: void 0,
		rest: input
	};
	const word = match[2].toLowerCase();
	const unit = word.length === 1 ? word : UNIT_WORDS[word];
	if (unit === void 0) return {
		intervalMs: void 0,
		rest: input
	};
	const intervalMs = toIntervalMs(Number(match[1]), unit);
	if (intervalMs === void 0) return {
		intervalMs: void 0,
		rest: input
	};
	return {
		intervalMs,
		rest: input.slice(0, match.index).trim()
	};
}
/**
* Parse one `/loop` invocation. Control verbs win over the objective grammar,
* so an objective that is exactly a verb word is written as
* `/loop edit <word>` instead of being read as that verb.
*
* @param rawInput - the text after the command name, whitespace included.
* @returns the parsed invocation.
*/
function parseLoopCommand(rawInput) {
	const input = rawInput.trim();
	if (input.length === 0) return { kind: "show" };
	const verb = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/u.exec(input);
	if (verb !== null) {
		const rest = (verb[2] ?? "").trim();
		switch (verb[1].toLowerCase()) {
			case "status":
				if (rest.length === 0) return { kind: "show" };
				break;
			case "pause":
				if (rest.length === 0) return { kind: "pause" };
				break;
			case "resume":
				if (rest.length === 0) return { kind: "resume" };
				break;
			case "edit": return rest.length === 0 ? { kind: "invalid-edit" } : {
				kind: "edit",
				objective: rest
			};
			case "done": return rest.length === 0 ? { kind: "done" } : {
				kind: "done",
				summary: rest
			};
			case "cancel": return rest.length === 0 ? { kind: "cancel" } : {
				kind: "cancel",
				reason: rest
			};
			case "clear": if (rest.length === 0) return { kind: "cancel" };
		}
	}
	const leading = leadingInterval(input);
	if (leading.intervalMs !== void 0) return leading.rest.length === 0 ? { kind: "show" } : {
		kind: "start",
		objective: leading.rest,
		intervalMs: leading.intervalMs
	};
	const trailing = trailingInterval(input);
	if (trailing.intervalMs !== void 0 && trailing.rest.length > 0) return {
		kind: "start",
		objective: trailing.rest,
		intervalMs: trailing.intervalMs
	};
	return {
		kind: "start",
		objective: input,
		intervalMs: DEFAULT_INTERVAL_MS
	};
}
/** Human label for one durable loop phase. */
function phaseLabel(loop) {
	switch (loop.phase) {
		case "active": return loop.armed ? "active" : "paused";
		case "completed": return "complete";
		case "blocked": return "blocked";
		case "cancelled": return "cancelled";
	}
}
/** Render a cadence as the interval token `/loop` accepts back. */
function renderInterval(intervalMs) {
	if (intervalMs % UNIT_MS.d === 0) return `${intervalMs / UNIT_MS.d}d`;
	if (intervalMs % UNIT_MS.h === 0) return `${intervalMs / UNIT_MS.h}h`;
	if (intervalMs % UNIT_MS.m === 0) return `${intervalMs / UNIT_MS.m}m`;
	return `${Math.round(intervalMs / 1e3)}s`;
}
/** Commands that are meaningful from one exact live state. */
function commandHint(loop) {
	if (loop.phase !== "active") return "/loop <objective>, /loop clear";
	return loop.armed ? "/loop pause, /loop edit <objective>, /loop done, /loop clear" : "/loop resume, /loop edit <objective>, /loop done, /loop clear";
}
/** Render one loop without exposing compare-and-set internals. */
function renderLoop(title, loop, rounds) {
	const cadence = loop.intervalMs === void 0 ? "on idle" : `every ${renderInterval(loop.intervalMs)}`;
	const blocker = loop.phase === "blocked" && loop.blockedReason !== void 0 ? [`Blocker: ${loop.blockedReason.code}: ${loop.blockedReason.message}`] : [];
	return [
		title,
		`Status: ${phaseLabel(loop)}`,
		...blocker,
		`Objective: ${loop.objective}`,
		`Rounds: ${rounds}/${loop.maxRounds}`,
		`Cadence: ${cadence}`,
		"",
		`Commands: ${commandHint(loop)}`
	].join("\n");
}
/** Closed-union backstop: unreachable while every member is handled above. */
function assertNever(value) {
	return {
		kind: "error",
		text: `unhandled loop command: ${JSON.stringify(value)}`
	};
}
/**
* Execute one parsed `/loop` invocation against the loop domain.
*
* @param controller - the loop registry.
* @param command - the parsed invocation.
* @param sessionId - the calling agent's session.
* @param defaultMaxRounds - live settings reader for a newly started loop's budget.
* @param rounds - effective admitted rounds for the current loop.
* @returns the outcome the dispatching UI renders.
*/
function executeLoopCommand(controller, command, sessionId, defaultMaxRounds, rounds) {
	const current = controller.get(sessionId);
	try {
		switch (command.kind) {
			case "show": return current === void 0 ? {
				kind: "success",
				text: `No loop is currently set.\n${LOOP_USAGE}`
			} : {
				kind: "success",
				text: renderLoop("Loop", current, rounds(current))
			};
			case "invalid-edit": return {
				kind: "error",
				text: `Loop editing requires a replacement objective.\n${LOOP_USAGE}`
			};
			case "start": {
				if (current !== void 0 && current.phase === "active" && current.armed) return {
					kind: "error",
					text: "A loop is already active. Use /loop edit <objective> to change it, /loop pause to stop it, or /loop clear before starting a new one."
				};
				if (current !== void 0 && current.phase === "active") {
					const replaced = controller.start(sessionId, command.objective, defaultMaxRounds(), command.intervalMs);
					return {
						kind: "success",
						text: `${renderLoop("Loop restarted", replaced, rounds(replaced))}\n\nThe paused objective and its spent rounds were replaced. Use /loop edit <objective> to keep the budget instead.`
					};
				}
				const started = controller.start(sessionId, command.objective, defaultMaxRounds(), command.intervalMs);
				return {
					kind: "success",
					text: renderLoop("Loop started", started, rounds(started))
				};
			}
			case "edit": {
				if (current === void 0) return {
					kind: "error",
					text: `No loop is currently set; /loop edit requires one.\n${LOOP_USAGE}`
				};
				if (current.phase !== "active") {
					const replaced = controller.start(sessionId, command.objective, defaultMaxRounds());
					return {
						kind: "success",
						text: renderLoop("Loop started", replaced, rounds(replaced))
					};
				}
				const edited = controller.editObjective(sessionId, command.objective);
				return {
					kind: "success",
					text: renderLoop("Loop updated", edited, rounds(edited))
				};
			}
			case "pause":
				if (current === void 0) return {
					kind: "error",
					text: `No loop is currently set; /loop pause requires one.\n${LOOP_USAGE}`
				};
				return {
					kind: "success",
					text: renderLoop("Loop paused", controller.arm(sessionId, false) ?? current, rounds(current))
				};
			case "resume":
				if (current === void 0) return {
					kind: "error",
					text: `No loop is currently set; /loop resume requires one.\n${LOOP_USAGE}`
				};
				return {
					kind: "success",
					text: renderLoop("Loop resumed", controller.arm(sessionId, true) ?? current, rounds(current))
				};
			case "done":
				if (current === void 0 || current.phase !== "active") return {
					kind: "error",
					text: `/loop done requires an active loop.\n${LOOP_USAGE}`
				};
				return {
					kind: "success",
					text: renderLoop("Loop complete", controller.complete(sessionId, command.summary), rounds(current))
				};
			case "cancel":
				if (current === void 0 || current.phase !== "active") return {
					kind: "success",
					text: "No loop to clear."
				};
				return {
					kind: "success",
					text: renderLoop("Loop cancelled", controller.cancel(sessionId, command.reason), rounds(current))
				};
			default: return assertNever(command);
		}
	} catch (error) {
		const code = error instanceof Error ? error.code : void 0;
		if (code === LOOP_ERROR.NOT_ACTIVE || code === LOOP_ERROR.ALREADY_ACTIVE) return {
			kind: "error",
			text: "The loop changed while this command ran; run /loop to see its current state."
		};
		throw error;
	}
}
/**
* Register `/loop` for every composed command adapter.
*
* The registration rides a command-gated child context, so a profile without a
* command registry never registers it instead of failing the whole plugin.
*
* @param ctx - the plugin context.
* @param controller - the loop registry the command drives.
* @param defaultMaxRounds - live settings reader for a new loop's budget.
*/
function installLoopCommand(ctx, controller, defaultMaxRounds) {
	ctx.inject(["commands"], (child) => {
		child.commands.register({
			name: "loop",
			description: "start, pace, pause, retarget, or end a dsh-DO autonomous loop",
			input: { hint: "[<interval>] [<objective>|pause|resume|edit <objective>|done|cancel]" },
			handler: (invocation) => executeLoopCommand(controller, parseLoopCommand(invocation.rawInput), invocation.agent.session.id, defaultMaxRounds, (loop) => effectiveRounds(invocation.agent, loop))
		});
	});
}
//#endregion
//#region lib/types/loop-status.js
/**
* Schema for the projection cell. A schemastery-shaped `parse` is all the
* registry requires; it validates on every snapshot read.
*/
const loopProjectionSchema = { parse(value) {
	if (value === null || value === void 0) return null;
	const state = value;
	if (typeof state.loopId !== "string" && state.loopId !== null) throw new TypeError("loop projection: invalid loopId");
	if (!Number.isSafeInteger(state.roundsStarted) || state.roundsStarted < 0) throw new TypeError("loop projection: invalid roundsStarted");
	return state;
} };
/**
* Pure fold of one loop round event into the projection state. Replay-safe by
* construction: it depends only on the events, never on live plugin state.
*/
function applyLoopProjection(state, event) {
	if (event.type !== "user/message") return state;
	const source = event.data?.source;
	if (source?.kind !== "loop" || typeof source.loopId !== "string" || !Number.isSafeInteger(source.round)) return state;
	const round = source.round;
	if (state !== null && state.loopId !== null && state.loopId !== source.loopId) return {
		loopId: source.loopId,
		roundsStarted: round,
		lastRoundAt: null
	};
	if (state !== null && round <= state.roundsStarted) return state;
	return {
		loopId: source.loopId,
		roundsStarted: round,
		lastRoundAt: state?.lastRoundAt ?? null
	};
}
/**
* Build the flat, JSON-only view of one loop. Reads leaf fields and constructs
* an owned object: no live Cordis/DSH object crosses this boundary.
* @param agent - live agent owning the loop, used for durable round accounting.
*/
function loopStatusView(loop, agent) {
	const roundsStarted = effectiveRounds(agent, loop);
	return {
		phase: loop.phase,
		armed: loop.armed,
		loopId: loop.id,
		roundsStarted,
		maxRounds: loop.maxRounds,
		objective: loop.objective,
		...loop.intervalMs === void 0 ? {} : { intervalMs: loop.intervalMs },
		...loop.pausedReason === void 0 || loop.phase !== "active" || loop.armed ? {} : { pausedReason: {
			code: loop.pausedReason.code,
			message: loop.pausedReason.message,
			at: loop.pausedReason.at
		} },
		...loop.completedSummary === void 0 ? {} : { completedSummary: loop.completedSummary },
		...loop.blockedReason === void 0 ? {} : { blockedReason: {
			code: loop.blockedReason.code,
			message: loop.blockedReason.message
		} },
		...loop.cancelledReason === void 0 ? {} : { cancelledReason: loop.cancelledReason }
	};
}
/**
* Install the loop status surface: a `loops` service and a `loop` session
* projection. Both are effects of the calling fiber, so unloading the plugin
* removes the service, the projection key, and every snapshot contribution.
* @param controller - the loop registry this surface reports on.
*/
function installLoopStatus(ctx, controller) {
	ctx.provide("loops");
	ctx.set("loops", {
		get(agent) {
			const loop = controller.get(agent.session.id);
			return loop === void 0 ? void 0 : loopStatusView(loop, agent);
		},
		list() {
			const views = /* @__PURE__ */ new Map();
			for (const loop of controller.list()) views.set(loop.sessionId, loopStatusView(loop));
			return views;
		}
	});
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		const registry = projectionCtx.sessionProjections;
		if (registry === void 0) return;
		registry.register({
			key: "loop",
			schema: loopProjectionSchema,
			init: () => null,
			apply: applyLoopProjection,
			view: (state) => state,
			stateVersion: 1
		});
	});
}
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
* Render the notice written into the conversation when the driver stops
* continuing an active loop.
*
* A stopped loop used to be indistinguishable from a working one: the round
* simply stopped arriving and nothing said why. This notice closes that gap by
* reporting the cause where the rounds were visible, and restating how to
* resume, so the human does not have to inspect a checkpoint file to find out.
* @param reason - the recorded stop cause.
* @param loopId - the stopped loop's identity, echoed for `/loop` follow-ups.
* @returns a fresh one-block notice for `Agent.followup()`.
*/
function renderLoopPauseNotice(reason, loopId) {
	const identity = loopId === void 0 ? "" : `\nLoop: ${loopId}`;
	return [{
		type: "text",
		text: `<loop_paused>
The autonomous loop has stopped continuing and will not queue another round on its own.
Cause (${reason.code}): ${reason.message}${identity}

This is a pause, not an ending: the objective and the rounds already spent are preserved. The human can resume it with \`/loop resume\`, or replace it with \`/loop <new objective>\`; the model can resume it with loop_start. Rounds already completed remain in this session. Do not silently retry the stopped round.
</loop_paused>`
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
//#region lib/types/auto-continue.js
/**
* Decide whether to continue after an output-limit cut-off.
*
* @param policy - the live auto-continue settings.
* @param streak - continuations already queued since the last turn that did
*   NOT end at the output limit.
* @param looping - whether an armed dsh-DO loop owns this session.
* @returns the decision.
*/
function decideAutoContinue(policy, streak, looping) {
	if (!policy.enabled) return {
		kind: "stop",
		reason: "disabled"
	};
	if (policy.onlyWhileLooping && !looping) return {
		kind: "stop",
		reason: "not-looping"
	};
	if (streak >= policy.maxContinuations) return {
		kind: "stop",
		reason: "exhausted"
	};
	return {
		kind: "continue",
		attempt: streak + 1
	};
}
/**
* Model-visible text of a continuation turn.
*
* It asks for a seamless resume, not a restart: a model that re-answers from the
* top would hit the same limit again and never finish.
*
* @param attempt - this continuation's number, from 1.
* @param max - the configured cap.
* @returns a fresh one-block prompt for `Agent.followup()`.
*/
function renderAutoContinuePrompt(attempt, max) {
	return [{
		type: "text",
		text: `<output_limit_continue>
Your previous response was cut off by the model output-token limit (automatic continuation ${attempt}/${max}).
Continue exactly where it stopped. Do not restart, repeat, or summarise what you already wrote; if you were in the middle of a code block or a tool call, resume it. Keep the remaining output compact so it fits.
</output_limit_continue>`
	}];
}
/** Pause-notice message for a `max-tokens` stop that was not continued. */
function describeAutoContinueStop(reason, max) {
	switch (reason) {
		case "exhausted": return `the model hit its output limit ${max} times in a row; automatic continuation gave up so a runaway response cannot loop forever`;
		case "not-looping": return "the last round hit the model output limit";
		case "disabled": return "the last round hit the model output limit and automatic continuation is turned off";
	}
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
/** Source stamped on the driver's own notices, matching the detector's. */
const PLUGIN_SOURCE$1 = {
	kind: "plugin",
	plugin: "dsh-do"
};
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
* @returns the external wakeup handle the controller's change sink drives.
*/
function installLoopDriver(ctx, controller, restore, options = {}) {
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
				stopping: false,
				lastRoundAt: void 0,
				paceTimer: void 0,
				continueStreak: 0
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
		return ctx.fiber.state === 2 && !state.stopping && ctx.agents.get(state.agent.id) === state.agent && state.agent.status === "idle" && state.agent.inbox.nextTurn.length === 0 && !state.competingQueued;
	}
	/** Cancel a pending interval wakeup. Safe to call when none is armed. */
	function clearPace(state) {
		if (state.paceTimer === void 0) return;
		clearTimeout(state.paceTimer);
		state.paceTimer = void 0;
	}
	/**
	* Remove automatic authority while preserving the durable phase, recording
	* why so an active-but-stopped loop can explain itself to a human instead of
	* simply going quiet.
	*
	* The recorded cause alone would still be silent — a checkpoint field nobody
	* reads mid-session. Announcing the stop as a conversation notice is what
	* makes it visible in the same place the round ran, in every client.
	*/
	function disarm(state, reason) {
		clearPace(state);
		const loop = loopOf(state);
		if (loop === void 0 || !loop.armed) return;
		if (controller.arm(state.agent.session.id, false, reason) === void 0) return;
		try {
			state.agent.followup(createUserMessage({
				content: renderLoopPauseNotice(reason),
				source: {
					...PLUGIN_SOURCE$1,
					form: "notice",
					summary: boundContextSummary(`dsh-do loop paused: ${reason.code}`)
				}
			}));
		} catch (error) {
			ctx.logger.warn(`dsh-do: could not announce the pause for agent "${state.agent.id}": ${renderThrown(error)}`);
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
		return ctx.fiber.state === 2 && !state.stopping && attempt !== void 0 && attempt.phase === "claimed" && !state.competingQueued && !attempt.stale && sameQueued(content, source, attempt) && loop !== void 0 && loop.id === source.loopId && loop.phase === "active" && loop.armed && source.round === effectiveRounds(state.agent, loop) + 1;
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
		if (loop.intervalMs !== void 0 && state.lastRoundAt !== void 0) {
			const wait = state.lastRoundAt + loop.intervalMs - Date.now();
			if (wait > 0) {
				clearPace(state);
				state.paceTimer = setTimeout(() => {
					state.paceTimer = void 0;
					requestDrive(state);
				}, Math.min(wait, MAX_TIMER_DELAY_MS));
				return;
			}
		}
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
			state.lastRoundAt = Date.now();
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
						disarm(state, {
							code: "driver-failed",
							message: `the loop driver failed: ${renderThrown(error)}`
						});
					}
				}
			});
		} catch (error) {
			ctx.logger.warn(`dsh-do: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state, {
				code: "driver-failed",
				message: `the loop driver could not start: ${renderThrown(error)}`
			});
			return;
		}
		state.run = run;
		const retire = () => {
			state.run = void 0;
			if (state.requested && !state.stopping) requestDrive(state);
		};
		run.then(retire, (error) => {
			ctx.logger.warn(`dsh-do: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state, {
				code: "driver-failed",
				message: `the loop driver task was rejected: ${renderThrown(error)}`
			});
			retire();
		});
	}
	ctx.effect(async function* () {
		if (restore !== void 0) await restore;
		ctx.on("agent/error", ({ agent }) => {
			disarm(stateFor(agent), {
				code: "agent-error",
				message: "the agent reported an error while the loop was running"
			});
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
			requestDrive(state);
		});
		ctx.on("agent/status", ({ agent, status }) => {
			const state = stateFor(agent);
			if (status === "idle") {
				state.competingQueued = false;
				const attempt = state.attempt;
				const loop = loopOf(state);
				if ((attempt?.phase === "queued" || attempt?.phase === "claimed" || attempt?.cancelled) && loop?.phase === "active" && loop.armed) {
					const cancelledRound = attempt.round;
					state.attempt = void 0;
					disarm(state, {
						code: "round-cancelled",
						message: `round ${cancelledRound} was cancelled before it could run, so the loop stopped instead of retrying it`
					});
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
				if (source?.kind === "user") state.continueStreak = 0;
				if (isLoopSource(source)) {
					if (state.attempt !== void 0 && state.attempt.messageId === event.data.id) state.attempt.phase = "admitted";
					controller.recordAdmitted(session.id, source.loopId, source.round);
				}
				return;
			}
			if (event.type !== "turn/end") return;
			const reason = event.data.reason;
			if (reason.kind === "max-tokens") {
				const loop = loopOf(state);
				const looping = loop !== void 0 && loop.phase === "active" && loop.armed;
				const policy = options.autoContinue?.();
				if (policy !== void 0) {
					const decision = decideAutoContinue(policy, state.continueStreak, looping);
					if (decision.kind === "continue") try {
						state.agent.followup(createUserMessage({
							content: renderAutoContinuePrompt(decision.attempt, policy.maxContinuations),
							source: {
								...PLUGIN_SOURCE$1,
								form: "notice",
								summary: boundContextSummary(`dsh-do output limit: continue ${decision.attempt}/${policy.maxContinuations}`)
							}
						}));
						state.continueStreak = decision.attempt;
						return;
					} catch (error) {
						ctx.logger.warn(`dsh-do: could not queue an output-limit continuation for agent "${agent.id}": ${renderThrown(error)}`);
					}
					else if (decision.reason === "exhausted") {
						state.continueStreak = 0;
						disarm(state, {
							code: "max-tokens",
							message: describeAutoContinueStop("exhausted", policy.maxContinuations)
						});
						return;
					}
				}
				state.continueStreak = 0;
				disarm(state, {
					code: "max-tokens",
					message: "the last round hit the model output limit, so the loop stopped instead of retrying it"
				});
				return;
			}
			state.continueStreak = 0;
			if (reason.kind !== "aborted") return;
			if (state.attempt?.phase === "claimed" || state.attempt?.phase === "admitted") state.attempt.cancelled = true;
			else disarm(state, {
				code: "round-aborted",
				message: "the running turn was aborted, so the loop stopped instead of retrying it"
			});
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
				disarm(state, {
					code: "driver-failed",
					message: `the round reservation could not be verified: ${renderThrown(error)}`
				});
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
				disarm(state, {
					code: "driver-failed",
					message: `the round reservation could not be re-verified: ${renderThrown(error)}`
				});
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
				disarm(state, {
					code: "restart",
					message: "the harness shut down while this loop was armed"
				});
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
	/**
	* Resolve one session's live agent and re-run the driven pass. Called by the
	* controller's change sink, because starting a loop emits no agent lifecycle
	* event: `/loop <objective>` typed into an idle session would otherwise stay
	* armed with zero rounds started until something else made the agent idle.
	*/
	function nudge(sessionId) {
		const agent = ctx.agents.get(SessionId(sessionId));
		if (agent === void 0) return;
		requestDrive(stateFor(agent));
	}
	return { nudge };
}
//#endregion
//#region lib/types/loop-detect.js
/** The source stamped on every message this module injects. */
const PLUGIN_SOURCE = {
	kind: "plugin",
	plugin: "dsh-do"
};
/** Longest quoted argument preview in a model-visible notice. */
const ARGUMENTS_PREVIEW_CHARS = 500;
/**
* Deep key-sort of a parsed-JSON value so two argument objects that differ only
* in property order canonicalize identically. Arguments reach this module as
* the loop's parsed output, so JSON's value domain is the whole input domain.
*/
function sortJsonValue(value) {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (value !== null && typeof value === "object") {
		const record = value;
		const sorted = {};
		for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
		return sorted;
	}
	return value;
}
/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalizeArguments(value) {
	const encoded = JSON.stringify(sortJsonValue(value));
	return encoded === void 0 ? "null" : encoded;
}
/** Advance one agent's run for a settled call. */
function advanceRepeatChain(previous, name, canonical) {
	const key = JSON.stringify([name, canonical]);
	return {
		key,
		count: previous !== void 0 && previous.key === key ? previous.count + 1 : 1
	};
}
/**
* Decide what one settled call means for the agent's session.
*
* @param chain - the run after {@link advanceRepeatChain}.
* @param policy - the live detection settings.
* @param driverArmed - whether an autonomous driver owns this session's continuation.
* @param interventions - interruptions already performed for this session.
* @returns the verdict.
*/
function decideLoopVerdict(chain, policy, driverArmed, interventions) {
	if (!policy.enabled || chain.count < policy.repeatThreshold) return { kind: "continue" };
	const name = JSON.parse(chain.key)[0];
	if (driverArmed) return {
		kind: "nudge",
		count: chain.count,
		name
	};
	if (interventions >= policy.maxInterventions) return {
		kind: "nudge",
		count: chain.count,
		name
	};
	return {
		kind: "intervene",
		count: chain.count,
		name
	};
}
/** Head-truncate canonical arguments for quoting in a model-visible notice. */
function previewArguments(canonical, cap = ARGUMENTS_PREVIEW_CHARS) {
	return canonical.length <= cap ? canonical : `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}
/** The corrective text delivered when the detector cannot interrupt. */
function renderLoopNotice(name, count, canonical) {
	return [{
		type: "text",
		text: `Repeated tool call detected:
- tool: ${name}
- consecutive_calls: ${count}
- arguments: ${previewArguments(canonical)}
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.`
	}];
}
/** The instruction that re-sends the interrupted request over compacted history. */
function renderRecoveryPrompt(name, count, compacted) {
	return [{
		type: "text",
		text: `<loop_interrupted>
${compacted ? "This session was interrupted because you repeated one tool call without making progress, and its history has just been compacted." : "This session was interrupted because you repeated one tool call without making progress."}

- tool: ${name}
- consecutive_calls: ${count}

${compacted ? "Continue the task from the compacted state." : "Continue the task."} The repeated call is not a valid next action: re-read the current workspace and the latest results, then either take a different action, use different arguments, or finish and report the outcome. If the task genuinely cannot proceed, say what blocks it instead of retrying the same call.
</loop_interrupted>`
	}];
}
/**
* Install model-loop detection and recovery.
*
* The listener rides a compaction-gated child context: the recovery this module
* promises is stop-then-compact-then-resend, so a deployment without a
* compaction service keeps its existing behavior instead of getting a partial
* one.
*
* @param ctx - the plugin context.
* @param options - live policy and the driver-ownership probe.
*/
function installLoopDetection(ctx, options) {
	ctx.inject(["compaction"], (child) => {
		const chains = /* @__PURE__ */ new Map();
		const budgets = /* @__PURE__ */ new Map();
		/** Cancellation owned by this installation, aborted on teardown. */
		const controller = new AbortController();
		function budgetFor(agent) {
			let budget = budgets.get(agent);
			if (budget === void 0) {
				budget = {
					interventions: 0,
					inFlight: false
				};
				budgets.set(agent, budget);
			}
			return budget;
		}
		/**
		* Interrupt one looping agent, compact its history, and re-send the
		* request. Runs detached from the tool pipeline so the settling call
		* returns normally first.
		*/
		async function recover(agent, name, count, budget) {
			const policy = options.policy();
			try {
				await Promise.resolve();
				agent.cancel({
					kind: "hook",
					reason: "dsh-do: repeated tool call"
				});
				await agent.whenIdle();
				if (controller.signal.aborted) return;
				let compacted = false;
				if (policy.compact) try {
					compacted = await child.compaction.compactNow(agent, controller.signal) !== null;
				} catch (error) {
					child.logger.warn(`dsh-do: loop recovery could not compact: ${String(error)}`);
				}
				if (controller.signal.aborted) return;
				budget.interventions += 1;
				agent.followup(createUserMessage({
					content: renderRecoveryPrompt(name, count, compacted),
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: boundContextSummary(`dsh-do loop recovery: ${name} × ${count}`)
					}
				}));
			} catch (error) {
				child.logger.warn(`dsh-do: loop recovery failed: ${String(error)}`);
			} finally {
				budget.inFlight = false;
			}
		}
		child.effect(() => child.on("tools/post-execute", async (exec, _result, next) => {
			const downstream = await next();
			const agent = exec.agent;
			if (agent === void 0) return downstream;
			const chain = advanceRepeatChain(chains.get(agent), exec.name, canonicalizeArguments(exec.arguments));
			chains.set(agent, chain);
			const budget = budgetFor(agent);
			const verdict = decideLoopVerdict(chain, options.policy(), options.driverArmed(agent), budget.interventions);
			if (verdict.kind === "continue") return downstream;
			const canonical = JSON.parse(chain.key)[1];
			if (verdict.kind === "intervene" && !budget.inFlight) {
				budget.inFlight = true;
				recover(agent, verdict.name, verdict.count, budget);
			}
			const notice = createUserMessage({
				content: renderLoopNotice(verdict.name, verdict.count, canonical),
				source: {
					...PLUGIN_SOURCE,
					form: "notice",
					summary: boundContextSummary(`dsh-do repeated call: ${verdict.name} × ${verdict.count}`)
				}
			});
			return {
				...downstream,
				additionalContexts: [notice, ...downstream.additionalContexts ?? []]
			};
		}), "dsh-do.loop-detection()");
		child.effect(() => child.on("agent/pre-step", ({ agent, messages }, next) => {
			if (messages.some((message) => message.source.kind === "user")) {
				chains.delete(agent);
				budgets.delete(agent);
			}
			return next();
		}), "dsh-do.loop-detection-reset()");
		child.effect(() => () => {
			controller.abort();
			chains.clear();
			budgets.clear();
		}, "dsh-do.loop-detection-teardown()");
	});
}
/**
* Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
* per-namespace sections; plugins register a namespace schema and read the
* resolved value, which layers schema defaults, the registrant's composition
* `base`, and the user document section, in that order.
* @module @deepseek-ai/dsh-settings
*/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link SettingsNamespace}.
* @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
* @returns the branded namespace.
*/
function settingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}
/**
* Deep equality over JSON-compatible data (objects, arrays, primitives) — the
* Service Definition's single change-detection predicate, exported so the invariant
* companion checks exactly the implementation's relation.
* @param a - one JSON-compatible value.
* @param b - the other JSON-compatible value.
* @returns whether the two values are structurally equal.
*/
function deepEqualJson(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqualJson(entry, b[index]));
	}
	const left = a;
	const right = b;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && deepEqualJson(left[key], right[key]));
}
Service.init;
/**
* Value mirror of the `FiberState` members {@link isUnloading} compares
* against: a const enum has no runtime object to import, and the value is
* needed at runtime (same rationale as the CLI boot driver's mirror).
*/
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;
/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isUnloading(ctx) {
	const state = ctx.fiber.state;
	return state === FIBER_UNLOADING || state === FIBER_DISPOSED;
}
/**
* Install the canonical optional-settings consumer wiring: while a settings
* service exists, register `ns` with the consumer's composition entry as the
* `base` layer and point the source thunk at the resolved scope; when the
* service goes away (disposal, provider reload), fall back to the entry so
* the consumer keeps working exactly as composed. The registration rides the
* scoped fiber, so no settings service ever mounted means none of this runs.
* @param ctx - consumer plugin context owning the wiring.
* @param ns - the consumer-owned settings namespace.
* @param schema - schema resolving the namespace (typically the plugin Config).
* @param entry - the consumer's composition entry config, used as `base`.
* @param hooks - source sink and change notification.
*/
function installSettingsSection(ctx, ns, schema, entry, hooks) {
	ctx.inject(["settings"], (sctx) => {
		const scope = sctx.settings.register(ns, schema, {
			base: entry,
			...hooks.validate === void 0 ? {} : { validate: hooks.validate }
		});
		hooks.setSource(() => scope.get());
		sctx.effect(() => () => {
			if (isUnloading(ctx)) return;
			hooks.setSource(() => entry);
			hooks.onChange();
		});
		hooks.onChange();
		scope.watch(() => {
			if (isUnloading(ctx)) return;
			hooks.onChange();
		});
	});
}
//#endregion
//#region lib/types/settings.js
/** Namespace of dsh-DO's user-owned settings. */
const DSH_DO_NS = settingsNamespace("dsh-do");
/**
* The platform's marker for a live config reference.
*
* `schemastery`'s `.volatile()` marks a field as editable without remounting the
* plugin, and the field's resolved value is then a frozen reference carrying a
* `get()` instead of the value itself. The marker is a registered global symbol,
* so it also matches references produced by another copy of the shared runtime.
*/
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
/** Whether a resolved config node is a live reference rather than a plain value. */
function isVolatileValue(value) {
	return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}
/**
* Whether a served settings section carries dsh-DO's own configuration.
*
* DSH 0.1.x files it under the registered namespace `dsh-do`, but 0.2.x keys
* every section by its profile entry id instead — and that id belongs to the
* deployment, not to this plugin, so the section is recognised by the fields it
* carries rather than by the name it is filed under.
*
* @param ns - the namespace the section was served under.
* @param value - the section's resolved value.
* @returns whether this is dsh-DO's loop configuration.
*/
function isDoSection(ns, value) {
	if (ns === DSH_DO_NS) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value;
	return "defaultMaxRounds" in record && "loopDetection" in record && "autoContinue" in record;
}
/**
* Copy a resolved config, replacing every live reference with the value it holds
* right now.
*
* Callers must read through this on every access and never cache the result:
* that is what makes a committed settings change take effect without a restart,
* because the reference is updated in place while the surrounding object stays.
*
* @param value - a resolved config node.
* @returns the same shape with every live reference resolved.
*/
function plainSettings(value) {
	if (isVolatileValue(value)) return plainSettings(value.get());
	if (Array.isArray(value)) return value.map((child) => plainSettings(child));
	if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainSettings(child)]));
	return value;
}
/** Failure codes that trigger a model switch unless the user overrides them. */
const DEFAULT_FALLBACK_CODES = [
	"RATE_LIMIT",
	"QUOTA",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT",
	"EMPTY_RESPONSE"
];
/**
* Mark a config field as editable without remounting the plugin.
*
* `.volatile()` arrived in a later schemastery than some deployments resolve —
* 3.18.1 has no such method at all — so calling it unconditionally would throw
* while the plugin loads. Applying it only when present keeps the plugin loading
* everywhere; where the marker is missing nothing is lost, because reads go
* through {@link plainSettings} either way and 0.1.x does not filter on it.
*
* @param schema - the field or object schema.
* @returns the same schema, marked volatile when the runtime supports it.
*/
function volatile(schema) {
	if (typeof schema.volatile !== "function") return schema;
	return schema.volatile();
}
/**
* Settings schema. This is also the plugin's composition `Config`: the entry in
* `cordis.patch.yml` is the `base` layer of the same namespace.
*
* The object itself is marked volatile — every field is read live through
* {@link plainSettings}, so all of them may be edited without a remount. That
* marking is also what makes the section appear at all: a settings service that
* projects only volatile fields (DSH 0.2.x) hides an entry that declares none.
*/
const Config = volatile(z.object({
	defaultMaxRounds: z.number().step(1).min(1).default(20),
	checkpointDir: z.string().default(""),
	persist: z.boolean().default(true),
	loopDetection: z.object({
		enabled: z.boolean().default(true),
		repeatThreshold: z.number().step(1).min(2).default(4),
		compact: z.boolean().default(true),
		maxInterventions: z.number().step(1).min(1).default(2)
	}),
	autoContinue: z.object({
		enabled: z.boolean().default(true),
		maxContinuations: z.number().step(1).min(1).default(3),
		onlyWhileLooping: z.boolean().default(true)
	}),
	modelFallback: z.object({
		enabled: z.boolean().default(false),
		candidates: z.array(z.string()).default([]),
		triggerCodes: z.array(z.string()).default([...DEFAULT_FALLBACK_CODES])
	})
}));
/**
* Register the `dsh-do` settings namespace and keep a live reader for it.
*
* `onApply` runs once for the first resolved value and again after every
* committed change, including the detach that reverts to the composition entry.
* Structurally equal resolutions are not re-applied, so a re-read of an
* unchanged document cannot restart the store.
*
* @param ctx - the plugin context.
* @param entry - the composition entry config, used as the namespace `base`.
* @param onApply - applied to each new resolved value.
* @returns the reader the rest of the plugin consults.
*/
function installDoSettings(ctx, entry, onApply) {
	let source = () => entry;
	const read = () => plainSettings(source());
	let last = read();
	ctx.inject(["settings"], (sctx) => {
		if (typeof sctx.settings?.register !== "function") return;
		installSettingsSection(ctx, DSH_DO_NS, Config, plainSettings(entry), {
			setSource(current) {
				source = current;
			},
			onChange() {
				const next = read();
				if (deepEqualJson(next, last)) return;
				last = next;
				onApply(next);
			}
		});
	});
	return { read };
}
//#endregion
//#region lib/types/settings-route.js
/** Route the browser half reads and writes settings through. */
const SETTINGS_PATH = "/dsh-do/settings";
/** Namespaces the dsh-DO page reads. */
const READ_NAMESPACES = [
	"dsh-do",
	"agent-default-model",
	"llm-pi-ai",
	"llm-deepseek"
];
/** Write a JSON response with a stable cache policy. */
function json(res, status, value) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(JSON.stringify(value));
}
/** Whether a value is a JSON object literal, the only shape a root set accepts. */
function isPlainObjectValue(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
/**
* Validate one browser-supplied request into a settings mutation.
*
* The route is reachable from the page, so nothing about the shape is assumed:
* a namespace is a non-empty string, a path is an array of non-empty strings,
* and a `set` carries a value. A revision is optional; when present it must be
* a non-negative integer, and the Host refuses the write if the document has
* moved past it.
*
* @param body - the parsed request body.
* @returns the validated request, or the reason it was refused.
*/
function parseSettingsWriteRequest(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return {
		ok: false,
		error: "a JSON object is required"
	};
	const record = body;
	const ns = record.ns;
	if (typeof ns !== "string" || ns.trim() === "") return {
		ok: false,
		error: "ns must be a non-empty string"
	};
	const rawOps = record.ops;
	if (!Array.isArray(rawOps) || rawOps.length === 0) return {
		ok: false,
		error: "ops must be a non-empty array"
	};
	const ops = [];
	for (const raw of rawOps) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {
			ok: false,
			error: "each op must be an object"
		};
		const op = raw;
		if (op.op !== "set" && op.op !== "unset") return {
			ok: false,
			error: "op must be \"set\" or \"unset\""
		};
		if (!Array.isArray(op.path)) return {
			ok: false,
			error: "path must be an array"
		};
		const path = [];
		for (const segment of op.path) {
			if (typeof segment !== "string" || segment === "") return {
				ok: false,
				error: "every path segment must be a non-empty string"
			};
			path.push(segment);
		}
		if (op.op === "set" && !("value" in op)) return {
			ok: false,
			error: "a set op requires a value"
		};
		if (op.op === "set" && path.length === 0 && !isPlainObjectValue(op.value)) return {
			ok: false,
			error: "a set op at the namespace root requires a plain object value"
		};
		ops.push(op.op === "set" ? {
			op: "set",
			path,
			value: op.value
		} : {
			op: "unset",
			path
		});
	}
	const expectedRevision = record.expectedRevision;
	if (expectedRevision !== void 0 && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) return {
		ok: false,
		error: "expectedRevision must be a non-negative integer"
	};
	return {
		ok: true,
		request: {
			ns,
			ops,
			...expectedRevision === void 0 ? {} : { expectedRevision }
		}
	};
}
/**
* Read the namespaces the page displays, redacted and narrowed to the fields
* the page can act on. An unregistered namespace is simply absent, so a
* deployment composing one adapter shows one policy instead of an inert form.
*
* @param settings - the settings service.
* @returns the served sections.
*/
function readSettingsView(settings) {
	const wanted = new Set(READ_NAMESPACES);
	const views = [];
	for (const descriptor of settings.describe({ redactSecrets: true })) {
		if (!wanted.has(descriptor.ns) && !isDoSection(descriptor.ns, descriptor.value)) continue;
		views.push({
			ns: descriptor.ns,
			value: descriptor.value,
			...descriptor.user === void 0 ? {} : { user: descriptor.user },
			revision: descriptor.revision
		});
	}
	return views;
}
/**
* Install `GET`/`POST /dsh-do/settings`.
*
* Lazy sibling injection: a deployment without a settings service or a web
* server never registers the route, and the browser page reports that saving is
* unavailable instead of the whole plugin failing.
*
* @param ctx - the plugin context.
*/
function installSettingsRoute(ctx) {
	ctx.inject(["webServer", "settings"], (child) => {
		const server = child.get("webServer");
		const settings = child.get("settings");
		child.effect(() => server.register({
			kind: "exact",
			path: SETTINGS_PATH,
			handler: async (req, res) => {
				const origin = req.headers.origin;
				let foreignOrigin = false;
				if (origin !== void 0) try {
					const url = new URL(origin);
					foreignOrigin = !["http:", "https:"].includes(url.protocol) || url.host !== req.headers.host;
				} catch {
					foreignOrigin = true;
				}
				if (foreignOrigin || req.headers["sec-fetch-site"] === "cross-site") {
					json(res, 403, {
						ok: false,
						error: "cross-site settings request denied"
					});
					return;
				}
				if (req.method === "GET") {
					try {
						json(res, 200, {
							ok: true,
							sections: readSettingsView(settings)
						});
					} catch (error) {
						json(res, 500, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					}
					return;
				}
				if (req.method !== "POST") {
					res.setHeader("Allow", "GET, POST");
					json(res, 405, {
						ok: false,
						error: "method not allowed (use GET or POST)"
					});
					return;
				}
				if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
					json(res, 415, {
						ok: false,
						error: "application/json is required"
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
				const parsed = parseSettingsWriteRequest(body);
				if (!parsed.ok) {
					json(res, 400, {
						ok: false,
						error: parsed.error
					});
					return;
				}
				try {
					const { ns, ops, expectedRevision } = parsed.request;
					const result = await settings.mutate(ns, ops, expectedRevision);
					json(res, 200, {
						ok: true,
						sections: readSettingsView(settings),
						...typeof result?.revision === "number" ? { revision: result.revision } : {}
					});
				} catch (error) {
					const code = error.code;
					json(res, code === "SETTINGS_CONFLICT" ? 409 : error instanceof TypeError ? 400 : 500, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
						...typeof code === "string" ? { code } : {}
					});
				}
			}
		}, "dsh-do.settings-route()"));
	});
}
//#endregion
//#region lib/types/tools.js
/** Execution-time authority checks for the model-facing loop tools. */
function reject(message, code = "LOOP_TOOL_AUTHORITY_REQUIRED") {
	throw new HarnessError(message, code);
}
/** Locate the open turn enclosing a model tool call. */
function openTurn(agent) {
	const events = readSessionEvents(agent.session);
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
/** Compact canonical view of one loop, matching the output schema. */
/** Every recorded stop cause, as the output schema advertises them. */
const PAUSE_REASON_CODES = [
	"round-cancelled",
	"round-aborted",
	"max-tokens",
	"agent-error",
	"driver-failed",
	"restart"
];
/** Stable compact model result; `armed` is an observation, not replay state. */
function loopValue(agent, loop) {
	if (loop === void 0) return { loop: null };
	return { loop: {
		id: loop.id,
		objective: loop.objective,
		phase: loop.phase,
		armed: loop.armed,
		...loop.pausedReason === void 0 || loop.phase !== "active" || loop.armed ? {} : { pausedReason: {
			code: loop.pausedReason.code,
			message: loop.pausedReason.message,
			at: loop.pausedReason.at
		} },
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
		properties: { loop: {
			required: true,
			oneOf: [{ type: "null" }, {
				type: "object",
				additionalProperties: false,
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
					pausedReason: {
						type: "object",
						additionalProperties: false,
						properties: {
							code: {
								type: "string",
								required: true,
								enum: PAUSE_REASON_CODES
							},
							message: {
								type: "string",
								required: true
							},
							at: {
								type: "number",
								required: true
							}
						}
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
			}]
		} }
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
const START_DESCRIPTION = "Start one Claude Code-style autonomous loop for the current session: the driver then auto-continues across turns, re-queueing the objective as <loop_round> prompts until the model calls loop_done, the round budget is exhausted, or the loop is cancelled. Use when a direct human request is a long-running objective that should keep iterating in this same session. If an active loop exists but is disarmed (e.g. after a cancelled round), it is replaced by this objective with a fresh round budget. An armed loop is never clobbered: inspect it with loop_status, stop it with loop_cancel, or let it finish. Execution rejects non-human and subagent authority.";
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
			const maxRounds = args.max_rounds === void 0 ? config.defaultMaxRounds() : args.max_rounds;
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
//#region lib/types/tui.js
/**
* The TUI half of dsh-DO.
*
* `@huiliyi37/dsh-tianshu-tui` (the `dsh-tui` profile's UI layer) does NOT read
* the harness-wide `commands` service that `/loop` registers into. It owns a
* separate slash-command registry and documents one extension point for outside
* plugins:
*
*     ctx.get('tui.commands')?.register(...)
*
* Without this module `/loop` would be invisible in a TUI session while the
* model-facing `loop_*` tools kept working, which is exactly the gap this file
* closes. The registry is provided by the TUI app at construction, so the
* registration waits for the service instead of requiring it: under the web or
* headless profiles the service never appears and this module does nothing.
*
* Both halves drive the same `LoopController`, so a loop started from the TUI
* slash line is the same loop the tools and the driver operate on.
*
* @module
*/
/** The Cordis service name the TUI publishes its slash-command registry under. */
const TUI_COMMANDS_SERVICE = "tui.commands";
/** The command name; it collides with no TUI builtin, so prefix resolution stays unambiguous. */
const TUI_LOOP_COMMAND_NAME = "loop";
/** Shown in the TUI's inline `/` hint line. */
const TUI_LOOP_ARGS_HINT = "[<interval>] [<objective>|pause|resume|edit <objective>|done|cancel]";
/** Description shown by the TUI command list. */
const TUI_LOOP_DESCRIPTION = "自主循环：查看/启动/暂停/恢复/改目标/完成/取消（dsh-DO）";
/**
* Narrow an unknown service value to a usable TUI registry.
*
* The name `tui.commands` is not part of the harness's declared service surface,
* so the value is whatever a third-party TUI plugin happened to publish; a shape
* check keeps a lookalike service from breaking the plugin.
*
* @param value - the value read from the service store.
* @returns whether it can be registered into.
*/
function isTuiCommandRegistry(value) {
	if (value === null || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.register === "function" && typeof candidate.unregister === "function";
}
/**
* Build the `/loop` command the TUI registers.
*
* Kept separate from installation so the handler is testable without a Cordis
* runtime.
*
* @param deps - the shared controller, the live settings reader, and the agent
*   lookup used to report the effective round count.
* @returns the command definition.
*/
function buildTuiLoopCommand(deps) {
	return {
		name: TUI_LOOP_COMMAND_NAME,
		description: TUI_LOOP_DESCRIPTION,
		argsHint: TUI_LOOP_ARGS_HINT,
		run: ({ text, echo, sessionId }) => {
			if (sessionId === null) {
				echo("⚠ 当前无会话，无法操作循环");
				return;
			}
			const agent = deps.findAgent(sessionId);
			const outcome = executeLoopCommand(deps.controller, parseLoopCommand(text), sessionId, deps.defaultMaxRounds, (loop) => effectiveRounds(agent, loop));
			echo(outcome.kind === "error" ? `⚠ ${outcome.text}` : outcome.text);
		}
	};
}
/**
* Register `/loop` into the TUI's slash-command registry once it exists.
*
* `ctx.inject` waits for the service, so this is a no-op under the web and
* headless profiles (which never publish `tui.commands`) and activates whenever
* a TUI profile is composed. The registration is torn down with the fiber.
*
* @param ctx - the plugin context.
* @param controller - the shared loop controller.
* @param defaultMaxRounds - live reader for the configured round budget.
*/
function installTuiCommand(ctx, controller, defaultMaxRounds) {
	ctx.inject([TUI_COMMANDS_SERVICE], (tuiCtx) => {
		const registry = tuiCtx.get(TUI_COMMANDS_SERVICE);
		if (!isTuiCommandRegistry(registry)) {
			ctx.logger.warn(`dsh-do: service "${TUI_COMMANDS_SERVICE}" is not a slash-command registry; /loop is unavailable in this TUI`);
			return;
		}
		registry.register(buildTuiLoopCommand({
			controller,
			defaultMaxRounds,
			findAgent: (sessionId) => ctx.agents.get(SessionId(sessionId))
		}));
		tuiCtx.effect(() => () => registry.unregister(TUI_LOOP_COMMAND_NAME));
	});
}
//#endregion
//#region lib/types/model-fallback.js
/**
* Parse one candidate written as `provider/model`.
*
* Only the FIRST slash separates the two: model ids such as
* `anthropic/claude-sonnet` (an OpenRouter-style id) keep their own slashes.
*
* @param text - the configured candidate.
* @returns the route, or undefined for a malformed entry.
*/
function parseModelRoute(text) {
	const trimmed = text.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return void 0;
	return {
		provider: trimmed.slice(0, slash).trim(),
		model: trimmed.slice(slash + 1).trim()
	};
}
/** Render a route back to its configured form. */
function formatModelRoute(route) {
	return `${route.provider}/${route.model}`;
}
/** Whether two routes name the same model. */
function sameRoute(a, b) {
	return a !== void 0 && b !== void 0 && a.provider === b.provider && a.model === b.model;
}
/**
* Pick the next candidate after a failure.
*
* @param policy - the live fallback settings.
* @param failing - the route that just failed (undefined when unknown).
* @param tried - routes already used in this episode, including the primary.
* @param code - the normalized failure code.
* @returns the route to switch to, or a reason it will not switch.
*/
function chooseFallback(policy, failing, tried, code) {
	if (!policy.enabled) return {
		kind: "keep",
		reason: "disabled"
	};
	if (!policy.triggerCodes.includes(code)) return {
		kind: "keep",
		reason: "code"
	};
	for (const text of policy.candidates) {
		const route = parseModelRoute(text);
		if (route === void 0) continue;
		if (sameRoute(route, failing)) continue;
		if (tried.some((used) => sameRoute(used, route))) continue;
		return {
			kind: "switch",
			route
		};
	}
	return {
		kind: "keep",
		reason: "exhausted"
	};
}
/**
* Install automatic model fallback.
*
* @param ctx - the plugin context.
* @param policy - live reader for the fallback settings.
* @returns a handle exposing per-agent state for status surfaces.
*/
function installModelFallback(ctx, policy) {
	const episodes = /* @__PURE__ */ new WeakMap();
	const episodeFor = (agent) => {
		let episode = episodes.get(agent);
		if (episode === void 0) {
			episode = { tried: [] };
			episodes.set(agent, episode);
		}
		return episode;
	};
	ctx.on("agent/request", async ({ agent }, next) => {
		const resolved = await next();
		const episode = episodeFor(agent);
		const override = policy().enabled ? episode.override : void 0;
		if (override === void 0) {
			episode.last = {
				provider: resolved.provider,
				model: resolved.model
			};
			return resolved;
		}
		const { reasoningEffort: _inherited, ...rest } = resolved;
		episode.last = override;
		return {
			...rest,
			provider: override.provider,
			model: override.model
		};
	}, { prepend: true });
	ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
		const downstream = await next();
		if (downstream?.kind === "retry" || signal.aborted) return downstream;
		const episode = episodeFor(agent);
		const failing = episode.last;
		if (failing !== void 0 && !episode.tried.some((used) => sameRoute(used, failing))) episode.tried.push(failing);
		const choice = chooseFallback(policy(), failing, episode.tried, failure.code);
		if (choice.kind === "keep") {
			if (choice.reason === "exhausted") ctx.logger.warn(`dsh-do: every fallback model failed for agent "${agent.id}" (${failure.code}); the error stands`);
			return downstream;
		}
		episode.override = choice.route;
		episode.tried.push(choice.route);
		ctx.logger.info(`dsh-do: ${failing === void 0 ? "model" : formatModelRoute(failing)} failed with ${failure.code}; switching agent "${agent.id}" to ${formatModelRoute(choice.route)}`);
		return { kind: "retry" };
	}, { prepend: true });
	ctx.on("session/event", (session, event) => {
		if (event.type !== "user/message") return;
		if (event.data.source?.kind !== "user") return;
		const agent = ctx.agents.get(session.id);
		if (agent !== void 0) episodes.delete(agent);
	});
	return { view(agent) {
		const episode = episodes.get(agent);
		if (episode === void 0 || episode.override === void 0 && episode.tried.length === 0) return void 0;
		return {
			...episode.override === void 0 ? {} : { override: formatModelRoute(episode.override) },
			tried: episode.tried.map(formatModelRoute)
		};
	} };
}
//#endregion
//#region lib/types/config-command.js
/** Command name; distinct from the TUI builtin `/config` so prefixes stay unambiguous. */
const CONFIG_COMMAND_NAME = "do-config";
/** Every user-editable dsh-DO setting, in display order. */
const CONFIG_FIELDS = [
	{
		path: "defaultMaxRounds",
		type: "integer",
		min: 1,
		help: "未指定 max_rounds 时一次循环的最大轮次"
	},
	{
		path: "checkpointDir",
		type: "string",
		help: "循环检查点目录，留空用 $DSH_HOME/loops"
	},
	{
		path: "persist",
		type: "boolean",
		help: "持久化循环状态（重启可恢复）"
	},
	{
		path: "loopDetection.enabled",
		type: "boolean",
		help: "检测模型重复调用同一工具"
	},
	{
		path: "loopDetection.repeatThreshold",
		type: "integer",
		min: 2,
		help: "连续相同调用多少次算循环"
	},
	{
		path: "loopDetection.compact",
		type: "boolean",
		help: "恢复前压缩历史"
	},
	{
		path: "loopDetection.maxInterventions",
		type: "integer",
		min: 1,
		help: "单轮最多干预次数"
	},
	{
		path: "autoContinue.enabled",
		type: "boolean",
		help: "输出被 token 上限截断时自动继续"
	},
	{
		path: "autoContinue.maxContinuations",
		type: "integer",
		min: 1,
		help: "连续自动继续的最大次数"
	},
	{
		path: "autoContinue.onlyWhileLooping",
		type: "boolean",
		help: "只在循环运行中自动继续（false=任何会话）"
	},
	{
		path: "modelFallback.enabled",
		type: "boolean",
		help: "模型失败时自动切换到候选模型"
	},
	{
		path: "modelFallback.candidates",
		type: "list",
		help: "候选模型，按顺序，写作 provider/model，逗号分隔"
	},
	{
		path: "modelFallback.triggerCodes",
		type: "list",
		help: "触发切换的错误码，逗号分隔"
	}
];
/**
* Display grouping for the `/do-config` listing — the flat 13-line list was
* unreadable, so related knobs are shown together under a heading.
*
* Every path here must exist in {@link CONFIG_FIELDS}, and every field must
* appear exactly once; a test asserts the two cover each other.
*/
const CONFIG_GROUPS = [
	{
		title: "循环",
		note: "每轮推进与检查点",
		paths: [
			"defaultMaxRounds",
			"checkpointDir",
			"persist"
		]
	},
	{
		title: "自动继续",
		note: "输出被 token 上限截断时接着写",
		paths: [
			"autoContinue.enabled",
			"autoContinue.maxContinuations",
			"autoContinue.onlyWhileLooping"
		]
	},
	{
		title: "模型自动切换",
		note: "模型报错时改用候选模型",
		paths: [
			"modelFallback.enabled",
			"modelFallback.candidates",
			"modelFallback.triggerCodes"
		]
	},
	{
		title: "循环检测",
		note: "重复调用同一工具时干预",
		paths: [
			"loopDetection.enabled",
			"loopDetection.repeatThreshold",
			"loopDetection.compact",
			"loopDetection.maxInterventions"
		]
	}
];
/** The namespace dsh-DO's section is actually filed under in this deployment. */
function locateDoSection(forms, fallback) {
	for (const descriptor of forms.describe({ redactSecrets: true })) if (isDoSection(descriptor.ns, descriptor.value)) return descriptor.ns;
	return fallback;
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
function adaptSettingsAccess(service) {
	const record = service;
	if (record === void 0 || record === null || typeof record.mutate !== "function") return void 0;
	if (typeof record.get === "function") return service;
	if (typeof record.describe !== "function") return void 0;
	const forms = service;
	return {
		get: (ns) => {
			const wanted = locateDoSection(forms, ns);
			return forms.describe({ redactSecrets: true }).find((descriptor) => descriptor.ns === wanted)?.value;
		},
		mutate: (ns, ops) => forms.mutate(locateDoSection(forms, ns), ops)
	};
}
/** Parse the text after `/do-config`. */
function parseConfigCommand(text) {
	const trimmed = text.trim();
	if (trimmed === "") return { kind: "list" };
	if (trimmed === "file" || trimmed === "path") return { kind: "file" };
	const space = trimmed.search(/\s/);
	const head = space < 0 ? trimmed : trimmed.slice(0, space);
	const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();
	if (head === "reset" || head === "unset") return {
		kind: "reset",
		path: rest
	};
	if (rest === "") return {
		kind: "show",
		path: head
	};
	return {
		kind: "set",
		path: head,
		raw: rest
	};
}
/** Split `a=b` written as one token. */
function splitAssignment(command) {
	if (command.kind !== "show") return command;
	const eq = command.path.indexOf("=");
	if (eq <= 0) return command;
	return {
		kind: "set",
		path: command.path.slice(0, eq),
		raw: command.path.slice(eq + 1)
	};
}
/** Find a field by exact path, or by a unique case-insensitive suffix (`candidates`). */
function findField(path) {
	const exact = CONFIG_FIELDS.find((field) => field.path === path);
	if (exact !== void 0) return exact;
	const lower = path.toLowerCase();
	const matches = CONFIG_FIELDS.filter((field) => field.path.toLowerCase() === lower || field.path.toLowerCase().endsWith(`.${lower}`));
	return matches.length === 1 ? matches[0] : void 0;
}
/**
* Coerce a loosely typed value. Formatting is deliberately forgiving: booleans
* accept on/off/yes/no/开/关, lists accept commas, spaces, or a JSON array.
*/
function coerceValue(field, raw) {
	const text = raw.trim();
	switch (field.type) {
		case "boolean": {
			const lower = text.toLowerCase();
			if ([
				"true",
				"on",
				"yes",
				"y",
				"1",
				"开",
				"开启",
				"是"
			].includes(lower)) return {
				ok: true,
				value: true
			};
			if ([
				"false",
				"off",
				"no",
				"n",
				"0",
				"关",
				"关闭",
				"否"
			].includes(lower)) return {
				ok: true,
				value: false
			};
			return {
				ok: false,
				error: `${field.path} 需要 true/false（也接受 on/off、开/关）`
			};
		}
		case "integer": {
			const value = Number(text);
			if (!Number.isSafeInteger(value)) return {
				ok: false,
				error: `${field.path} 需要整数`
			};
			if (field.min !== void 0 && value < field.min) return {
				ok: false,
				error: `${field.path} 不能小于 ${field.min}`
			};
			return {
				ok: true,
				value
			};
		}
		case "string": return {
			ok: true,
			value: text === "\"\"" || text === "''" ? "" : text
		};
		case "list":
			if (text.startsWith("[")) try {
				const parsed = JSON.parse(text);
				if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return {
					ok: true,
					value: parsed.map((item) => item.trim()).filter(Boolean)
				};
			} catch {}
			if (text === "" || text === "[]" || text === "-") return {
				ok: true,
				value: []
			};
			return {
				ok: true,
				value: text.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean)
			};
	}
}
/** Read a dotted path out of a plain object. */
function readPath(value, path) {
	let current = value;
	for (const key of path.split(".")) {
		if (current === null || typeof current !== "object") return void 0;
		current = current[key];
	}
	return current;
}
/** Display form of a value. */
function formatSetting(value) {
	if (Array.isArray(value)) return value.length === 0 ? "[]" : value.join(", ");
	if (value === "") return "\"\"";
	if (value === void 0) return "—";
	return String(value);
}
/** ANSI SGR sequences this module emits; attributes only, never a hue. */
const SGR_RE = /\u001B\[[0-9;]*m/g;
/** Code points that occupy two terminal cells (CJK, fullwidth forms, emoji). */
function isWide(codePoint) {
	return codePoint >= 4352 && codePoint <= 4447 || codePoint >= 11904 && codePoint <= 12350 || codePoint >= 12353 && codePoint <= 13311 || codePoint >= 13312 && codePoint <= 19903 || codePoint >= 19968 && codePoint <= 40959 || codePoint >= 40960 && codePoint <= 42191 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65072 && codePoint <= 65135 || codePoint >= 65280 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 127744 && codePoint <= 128591 || codePoint >= 129280 && codePoint <= 129535;
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
function displayWidth(text) {
	let width = 0;
	for (const char of text.replace(SGR_RE, "")) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
	return width;
}
/** Attribute wrappers; no-ops when colour is off. */
function makePainter(color) {
	const wrap = (code) => (text) => color ? `\u001B[${code}m${text}\u001B[0m` : text;
	return {
		bold: wrap("1"),
		dim: wrap("2")
	};
}
/**
* Draw a rounded box around a title and its content rows.
*
* @param title - box heading.
* @param rows - content rows (already painted; measurement strips ANSI).
* @returns the box lines, all the same width.
*/
function renderBox(title, rows) {
	const inner = Math.max(displayWidth(title) + 4, ...rows.map((row) => displayWidth(row) + 2));
	return [
		`╭─ ${title} ${"─".repeat(Math.max(0, inner - displayWidth(title) - 3))}╮`,
		...rows.map((row) => `│ ${row}${" ".repeat(Math.max(0, inner - displayWidth(row) - 1))}│`),
		`╰${"─".repeat(inner)}╯`
	];
}
/** The four ways to drive this command, laid out two per row inside the box. */
function commandHelpRows() {
	const cells = [
		["改", "/do-config <路径> <值>"],
		["看", "/do-config <路径>"],
		["还原", "/do-config reset <路径>"],
		["文件", "/do-config file"]
	].map(([label, body]) => `${label} ${body}`);
	const gap = Math.max(displayWidth(cells[0] ?? ""), displayWidth(cells[2] ?? "")) + 3;
	const row = (left, right) => `${left}${" ".repeat(Math.max(1, gap - displayWidth(left)))}${right}`;
	return [row(cells[0] ?? "", cells[1] ?? ""), row(cells[2] ?? "", cells[3] ?? "")];
}
/** `（已关闭）` when a group owns an `enabled` switch that is off. */
function groupOffMark(group, resolved) {
	for (const path of group.paths) if (path === "enabled" || path.endsWith(".enabled")) return readPath(resolved, path) === false ? "（已关闭）" : "";
	return "";
}
/**
* Every line `/do-config` prints for the full listing: a command box, then one
* aligned block per group.
*
* @param resolved - the resolved dsh-DO config.
* @param options - rendering options (see {@link ListingOptions}).
* @returns the listing lines.
*/
function renderConfigListing(resolved, options = {}) {
	const paint = makePainter(options.color === true);
	const pathWidth = Math.max(...CONFIG_FIELDS.map((field) => displayWidth(field.path)));
	const lines = renderBox("dsh-DO 设置", commandHelpRows());
	for (const group of CONFIG_GROUPS) {
		const off = groupOffMark(group, resolved);
		lines.push("", `${paint.bold(`◆ ${group.title}`)}${paint.dim(` · ${group.note}`)}${off === "" ? "" : paint.bold(off)}`);
		for (const path of group.paths) {
			const shown = formatSetting(readPath(resolved, path));
			const pad = " ".repeat(Math.max(1, pathWidth - displayWidth(path) + 2));
			lines.push(`   ${paint.dim(path)}${pad}${paint.bold(shown)}`);
		}
	}
	lines.push("", paint.dim("改完立即生效，无需重启；也可以直接编辑设置文件里的 dsh-do: 段。"));
	return lines;
}
/**
* Detail view for one field: current value, accepted shape, and what it does.
*
* @param field - the field to describe.
* @param resolved - the resolved dsh-DO config.
* @param color - emit ANSI attributes.
* @returns the detail lines.
*/
function renderFieldDetail(field, resolved, color) {
	const paint = makePainter(color);
	const kind = {
		boolean: "开关（on/off）",
		integer: "整数",
		string: "文本",
		list: "列表（逗号分隔）"
	}[field.type];
	const floor = field.min === void 0 ? "" : `，最小 ${field.min}`;
	return [
		`${paint.bold(field.path)} = ${paint.bold(formatSetting(readPath(resolved, field.path)))}`,
		paint.dim(`  类型  ${kind}${floor}`),
		paint.dim(`  说明  ${field.help}`),
		paint.dim(`  改法  /do-config ${field.path} <值>`)
	];
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
function readSection(settings) {
	return plainSettings(settings.get(DSH_DO_NS));
}
/**
* Run one `/do-config` command against the settings service.
*
* @param settings - the settings service, or undefined when none is mounted.
* @param text - the text after the command name.
* @param fileHint - where the settings document lives, for `file`.
* @param options - rendering options (see {@link ListingOptions}).
*/
async function executeConfigCommand(settings, text, fileHint, options = {}) {
	const paint = makePainter(options.color === true);
	if (settings === void 0) return {
		ok: false,
		lines: ["当前组合没有挂载 settings 服务，dsh-do 设置只能来自 cordis.patch.yml 的组合配置。"]
	};
	const command = splitAssignment(parseConfigCommand(text));
	const resolved = readSection(settings);
	switch (command.kind) {
		case "list": return {
			ok: true,
			lines: renderConfigListing(resolved, options)
		};
		case "file": return {
			ok: true,
			lines: [`设置文件：${fileHint}`, "直接编辑其中的 `dsh-do:` 段即可，保存后自动生效（无需重启）。"]
		};
		case "show": {
			const field = findField(command.path);
			if (field === void 0) return {
				ok: false,
				lines: [unknownPath(command.path)]
			};
			return {
				ok: true,
				lines: renderFieldDetail(field, resolved, options.color === true)
			};
		}
		case "reset": {
			const field = findField(command.path);
			if (field === void 0) return {
				ok: false,
				lines: [unknownPath(command.path)]
			};
			await settings.mutate(DSH_DO_NS, [{
				op: "unset",
				path: field.path.split(".")
			}]);
			const now = formatSetting(readPath(readSection(settings), field.path));
			return {
				ok: true,
				lines: [`✓ ${field.path} 已恢复默认：${paint.bold(now)}`]
			};
		}
		case "set": {
			const field = findField(command.path);
			if (field === void 0) return {
				ok: false,
				lines: [unknownPath(command.path)]
			};
			const coerced = coerceValue(field, command.raw);
			if (!coerced.ok) return {
				ok: false,
				lines: [coerced.error]
			};
			await settings.mutate(DSH_DO_NS, [{
				op: "set",
				path: field.path.split("."),
				value: coerced.value
			}]);
			const now = formatSetting(readPath(readSection(settings), field.path));
			return {
				ok: true,
				lines: [`✓ ${field.path} = ${paint.bold(now)}（已保存，立即生效）`]
			};
		}
	}
}
function unknownPath(path) {
	return `未知设置「${path}」。可用：${CONFIG_FIELDS.map((field) => field.path).join("，")}`;
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
function installConfigCommand(ctx) {
	const settingsOf = () => adaptSettingsAccess(ctx.get("settings"));
	const fileHint = () => {
		return `${(process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? "~"}/.dsh`).replace(/[\\/]+$/, "")}${process.platform === "win32" ? "\\" : "/"}settings.yaml`;
	};
	const run = async (text, color = false) => {
		try {
			return await executeConfigCommand(settingsOf(), text, fileHint(), { color });
		} catch (error) {
			return {
				ok: false,
				lines: [`保存失败：${renderError(error)}`]
			};
		}
	};
	ctx.inject(["commands"], (child) => {
		child.commands.register({
			name: CONFIG_COMMAND_NAME,
			description: "view or change dsh-DO settings (auto-continue, model fallback, loop detection, ...)",
			input: { hint: "[<path> [<value>] | reset <path> | file]" },
			handler: async (invocation) => {
				const outcome = await run(invocation.rawInput);
				return {
					kind: outcome.ok ? "success" : "error",
					text: outcome.lines.join("\n")
				};
			}
		});
	});
	ctx.inject([TUI_COMMANDS_SERVICE], (tuiCtx) => {
		const registry = tuiCtx.get(TUI_COMMANDS_SERVICE);
		if (!isTuiCommandRegistry(registry)) return;
		registry.register({
			name: CONFIG_COMMAND_NAME,
			description: "dsh-DO 设置：查看/修改自动继续、模型切换、循环检测等",
			argsHint: "[<路径> [<值>] | reset <路径> | file]",
			run: async ({ text, echo }) => {
				const outcome = await run(text, true);
				outcome.lines.forEach((line, index) => echo(index === 0 && !outcome.ok ? `⚠ ${line}` : line));
			}
		});
		tuiCtx.effect(() => () => registry.unregister(CONFIG_COMMAND_NAME));
	});
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
/** Derive the checkpoint root from configuration or the DSH home directory. */
function resolveCheckpointDir(checkpointDir) {
	if (checkpointDir !== "") return checkpointDir;
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "loops");
}
/** Model-visible policy guidance rendered as a system-prompt section. */
const LOOP_GUIDANCE = `Use loop tools for a Claude Code-style autonomous loop: when a direct human request is a long-running objective that should keep iterating across turns, call loop_start with the objective and an optional round budget; the loop then auto-continues until the model calls loop_done, the budget is exhausted, or the loop is cancelled. A cancelled round disarms the loop until loop_start re-arms it. The human can drive the same loop with the /loop command. Prefer goal tools for goal-scoped continuation and one mechanism per task.`;
/** Apply the plugin. */
function apply(ctx, rawConfig) {
	const config = plainSettings(rawConfig);
	const storeFor = (settings) => settings.persist ? new LoopStore(resolveCheckpointDir(settings.checkpointDir), { onError: (message) => ctx.logger.warn(message) }) : void 0;
	let storeDir = config.persist ? resolveCheckpointDir(config.checkpointDir) : void 0;
	const controller = new LoopController(storeFor(config), ctx.logger);
	const restore = controller.restore().catch((error) => {
		ctx.logger.warn(`dsh-do: checkpoint restore failed; continuing in memory: ${String(error)}`);
	});
	const settings = installDoSettings(ctx, rawConfig, (next) => {
		const wantedDir = next.persist ? resolveCheckpointDir(next.checkpointDir) : void 0;
		if (wantedDir === storeDir) return;
		storeDir = wantedDir;
		controller.useStore(storeFor(next));
		ctx.logger.info(wantedDir === void 0 ? "dsh-do: loop checkpointing disabled" : `dsh-do: loop checkpoints now written to ${wantedDir}`);
	});
	ctx.effect(async function* () {
		await restore;
		registerLoopTools(ctx, controller, { defaultMaxRounds: () => settings.read().defaultMaxRounds });
	}, "dsh-do.tools()");
	ctx.effect(function* () {
		const driver = installLoopDriver(ctx, controller, restore, { autoContinue: () => settings.read().autoContinue });
		controller.setNotifier((loop) => {
			driver.nudge(loop.sessionId);
		});
		yield () => controller.setNotifier(void 0);
	}, "dsh-do.driver()");
	installLoopCommand(ctx, controller, () => settings.read().defaultMaxRounds);
	installLoopStatus(ctx, controller);
	installTuiCommand(ctx, controller, () => settings.read().defaultMaxRounds);
	installLoopDetection(ctx, {
		policy: () => settings.read().loopDetection,
		driverArmed: (agent) => {
			const loop = controller.get(agent.session.id);
			if (loop !== void 0 && loop.phase === "active" && loop.armed) return true;
			const goals = ctx.get("goals");
			if (goals === void 0) return false;
			try {
				const goal = goals.get(agent);
				return goal !== void 0 && goal.phase === "active" && goal.activation === "armed";
			} catch {
				return false;
			}
		}
	});
	installModelFallback(ctx, () => settings.read().modelFallback);
	installConfigCommand(ctx);
	installAiInstallRoute(ctx);
	installSettingsRoute(ctx);
	ctx.systemPrompt.section({
		name: "tool:loop",
		order: 121,
		text: LOOP_GUIDANCE
	});
}
//#endregion
export { Config, DSH_DO_NS, apply, inject, name, resolveCheckpointDir };
