import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { AddWorkspaceDialog } from "./AddWorkspaceDialog.js";
import css from './GitHubSearch.module.css';
/** GitHub Octocat mark (official path, rendered in the current text color). */
function GitHubIcon() {
    return (_jsx("svg", { viewBox: "0 0 16 16", width: "18", height: "18", fill: "currentColor", "aria-hidden": "true", children: _jsx("path", { fillRule: "evenodd", d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" }) }));
}
/** Build the install prompt handed to a brand-new session for one repo. */
function installPromptFor(repo) {
    return [
        `请帮我安装 DSH 插件：${repo.full_name}`,
        `仓库：${repo.html_url}`,
        '',
        '步骤：',
        '1. 先确认它是有效的 DSH 插件（package.json 含 dsh.bundle，且 patch/产物完整可加载）；',
        '2. 用 dsh plugin --profile web add github:<owner>/<repo> 安装（若它是 npm 包则用包名）；',
        '3. 验证安装结果（bundle 层已注册、--dump-config 能看到），并告诉我是否需要重启 profile 生效。',
    ].join('\n');
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
export function GitHubSearchButton({ wide }) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState('projects');
    const [query, setQuery] = useState('');
    const [projects, setProjects] = useState({
        status: 'idle',
        repos: [],
    });
    const [plugins, setPlugins] = useState({
        status: 'idle',
        repos: [],
    });
    const [installs, setInstalls] = useState({});
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    const runProjectsSearch = useCallback(async (rawQuery) => {
        setProjects((current) => ({ ...current, status: 'loading' }));
        try {
            const terms = rawQuery.trim();
            // Generic GitHub project search: any keyword, no prefix. An empty query
            // browses dsh-related projects.
            const q = terms.length === 0 ? 'dsh' : terms;
            const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
            if (!response.ok)
                throw new Error(`GitHub API ${response.status}`);
            const payload = (await response.json());
            if (!alive.current)
                return;
            setProjects({ status: 'done', repos: payload.items ?? [] });
        }
        catch (error) {
            if (!alive.current)
                return;
            setProjects({ status: 'error', repos: [] });
        }
    }, []);
    const runPluginsSearch = useCallback(async (rawQuery) => {
        setPlugins((current) => ({ ...current, status: 'loading' }));
        try {
            const terms = rawQuery.trim();
            // Also GitHub: typed keywords search freely; the empty query browses
            // plugin repos by keyword instead of by topic tag.
            const q = terms.length === 0 ? 'dsh-plugin' : terms;
            const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
            if (!response.ok)
                throw new Error(`GitHub API ${response.status}`);
            const payload = (await response.json());
            if (!alive.current)
                return;
            setPlugins({ status: 'done', repos: payload.items ?? [] });
        }
        catch (error) {
            if (!alive.current)
                return;
            setPlugins({ status: 'error', repos: [] });
        }
    }, []);
    /** Ask the host to open a new session with the install prompt. */
    const aiInstall = useCallback(async (name, prompt) => {
        setInstalls((current) => ({ ...current, [name]: { name, status: 'working' } }));
        try {
            const response = await fetch('/dsh-do/ai-install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ prompt }),
            });
            const payload = (await response.json());
            if (!alive.current)
                return;
            if (!response.ok || payload.ok !== true)
                throw new Error(payload.error ?? `HTTP ${response.status}`);
            setInstalls((current) => ({
                ...current,
                [name]: { name, status: 'done', message: '已在新会话中开始安装' },
            }));
        }
        catch (error) {
            if (!alive.current)
                return;
            setInstalls((current) => ({
                ...current,
                [name]: { name, status: 'error', message: error instanceof Error ? error.message : String(error) },
            }));
        }
    }, []);
    const submit = useCallback(() => {
        if (tab === 'projects')
            void runProjectsSearch(query);
        else
            void runPluginsSearch(query);
    }, [tab, query, runProjectsSearch, runPluginsSearch]);
    const projectsBusy = projects.status === 'loading';
    const pluginsBusy = plugins.status === 'loading';
    return (_jsxs(_Fragment, { children: [_jsx(AddWorkspaceDialog, {}), _jsxs("button", { type: "button", className: css.footerButton, "aria-label": "GitHub \u63D2\u4EF6\u641C\u7D22", "aria-expanded": open, title: "\u63D2\u4EF6\u53D1\u73B0\uFF08GitHub \u9879\u76EE / \u63D2\u4EF6\u4ED3\u5E93\uFF09", onClick: () => { setOpen((current) => !current); }, children: [_jsx(GitHubIcon, {}), wide && _jsx("span", { className: css.footerLabel, children: "\u53D1\u73B0" })] }), open && (_jsx("div", { className: css.panelBackdrop, role: "presentation", onPointerDown: (event) => {
                    if (event.target === event.currentTarget)
                        setOpen(false);
                }, children: _jsxs("div", { className: css.panel, role: "dialog", "aria-label": "\u63D2\u4EF6\u53D1\u73B0", children: [_jsxs("div", { className: css.panelHeader, children: [_jsx("span", { className: css.panelTitle, children: "\u63D2\u4EF6\u53D1\u73B0" }), _jsx("button", { type: "button", className: css.close, "aria-label": "\u5173\u95ED", onClick: () => { setOpen(false); }, children: "\u2715" })] }), _jsxs("div", { className: css.tabs, role: "tablist", "aria-label": "\u641C\u7D22\u6765\u6E90", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": tab === 'projects', className: tab === 'projects' ? css.tabActive : css.tab, onClick: () => { setTab('projects'); }, children: "\u9879\u76EE" }), _jsx("button", { type: "button", role: "tab", "aria-selected": tab === 'plugins', className: tab === 'plugins' ? css.tabActive : css.tab, onClick: () => { setTab('plugins'); }, children: "\u63D2\u4EF6" })] }), _jsxs("form", { className: css.searchRow, onSubmit: (event) => {
                                event.preventDefault();
                                submit();
                            }, children: [_jsx("input", { className: css.searchInput, type: "text", spellCheck: false, placeholder: tab === 'projects' ? '输入关键词搜索 GitHub 项目（留空浏览 dsh 相关）' : '输入关键词搜索插件仓库（留空浏览 dsh-plugin）', value: query, onChange: (event) => { setQuery(event.target.value); } }), _jsx("button", { type: "submit", className: css.searchButton, disabled: projectsBusy || pluginsBusy, children: (projectsBusy || pluginsBusy) ? '搜索中…' : '搜索' })] }), tab === 'projects' && projects.status === 'idle' && (_jsx("div", { className: css.muted, children: "\u901A\u7528\u9879\u76EE\u641C\u7D22\uFF1A\u8F93\u5165\u4EFB\u4F55\u5173\u952E\u8BCD\u641C GitHub \u9879\u76EE\uFF08\u4E0D\u542B\u5B89\u88C5\uFF09\u3002" })), tab === 'projects' && projects.status === 'error' && (_jsx("div", { className: css.errorText, children: "\u641C\u7D22\u5931\u8D25\uFF08GitHub API \u9650\u6D41\u6216\u7F51\u7EDC\u95EE\u9898\uFF09\uFF0C\u7A0D\u540E\u518D\u8BD5\u3002" })), tab === 'projects' && projects.status === 'done' && projects.repos.length === 0 && (_jsx("div", { className: css.muted, children: "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684 dsh-plugin \u9879\u76EE" })), tab === 'plugins' && plugins.status === 'idle' && (_jsx("div", { className: css.muted, children: "\u8F93\u5165\u4ED3\u5E93\u540D/\u5173\u952E\u8BCD\u81EA\u7531\u641C\u7D22 GitHub\uFF1B\u7559\u7A7A\u6D4F\u89C8 dsh-plugin \u76F8\u5173\u4ED3\u5E93\u3002" })), tab === 'plugins' && plugins.status === 'error' && (_jsx("div", { className: css.errorText, children: "\u641C\u7D22\u5931\u8D25\uFF08GitHub API \u9650\u6D41\u6216\u7F51\u7EDC\u95EE\u9898\uFF09\uFF0C\u7A0D\u540E\u518D\u8BD5\u3002" })), tab === 'plugins' && plugins.status === 'done' && plugins.repos.length === 0 && (_jsx("div", { className: css.muted, children: "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684 dsh \u63D2\u4EF6\u4ED3\u5E93" })), tab === 'projects' && projects.status === 'done' && projects.repos.length > 0 && (_jsx("ul", { className: css.repoList, children: projects.repos.map((repo) => (_jsxs("li", { className: css.repoItem, children: [_jsx("a", { className: css.repoName, href: repo.html_url, target: "_blank", rel: "noreferrer", children: repo.full_name }), _jsxs("span", { className: css.repoMeta, children: [repo.stargazers_count, " \u2605", repo.language === null ? '' : ` · ${repo.language}`] }), repo.description !== null && _jsx("div", { className: css.repoDesc, children: repo.description })] }, repo.full_name))) })), tab === 'plugins' && plugins.status === 'done' && plugins.repos.length > 0 && (_jsx("ul", { className: css.repoList, children: plugins.repos.map((repo) => {
                                const install = installs[repo.full_name];
                                return (_jsxs("li", { className: css.repoItem, children: [_jsxs("div", { className: css.repoTop, children: [_jsx("a", { className: css.repoName, href: repo.html_url, target: "_blank", rel: "noreferrer", children: repo.full_name }), _jsx("button", { type: "button", className: css.aiInstall, disabled: install?.status === 'working', onClick: () => { void aiInstall(repo.full_name, installPromptFor(repo)); }, children: install?.status === 'working' ? '启动中…' : 'AI 安装' })] }), _jsxs("span", { className: css.repoMeta, children: [repo.stargazers_count, " \u2605", repo.language === null ? '' : ` · ${repo.language}`] }), repo.description !== null && _jsx("div", { className: css.repoDesc, children: repo.description }), install?.status === 'done' && _jsx("div", { className: css.installOk, role: "status", children: install.message }), install?.status === 'error' && _jsx("div", { className: css.errorText, role: "status", children: install.message })] }, repo.full_name));
                            }) }))] }) }))] }));
}
//# sourceMappingURL=GitHubSearchButton.js.map