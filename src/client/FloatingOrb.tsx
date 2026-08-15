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

/** One plugin entry from the dshplugin.app registry proxy. */
interface RegistryEntry {
  slug: string
  name: string
  repository?: string
  repositoryUrl?: string
  description?: string
  categories: string[]
  installCommand?: string
  status?: string
  profile?: string
  license?: string
  packageName: string
  version?: string
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
const REGISTRY_DISPLAY_LIMIT = 10

/**
 * The dsh-DO floating orb: a neutral black-and-white draggable orb whose panel
 * discovers harness plugins from two sources — a real GitHub search for
 * `dsh-plugin`-tagged projects and the dshplugin.app registry proxy — mixed
 * into one list with a per-item source badge. It also hosts the right-click
 * "add workspace" dialog.
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
  const [registry, setRegistry] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; plugins: RegistryEntry[] }>({
    status: 'idle',
    plugins: [],
  })
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

  const runRegistryFetch = useCallback(async () => {
    if (registry.status === 'loading') return
    setRegistry((current) => ({ ...current, status: 'loading' }))
    try {
      const response = await fetch('/dsh-do/registry', { headers: { Accept: 'application/json' } })
      const payload = (await response.json()) as { ok: boolean; plugins?: RegistryEntry[] }
      if (!alive.current) return
      if (!response.ok || payload.ok !== true) throw new Error(`registry proxy ${response.status}`)
      setRegistry({ status: 'done', plugins: payload.plugins ?? [] })
    } catch (error) {
      if (!alive.current) return
      setRegistry({ status: 'error', plugins: [] })
    }
  }, [registry.status])

  const bothIdle = search.status === 'idle' && registry.status === 'idle'
  const githubShown = search.status === 'done' && search.repos.length > 0
  const registryShown = registry.status === 'done' && registry.plugins.length > 0

  return (
    <>
      <AddWorkspaceDialog />
      <div className={css.layer} data-dsh-do-orb>
        {panelOpen && (
          <div className={css.panel} role="dialog" aria-label="dsh-DO 建议面板">
            <div className={css.panelHeader}>
              <span className={css.panelTitle}>dsh-DO · 插件发现</span>
              <button type="button" className={css.close} aria-label="关闭面板" onClick={() => { setPanelOpen(false) }}>
                ✕
              </button>
            </div>

            <section className={css.section}>
              <div className={css.sectionTitle}>安装建议（GitHub + dshplugin.app）</div>
              <div className={css.discoverActions}>
                <button
                  type="button"
                  className={css.searchButton}
                  disabled={search.status === 'loading'}
                  onClick={() => { void runSearch() }}
                >
                  {search.status === 'loading' ? '搜索中…' : '搜索 GitHub'}
                </button>
                <button
                  type="button"
                  className={css.searchButtonAlt}
                  disabled={registry.status === 'loading'}
                  onClick={() => { void runRegistryFetch() }}
                >
                  {registry.status === 'loading' ? '抓取中…' : '抓取 dshplugin.app'}
                </button>
              </div>

              {search.status === 'error' && (
                <div className={css.errorText}>GitHub 搜索失败（API 限流或网络问题），稍后再试。</div>
              )}
              {registry.status === 'error' && (
                <div className={css.errorText}>dshplugin.app 抓取失败（代理或站点不可用），稍后再试。</div>
              )}
              {search.status === 'done' && search.repos.length === 0 && (
                <div className={css.muted}>GitHub 上没有找到带 dsh-plugin 标签的项目</div>
              )}
              {registry.status === 'done' && registry.plugins.length === 0 && (
                <div className={css.muted}>dshplugin.app 目录为空，或站点结构已变化</div>
              )}

              {!bothIdle && (githubShown || registryShown) && (
                <ul className={css.discoverList}>
                  {githubShown && search.repos.map((repo) => (
                    <li key={`gh:${repo.full_name}`} className={css.discoverItem}>
                      <span className={`${css.sourceBadge} ${css.sourceGh}`}>GitHub</span>
                      <a className={css.discoverName} href={repo.html_url} target="_blank" rel="noreferrer">
                        {repo.full_name}
                      </a>
                      <span className={css.discoverMeta}>
                        {repo.stargazers_count} ★{repo.language === null ? '' : ` · ${repo.language}`}
                      </span>
                      {repo.description !== null && <div className={css.discoverDesc}>{repo.description}</div>}
                    </li>
                  ))}
                  {registryShown && registry.plugins.slice(0, REGISTRY_DISPLAY_LIMIT).map((plugin) => (
                    <li key={`app:${plugin.packageName}`} className={css.discoverItem}>
                      <span className={`${css.sourceBadge} ${css.sourceApp}`}>dshplugin.app</span>
                      <a
                        className={css.discoverName}
                        href={plugin.repositoryUrl ?? undefined}
                        target={plugin.repositoryUrl === undefined ? undefined : '_blank'}
                        rel="noreferrer"
                      >
                        {plugin.name}
                      </a>
                      {plugin.categories.length > 0 && (
                        <span className={css.discoverCats}>
                          {plugin.categories.slice(0, 3).map((cat) => (
                            <span key={cat} className={css.discoverCat}>{cat}</span>
                          ))}
                        </span>
                      )}
                      {plugin.description !== undefined && <div className={css.discoverDesc}>{plugin.description}</div>}
                      {plugin.installCommand !== undefined && plugin.installCommand.length > 0 && (
                        <code className={css.discoverInstall}>{plugin.installCommand}</code>
                      )}
                    </li>
                  ))}
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
