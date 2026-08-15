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

/** Static install-advice cards shown in the panel (demo copy). */
const ADVICE = [
  { title: '官方插件', body: 'npx -p @deepseek-ai/dsh dsh plugin --profile web add <包名>，重启 profile 生效。' },
  { title: '本地开发', body: 'pnpm pack 打出 tarball，再 dsh plugin add ./xxx.tgz；改完重新 pack + 重启。' },
  { title: '安全提示', body: '只安装信任的仓库；Git 依赖会执行 prepare 脚本，安装前先审查。' },
] as const

const SEARCH_QUERY = 'topic:dsh-plugin'

/**
 * The dsh-DO floating orb: draggable, click to open the suggestion panel
 * (static install advice + a real GitHub search for `dsh-plugin`-tagged
 * projects), and hosts the right-click "add workspace" dialog.
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

  return (
    <>
      <AddWorkspaceDialog />
      <div className={css.layer} data-dsh-do-orb>
        {panelOpen && (
          <div className={css.panel} role="dialog" aria-label="dsh-DO 建议面板">
            <div className={css.panelHeader}>
              <span className={css.panelTitle}>dsh-DO · Detail Optimization</span>
              <button type="button" className={css.close} aria-label="关闭面板" onClick={() => { setPanelOpen(false) }}>
                ✕
              </button>
            </div>

            <section className={css.section}>
              <div className={css.sectionTitle}>harness 插件安装建议</div>
              {ADVICE.map((item) => (
                <div key={item.title} className={css.adviceCard}>
                  <div className={css.adviceTitle}>{item.title}</div>
                  <div className={css.adviceBody}>{item.body}</div>
                </div>
              ))}
            </section>

            <section className={css.section}>
              <div className={css.sectionTitle}>GitHub 上的 dsh-plugin 项目</div>
              <button
                type="button"
                className={css.searchButton}
                disabled={search.status === 'loading'}
                onClick={() => { void runSearch() }}
              >
                {search.status === 'loading' ? '搜索中…' : `搜索 GitHub（topic: ${SEARCH_QUERY.replace('topic:', '')}）`}
              </button>
              {search.status === 'done' && search.repos.length === 0 && (
                <div className={css.muted}>没有找到带 dsh-plugin 标签的项目</div>
              )}
              {search.status === 'error' && (
                <div className={css.errorText}>搜索失败（GitHub API 限流或网络问题），稍后再试。</div>
              )}
              {search.status === 'done' && search.repos.length > 0 && (
                <ul className={css.repoList}>
                  {search.repos.map((repo) => (
                    <li key={repo.full_name}>
                      <a className={css.repoLink} href={repo.html_url} target="_blank" rel="noreferrer">
                        <span className={css.repoName}>{repo.full_name}</span>
                        <span className={css.repoMeta}>
                          {repo.stargazers_count} ★{repo.language === null ? '' : ` · ${repo.language}`}
                        </span>
                      </a>
                      {repo.description !== null && <div className={css.repoDesc}>{repo.description}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={css.section}>
              <div className={css.sectionTitle}>dshplugin.app 插件目录</div>
              <button
                type="button"
                className={css.searchButton}
                disabled={registry.status === 'loading'}
                onClick={() => { void runRegistryFetch() }}
              >
                {registry.status === 'loading' ? '抓取中…' : '抓取 dshplugin.app 目录'}
              </button>
              {registry.status === 'done' && registry.plugins.length === 0 && (
                <div className={css.muted}>目录为空，或站点结构已变化</div>
              )}
              {registry.status === 'error' && (
                <div className={css.errorText}>抓取失败（dshplugin.app 或代理不可用），稍后再试。</div>
              )}
              {registry.status === 'done' && registry.plugins.length > 0 && (
                <div className={css.registryMeta}>共 {registry.plugins.length} 个插件（来自 dshplugin.app）</div>
              )}
              {registry.status === 'done' && registry.plugins.length > 0 && (
                <ul className={css.registryList}>
                  {registry.plugins.slice(0, 10).map((plugin) => (
                    <li key={plugin.packageName} className={css.registryItem}>
                      <a
                        className={css.registryName}
                        href={plugin.repositoryUrl ?? undefined}
                        target={plugin.repositoryUrl === undefined ? undefined : '_blank'}
                        rel="noreferrer"
                      >
                        {plugin.name}
                      </a>
                      {plugin.categories.length > 0 && (
                        <span className={css.registryCats}>
                          {plugin.categories.slice(0, 3).map((cat) => (
                            <span key={cat} className={css.registryCat}>{cat}</span>
                          ))}
                        </span>
                      )}
                      {plugin.description !== undefined && <div className={css.registryDesc}>{plugin.description}</div>}
                      {plugin.installCommand !== undefined && plugin.installCommand.length > 0 && (
                        <code className={css.registryInstall}>{plugin.installCommand}</code>
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
          aria-label="dsh-DO 建议"
          aria-expanded={panelOpen}
          onClick={() => {
            if (!moved) setPanelOpen((open) => !open)
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <span className={css.orbText}>DO</span>
          <span className={css.orbGlow} aria-hidden="true" />
        </button>
      </div>
    </>
  )
}
