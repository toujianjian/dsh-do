import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  closeAddWorkspaceDialog,
  getAddWorkspaceDialogState,
  getWorkspacesService,
  isCurrentWorkspaceDialog,
  subscribeAddWorkspaceDialog,
} from './addWorkspace.ts'
import css from './AddWorkspaceDialog.module.css'

/** Dialog width used to clamp the anchor so the dialog stays on screen. */
const DIALOG_WIDTH = 340

/**
 * The "add workspace" dialog opened by a right-click on the sidebar's native
 * add-workspace button: paste any directory path (Windows or POSIX), submit,
 * and the host registers it as a real Workspace via `ctx.workspaces.create`.
 * @returns the dialog, or null while closed.
 */
export function AddWorkspaceDialog() {
  const state = useSyncExternalStore(subscribeAddWorkspaceDialog, getAddWorkspaceDialogState)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [mobile, setMobile] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const request = useRef<symbol | undefined>(undefined)
  useEffect(() => () => { request.current = undefined }, [])

  useEffect(() => {
    request.current = undefined
    setPending(false)
    if (!state.open) return
    setValue('')
    setFailure(null)
    // Re-evaluate the viewport class each time the dialog opens, so a phone
    // gets the full-width bottom sheet while a desktop keeps the anchor popup.
    setMobile(window.matchMedia('(max-width: 480px)').matches)
    // Focus and select after the dialog mounts so paste is one key away.
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAddWorkspaceDialog()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [state])

  const submit = useCallback(async () => {
    if (request.current !== undefined || !isCurrentWorkspaceDialog(state)) return
    const path = value.trim()
    if (path.length === 0) {
      setFailure('请输入一个目录路径（Windows 如 C:\\work\\repo，POSIX 如 /home/user/repo）')
      return
    }
    const workspaces = getWorkspacesService()
    if (workspaces === undefined) {
      setFailure('workspaces 服务尚未就绪，请稍后再试')
      return
    }
    const token = Symbol('workspace-request')
    request.current = token
    const current = () => request.current === token && isCurrentWorkspaceDialog(state)
    setPending(true)
    setFailure(null)
    try {
      await workspaces.create({ path })
      if (current()) closeAddWorkspaceDialog()
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : String(error)
        setFailure(`添加失败：${message}`)
      }
    } finally {
      if (current()) setPending(false)
      if (request.current === token) request.current = undefined
    }
  }, [value, state])

  if (!state.open) return null

  const left = mobile ? undefined : Math.max(8, Math.min(state.x, window.innerWidth - DIALOG_WIDTH - 8))
  const top = mobile ? undefined : Math.max(8, Math.min(state.y, window.innerHeight - 180))

  return (
    <div
      className={css.backdrop}
      role="presentation"
      onPointerDown={(event) => {
        // Click outside the card closes the dialog.
        if (event.target === event.currentTarget) closeAddWorkspaceDialog()
      }}
    >
      <form
        className={mobile ? css.cardMobile : css.card}
        style={mobile ? undefined : { left, top }}
        role="dialog"
        aria-label="添加工作区"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className={css.heading}>添加工作区</div>
        <div className={css.hint}>
          粘贴目录路径（多系统兼容：Windows 或 POSIX 路径均可），回车确认。
        </div>
        <input
          ref={inputRef}
          className={css.input}
          type="text"
          spellCheck={false}
          placeholder="C:\work\repo 或 /home/user/repo"
          value={value}
          disabled={pending}
          onChange={(event) => { setValue(event.target.value) }}
        />
        {failure !== null && <div className={css.failure} role="status">{failure}</div>}
        <div className={css.actions}>
          <button
            type="button"
            className={css.cancel}
            disabled={pending}
            onClick={closeAddWorkspaceDialog}
          >
            取消
          </button>
          <button type="submit" className={css.submit} disabled={pending || value.trim().length === 0}>
            {pending ? '添加中…' : '添加'}
          </button>
        </div>
      </form>
    </div>
  )
}
