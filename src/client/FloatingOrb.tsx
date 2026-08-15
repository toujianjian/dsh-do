import { useCallback, useEffect, useRef, useState } from 'react'
import { AddWorkspaceDialog } from './AddWorkspaceDialog.tsx'
import css from './FloatingOrb.module.css'

/** One GitHub repository search hit (the fields the demo renders). */
interface GitHubRepo {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  language: string | null
}

/** Position of the orb on screen. */
interface OrbPos {
  x: number
  y: number
}

const POS_STORAGE_KEY = 'dsh-do:orb-position'
const ORB_SIZE = 52
const MARGIN = 12

/** Restore the saved orb position, or default to the bottom-right corner. */
function loadPosition(): OrbPos {
  try {
    const raw = localStorage.getItem(POS_STORAGE_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return { x: parsed.x, y: parsed.y }
    }
  } catch {
    /* fall through to the default */
  }
  return { x: window.innerWidth - ORB_SIZE - MARGIN, y: window.innerHeight - ORB_SIZE - MARGIN }
}

/** Clamp the orb inside the viewport. */
function clamp(pos: OrbPos): OrbPos {
  return {
    x: Math.max(MARGIN, Math.min(pos.x, window.innerWidth - ORB_SIZE - MARGIN)),
    y: Math.max(MARGIN, Math.min(pos.y, window.innerHeight - ORB_SIZE - MARGIN)),
  }
}

const SEARCH_QUERY = 'topic:dsh-plugin'

/** Build the install prompt handed to a brand-new session for one repo. */
function installPromptFor(repo: GitHubRepo): string {
  return [
    `请帮我安装 DSH 插件：${repo.full_name}`,
    `仓库：${repo.html_url}`,
    '',
    '步骤：',
    '1. 先确认它是有效的 DSH 插件（package.json 含 dsh.bundle，且 patch/产物完整可加载）；',
    '2. 用 dsh plugin --profile web add github:<owner>/<repo> 安装（若它是 npm 包则用包名）；',
    '3. 验证安装结果（bundle 层已注册、--dump-config 能看到），并告诉我是否需要重启 profile 生效。',
  ].join('\n')
}

/** The "AI install" request state for one repo row. */
interface InstallState {
  readonly name: string
  readonly status: 'working' | 'done' | 'error'
  readonly message?: string
}

/**
 * The dsh-DO floating orb: a neutral black-and-white draggable orb whose panel
 * searches GitHub for `dsh-plugin`-tagged projects; each hit has an "AI
 * install" button that opens a brand-new session pre-filled with an install
 * prompt. It also hosts the right-click "add workspace" dialog.
 * @returns the orb, its panel, and the workspace dialog.
 */
export function FloatingOrb() {
  const [pos, setPos] = useState<OrbPos>(loadPosition)
  const [panelOpen, setPanelOpen] = useState(false)
  const [moved, setMoved] = useState(false)
  const drag = useRef<{ dx: number; dy: number; x: number; y: number } | null>(null)

  const [search, setSearch] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; repos: GitHubRepo[] }>({
    status: 'idle',
    repos: [],
  })
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const persist = useCallback((next: OrbPos) => {
    try {
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* private mode: position just does not survive reload */
    }
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y, x: pos.x, y: pos.y }
    setMoved(false)
  }, [pos])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (current === null) return
    const next = clamp({ x: event.clientX - current.dx, y: event.clientY - current.dy })
    if (Math.abs(next.x - current.x) + Math.abs(next.y - current.y) > 4) setMoved(true)
    current.x = next.x
    current.y = next.y
    setPos(next)
  }, [])

  const onPointerUp = useCallback(() => {
    if (drag.current !== null) {
      persist(pos)
      drag.current = null
    }
  }, [persist, pos])

  const runSearch = useCallback(async () => {
    if (search.status === 'loading') return
    setSearch((current) => ({ ...current, status: 'loading' }))
    try {
      const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(SEARCH_QUERY)}&sort=stars&order=desc&per_page=8`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!response.ok) throw new Error(`GitHub API ${response.status}`)
      const payload = (await response.json()) as { items?: GitHubRepo[] }
      if (!alive.current) return
      setSearch({ status: 'done', repos: payload.items ?? [] })
    } catch (error) {
      if (!alive.current) return
      setSearch({ status: 'error', repos: [] })
    }
  }, [search.status])

  /** Ask the host to open a new session with the install prompt. */
  const aiInstall = useCallback(async (repo: GitHubRepo) => {
    const name = repo.full_name
    setInstalls((current) => ({ ...current, [name]: { name, status: 'working' } }))
    try {
      const response = await fetch('/dsh-do/ai-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt: installPromptFor(repo) }),
      })
      const payload = (await response.json()) as { ok: boolean; error?: string }
      if (!alive.current) return
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setInstalls((current) => ({
        ...current,
        [name]: { name, status: 'done', message: '已在新会话中开始安装' },
      }))
    } catch (error) {
      if (!alive.current) return
      setInstalls((current) => ({
        ...current,
        [name]: { name, status: 'error', message: error instanceof Error ? error.message : String(error) },
      }))
    }
  }, [])

  return (
    <>
      <AddWorkspaceDialog />
      <div className={css.layer} data-dsh-do-orb>
        {panelOpen && (
          <div className={css.panel} role="dialog" aria-label="dsh-DO 插件发现">
            <div className={css.panelHeader}>
              <span className={css.panelTitle}>dsh-DO · 插件发现</span>
              <button type="button" className={css.close} aria-label="关闭面板" onClick={() => { setPanelOpen(false) }}>
                ✕
              </button>
            </div>

            <section className={css.section}>
              <div className={css.sectionTitle}>GitHub 上的 dsh-plugin 项目</div>
              <button
                type="button"
                className={css.searchButton}
                disabled={search.status === 'loading'}
                onClick={() => { void runSearch() }}
              >
                {search.status === 'loading' ? '搜索中…' : '搜索 GitHub'}
              </button>

              {search.status === 'error' && (
                <div className={css.errorText}>搜索失败（GitHub API 限流或网络问题），稍后再试。</div>
              )}
              {search.status === 'done' && search.repos.length === 0 && (
                <div className={css.muted}>没有找到带 dsh-plugin 标签的项目</div>
              )}

              {search.status === 'done' && search.repos.length > 0 && (
                <ul className={css.repoList}>
                  {search.repos.map((repo) => {
                    const install = installs[repo.full_name]
                    return (
                      <li key={repo.full_name} className={css.repoItem}>
                        <div className={css.repoTop}>
                          <a className={css.repoName} href={repo.html_url} target="_blank" rel="noreferrer">
                            {repo.full_name}
                          </a>
                          <button
                            type="button"
                            className={css.aiInstall}
                            disabled={install?.status === 'working'}
                            onClick={() => { void aiInstall(repo) }}
                          >
                            {install?.status === 'working' ? '启动中…' : 'AI 安装'}
                          </button>
                        </div>
                        <span className={css.repoMeta}>
                          {repo.stargazers_count} ★{repo.language === null ? '' : ` · ${repo.language}`}
                        </span>
                        {repo.description !== null && <div className={css.repoDesc}>{repo.description}</div>}
                        {install?.status === 'done' && (
                          <div className={css.installOk} role="status">{install.message}</div>
                        )}
                        {install?.status === 'error' && (
                          <div className={css.errorText} role="status">{install.message}</div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
        )}

        <button
          type="button"
          className={css.orb}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
          aria-label="dsh-DO 插件发现"
          aria-expanded={panelOpen}
          onClick={() => {
            if (!moved) setPanelOpen((open) => !open)
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <span className={css.orbText}>DO</span>
        </button>
      </div>
    </>
  )
}
