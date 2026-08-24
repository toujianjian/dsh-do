window.__ModuleLoader__.load({
	id: "dsh-do",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
			"card": "XgsC0q_card",
			"hint": "XgsC0q_hint",
			"input": "XgsC0q_input",
			"cardMobile": "XgsC0q_cardMobile",
			"backdrop": "XgsC0q_backdrop",
			"cancel": "XgsC0q_cancel",
			"actions": "XgsC0q_actions",
			"heading": "XgsC0q_heading",
			"failure": "XgsC0q_failure",
			"submit": "XgsC0q_submit"
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
			(0, react.useEffect)(() => {
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
			}, [state.open]);
			const submit = (0, react.useCallback)(async () => {
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
				setPending(true);
				setFailure(null);
				try {
					await workspaces.create({ path });
					closeAddWorkspaceDialog();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					setFailure(`添加失败：${message}`);
				} finally {
					setPending(false);
				}
			}, [value]);
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
			"searchButton": "GcuF6a_searchButton",
			"panelHeader": "GcuF6a_panelHeader",
			"muted": "GcuF6a_muted",
			"tab": "GcuF6a_tab",
			"installOk": "GcuF6a_installOk",
			"searchInput": "GcuF6a_searchInput",
			"close": "GcuF6a_close",
			"tabActive": "GcuF6a_tabActive",
			"searchRow": "GcuF6a_searchRow",
			"repoList": "GcuF6a_repoList",
			"aiInstall": "GcuF6a_aiInstall",
			"tabs": "GcuF6a_tabs",
			"errorText": "GcuF6a_errorText",
			"footerButton": "GcuF6a_footerButton",
			"repoName": "GcuF6a_repoName",
			"repoTop": "GcuF6a_repoTop",
			"footerLabel": "GcuF6a_footerLabel",
			"panelBackdrop": "GcuF6a_panelBackdrop",
			"panel": "GcuF6a_panel",
			"panelTitle": "GcuF6a_panelTitle",
			"repoItem": "GcuF6a_repoItem",
			"repoMeta": "GcuF6a_repoMeta",
			"repoDesc": "GcuF6a_repoDesc"
		};
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
			const alive = (0, react.useRef)(true);
			(0, react.useEffect)(() => () => {
				alive.current = false;
			}, []);
			const runProjectsSearch = (0, react.useCallback)(async (rawQuery) => {
				setProjects((current) => ({
					...current,
					status: "loading"
				}));
				try {
					const terms = rawQuery.trim();
					const q = terms.length === 0 ? "dsh" : terms;
					const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, { headers: { Accept: "application/vnd.github+json" } });
					if (!response.ok) throw new Error(`GitHub API ${response.status}`);
					const payload = await response.json();
					if (!alive.current) return;
					setProjects({
						status: "done",
						repos: payload.items ?? []
					});
				} catch (error) {
					if (!alive.current) return;
					setProjects({
						status: "error",
						repos: []
					});
				}
			}, []);
			const runPluginsSearch = (0, react.useCallback)(async (rawQuery) => {
				setPlugins((current) => ({
					...current,
					status: "loading"
				}));
				try {
					const terms = rawQuery.trim();
					const q = terms.length === 0 ? "dsh-plugin" : terms;
					const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, { headers: { Accept: "application/vnd.github+json" } });
					if (!response.ok) throw new Error(`GitHub API ${response.status}`);
					const payload = await response.json();
					if (!alive.current) return;
					setPlugins({
						status: "done",
						repos: payload.items ?? []
					});
				} catch (error) {
					if (!alive.current) return;
					setPlugins({
						status: "error",
						repos: []
					});
				}
			}, []);
			/** Ask the host to open a new session with the install prompt. */
			const aiInstall = (0, react.useCallback)(async (name, prompt) => {
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
						body: JSON.stringify({ prompt })
					});
					const payload = await response.json();
					if (!alive.current) return;
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
					if (!alive.current) return;
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
								children: "没有找到匹配的 dsh-plugin 项目"
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
			setWorkspacesService(ctx.workspaces);
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
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map