import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { closeAddWorkspaceDialog, getAddWorkspaceDialogState, getWorkspacesService, isCurrentWorkspaceDialog, subscribeAddWorkspaceDialog, } from "./addWorkspace.js";
import css from './AddWorkspaceDialog.module.css';
/** Dialog width used to clamp the anchor so the dialog stays on screen. */
const DIALOG_WIDTH = 340;
/**
 * The "add workspace" dialog opened by a right-click on the sidebar's native
 * add-workspace button: paste any directory path (Windows or POSIX), submit,
 * and the host registers it as a real Workspace via `ctx.workspaces.create`.
 * @returns the dialog, or null while closed.
 */
export function AddWorkspaceDialog() {
    const state = useSyncExternalStore(subscribeAddWorkspaceDialog, getAddWorkspaceDialogState);
    const [value, setValue] = useState('');
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState(null);
    const [mobile, setMobile] = useState(false);
    const inputRef = useRef(null);
    const request = useRef(undefined);
    useEffect(() => () => { request.current = undefined; }, []);
    useEffect(() => {
        request.current = undefined;
        setPending(false);
        if (!state.open)
            return;
        setValue('');
        setFailure(null);
        // Re-evaluate the viewport class each time the dialog opens, so a phone
        // gets the full-width bottom sheet while a desktop keeps the anchor popup.
        setMobile(window.matchMedia('(max-width: 480px)').matches);
        // Focus and select after the dialog mounts so paste is one key away.
        const frame = requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
        });
        const onKeyDown = (event) => {
            if (event.key === 'Escape')
                closeAddWorkspaceDialog();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [state]);
    const submit = useCallback(async () => {
        if (request.current !== undefined || !isCurrentWorkspaceDialog(state))
            return;
        const path = value.trim();
        if (path.length === 0) {
            setFailure('请输入一个目录路径（Windows 如 C:\\work\\repo，POSIX 如 /home/user/repo）');
            return;
        }
        const workspaces = getWorkspacesService();
        if (workspaces === undefined) {
            setFailure('workspaces 服务尚未就绪，请稍后再试');
            return;
        }
        const token = Symbol('workspace-request');
        request.current = token;
        const current = () => request.current === token && isCurrentWorkspaceDialog(state);
        setPending(true);
        setFailure(null);
        try {
            await workspaces.create({ path });
            if (current())
                closeAddWorkspaceDialog();
        }
        catch (error) {
            if (current()) {
                const message = error instanceof Error ? error.message : String(error);
                setFailure(`添加失败：${message}`);
            }
        }
        finally {
            if (current())
                setPending(false);
            if (request.current === token)
                request.current = undefined;
        }
    }, [value, state]);
    if (!state.open)
        return null;
    const left = mobile ? undefined : Math.max(8, Math.min(state.x, window.innerWidth - DIALOG_WIDTH - 8));
    const top = mobile ? undefined : Math.max(8, Math.min(state.y, window.innerHeight - 180));
    return (_jsx("div", { className: css.backdrop, role: "presentation", onPointerDown: (event) => {
            // Click outside the card closes the dialog.
            if (event.target === event.currentTarget)
                closeAddWorkspaceDialog();
        }, children: _jsxs("form", { className: mobile ? css.cardMobile : css.card, style: mobile ? undefined : { left, top }, role: "dialog", "aria-label": "\u6DFB\u52A0\u5DE5\u4F5C\u533A", onSubmit: (event) => {
                event.preventDefault();
                void submit();
            }, children: [_jsx("div", { className: css.heading, children: "\u6DFB\u52A0\u5DE5\u4F5C\u533A" }), _jsx("div", { className: css.hint, children: "\u7C98\u8D34\u76EE\u5F55\u8DEF\u5F84\uFF08\u591A\u7CFB\u7EDF\u517C\u5BB9\uFF1AWindows \u6216 POSIX \u8DEF\u5F84\u5747\u53EF\uFF09\uFF0C\u56DE\u8F66\u786E\u8BA4\u3002" }), _jsx("input", { ref: inputRef, className: css.input, type: "text", spellCheck: false, placeholder: "C:\\work\\repo \u6216 /home/user/repo", value: value, disabled: pending, onChange: (event) => { setValue(event.target.value); } }), failure !== null && _jsx("div", { className: css.failure, role: "status", children: failure }), _jsxs("div", { className: css.actions, children: [_jsx("button", { type: "button", className: css.cancel, disabled: pending, onClick: closeAddWorkspaceDialog, children: "\u53D6\u6D88" }), _jsx("button", { type: "submit", className: css.submit, disabled: pending || value.trim().length === 0, children: pending ? '添加中…' : '添加' })] })] }) }));
}
//# sourceMappingURL=AddWorkspaceDialog.js.map