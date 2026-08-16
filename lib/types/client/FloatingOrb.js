import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { AddWorkspaceDialog } from "./AddWorkspaceDialog.js";
import css from './FloatingOrb.module.css';
const POS_STORAGE_KEY = 'dsh-do:orb-position';
const ORB_SIZE = 52;
const MARGIN = 12;
/** Restore the saved orb position, or default to the bottom-right corner. */
function loadPosition() {
    try {
        const raw = localStorage.getItem(POS_STORAGE_KEY);
        if (raw !== null) {
            const parsed = JSON.parse(raw);
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number')
                return { x: parsed.x, y: parsed.y };
        }
    }
    catch {
        /* fall through to the default */
    }
    return { x: window.innerWidth - ORB_SIZE - MARGIN, y: window.innerHeight - ORB_SIZE - MARGIN };
}
/** Clamp the orb inside the viewport. */
function clamp(pos) {
    return {
        x: Math.max(MARGIN, Math.min(pos.x, window.innerWidth - ORB_SIZE - MARGIN)),
        y: Math.max(MARGIN, Math.min(pos.y, window.innerHeight - ORB_SIZE - MARGIN)),
    };
}
const SEARCH_QUERY = 'topic:dsh-plugin';
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
 * The dsh-DO floating orb: a neutral black-and-white draggable orb whose panel
 * searches GitHub for `dsh-plugin`-tagged projects; each hit has an "AI
 * install" button that opens a brand-new session pre-filled with an install
 * prompt. It also hosts the right-click "add workspace" dialog.
 * @returns the orb, its panel, and the workspace dialog.
 */
export function FloatingOrb() {
    const [pos, setPos] = useState(loadPosition);
    const [panelOpen, setPanelOpen] = useState(false);
    const [moved, setMoved] = useState(false);
    const drag = useRef(null);
    const [search, setSearch] = useState({
        status: 'idle',
        repos: [],
    });
    const [installs, setInstalls] = useState({});
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    const persist = useCallback((next) => {
        try {
            localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(next));
        }
        catch {
            /* private mode: position just does not survive reload */
        }
    }, []);
    const onPointerDown = useCallback((event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y, x: pos.x, y: pos.y };
        setMoved(false);
    }, [pos]);
    const onPointerMove = useCallback((event) => {
        const current = drag.current;
        if (current === null)
            return;
        const next = clamp({ x: event.clientX - current.dx, y: event.clientY - current.dy });
        if (Math.abs(next.x - current.x) + Math.abs(next.y - current.y) > 4)
            setMoved(true);
        current.x = next.x;
        current.y = next.y;
        setPos(next);
    }, []);
    const onPointerUp = useCallback(() => {
        if (drag.current !== null) {
            persist(pos);
            drag.current = null;
        }
    }, [persist, pos]);
    const runSearch = useCallback(async () => {
        if (search.status === 'loading')
            return;
        setSearch((current) => ({ ...current, status: 'loading' }));
        try {
            const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(SEARCH_QUERY)}&sort=stars&order=desc&per_page=8`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
            if (!response.ok)
                throw new Error(`GitHub API ${response.status}`);
            const payload = (await response.json());
            if (!alive.current)
                return;
            setSearch({ status: 'done', repos: payload.items ?? [] });
        }
        catch (error) {
            if (!alive.current)
                return;
            setSearch({ status: 'error', repos: [] });
        }
    }, [search.status]);
    /** Ask the host to open a new session with the install prompt. */
    const aiInstall = useCallback(async (repo) => {
        const name = repo.full_name;
        setInstalls((current) => ({ ...current, [name]: { name, status: 'working' } }));
        try {
            const response = await fetch('/dsh-do/ai-install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ prompt: installPromptFor(repo) }),
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
    return (_jsxs(_Fragment, { children: [_jsx(AddWorkspaceDialog, {}), _jsxs("div", { className: css.layer, "data-dsh-do-orb": true, children: [panelOpen && (_jsxs("div", { className: css.panel, role: "dialog", "aria-label": "dsh-DO \u63D2\u4EF6\u53D1\u73B0", children: [_jsxs("div", { className: css.panelHeader, children: [_jsx("span", { className: css.panelTitle, children: "dsh-DO \u00B7 \u63D2\u4EF6\u53D1\u73B0" }), _jsx("button", { type: "button", className: css.close, "aria-label": "\u5173\u95ED\u9762\u677F", onClick: () => { setPanelOpen(false); }, children: "\u2715" })] }), _jsxs("section", { className: css.section, children: [_jsx("div", { className: css.sectionTitle, children: "GitHub \u4E0A\u7684 dsh-plugin \u9879\u76EE" }), _jsx("button", { type: "button", className: css.searchButton, disabled: search.status === 'loading', onClick: () => { void runSearch(); }, children: search.status === 'loading' ? '搜索中…' : '搜索 GitHub' }), search.status === 'error' && (_jsx("div", { className: css.errorText, children: "\u641C\u7D22\u5931\u8D25\uFF08GitHub API \u9650\u6D41\u6216\u7F51\u7EDC\u95EE\u9898\uFF09\uFF0C\u7A0D\u540E\u518D\u8BD5\u3002" })), search.status === 'done' && search.repos.length === 0 && (_jsx("div", { className: css.muted, children: "\u6CA1\u6709\u627E\u5230\u5E26 dsh-plugin \u6807\u7B7E\u7684\u9879\u76EE" })), search.status === 'done' && search.repos.length > 0 && (_jsx("ul", { className: css.repoList, children: search.repos.map((repo) => {
                                            const install = installs[repo.full_name];
                                            return (_jsxs("li", { className: css.repoItem, children: [_jsxs("div", { className: css.repoTop, children: [_jsx("a", { className: css.repoName, href: repo.html_url, target: "_blank", rel: "noreferrer", children: repo.full_name }), _jsx("button", { type: "button", className: css.aiInstall, disabled: install?.status === 'working', onClick: () => { void aiInstall(repo); }, children: install?.status === 'working' ? '启动中…' : 'AI 安装' })] }), _jsxs("span", { className: css.repoMeta, children: [repo.stargazers_count, " \u2605", repo.language === null ? '' : ` · ${repo.language}`] }), repo.description !== null && _jsx("div", { className: css.repoDesc, children: repo.description }), install?.status === 'done' && (_jsx("div", { className: css.installOk, role: "status", children: install.message })), install?.status === 'error' && (_jsx("div", { className: css.errorText, role: "status", children: install.message }))] }, repo.full_name));
                                        }) }))] })] })), _jsx("button", { type: "button", className: css.orb, style: { transform: `translate(${pos.x}px, ${pos.y}px)` }, "aria-label": "dsh-DO \u63D2\u4EF6\u53D1\u73B0", "aria-expanded": panelOpen, onClick: () => {
                            if (!moved)
                                setPanelOpen((open) => !open);
                        }, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerUp, children: _jsx("span", { className: css.orbText, children: "DO" }) })] })] }));
}
//# sourceMappingURL=FloatingOrb.js.map