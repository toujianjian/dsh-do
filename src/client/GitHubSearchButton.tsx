import { useCallback, useEffect, useRef, useState } from 'react'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AddWorkspaceDialog } from './AddWorkspaceDialog.tsx'
import css from './GitHubSearch.module.css'

/** One GitHub repository search hit. */
interface GitHubRepo {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  language: string | null
}

/** One npm plugin search hit. */
interface NpmPlugin {
  name: string
  version: string
  description: string
  repository?: string
}

/** Which discovery source the panel is searching. */
type Tab = 'projects' | 'plugins'

const SEARCH_QUERY = 'topic:dsh-plugin'

/** GitHub Octocat mark (official path, rendered in the current text color). */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}

/** Build the install prompt for a GitHub repository. */
function installPromptForRepo(repo: GitHubRepo): string {
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

/** Build the install prompt for an npm plugin package. */
function installPromptForNpm(plugin: NpmPlugin): string {
  return [
    `请帮我安装 DSH 插件：${plugin.name}`,
    `npm 包：https://www.npmjs.com/package/${plugin.name}`,
    ...(plugin.repository === undefined ? [] : [`仓库：${plugin.repository}`]),
    '',
    '步骤：',
    '1. 用 dsh plugin --profile web add <name> 安装（name 为上面的 npm 包名）；',
    '2. 验证安装结果（bundle 层已注册、--dump-config 能看到），并告诉我是否需要重启 profile 生效。',
  ].join('\n')
}

/** The "AI install" request state for one entry. */
interface InstallState {
  readonly name: string
  readonly status: 'working' | 'done' | 'error'
  readonly message?: string
}

/**
 * Sidebar GitHub button: opens a search panel with two tabs — "项目" (GitHub
 * `dsh-plugin` repositories, default) and "插件" (npm packages tagged
 * `dsh-plugin`) — each hit carrying an "AI install" button that opens a
 * brand-new session pre-filled with an install prompt. The right-click "add
 * workspace" dialog rides along.
 * @param props - the sidebar footer action owner share (`wide` = expanded sidebar).
 * @returns the footer button, its search panel, and the workspace dialog.
 */
export function GitHubSearchButton({ wide }: SidebarFooterActionOwnerProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('projects')
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; repos: GitHubRepo[] }>({
    status: 'idle',
    repos: [],
  })
  const [plugins, setPlugins] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; plugins: NpmPlugin[] }>({
    status: 'idle',
    plugins: [],
  })
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const runProjectsSearch = useCallback(async (rawQuery: string) => {
    setProjects((current) => ({ ...current, status: 'loading' }))
    try {
      const terms = rawQuery.trim()
      const q = terms.length === 0 ? SEARCH_QUERY : `${SEARCH_QUERY} ${terms}`
      const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!response.ok) throw new Error(`GitHub API ${response.status}`)
      const payload = (await response.json()) as { items?: GitHubRepo[] }
      if (!alive.current) return
      setProjects({ status: 'done', repos: payload.items ?? [] })
    } catch (error) {
      if (!alive.current) return
      setProjects({ status: 'error', repos: [] })
    }
  }, [])

  const runPluginsSearch = useCallback(async (rawQuery: string) => {
    setPlugins((current) => ({ ...current, status: 'loading' }))
    try {
      const terms = rawQuery.trim()
      const text = terms.length === 0 ? 'keywords:dsh-plugin' : `keywords:dsh-plugin ${terms}`
      const response = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=8`)
      if (!response.ok) throw new Error(`npm registry ${response.status}`)
      const payload = (await response.json()) as {
        objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown; links?: { repository?: unknown } } }>
      }
      if (!alive.current) return
      const plugins = (payload.objects ?? [])
        .map((entry) => entry.package)
        .filter((pkg): pkg is NonNullable<typeof pkg> => pkg !== undefined && typeof pkg.name === 'string' && pkg.name.length > 0)
        .map((pkg) => ({
          name: pkg.name as string,
          version: typeof pkg.version === 'string' ? pkg.version : '',
          description: typeof pkg.description === 'string' ? pkg.description : '',
          ...(typeof pkg.links?.repository === 'string' ? { repository: pkg.links.repository } : {}),
        }))
      setPlugins({ status: 'done', plugins })
    } catch (error) {
      if (!alive.current) return
      setPlugins({ status: 'error', plugins: [] })
    }
  }, [])

  /** Ask the host to open a new session with the install prompt. */
  const aiInstall = useCallback(async (name: string, prompt: string) => {
    setInstalls((current) => ({ ...current, [name]: { name, status: 'working' } }))
    try {
      const response = await fetch('/dsh-do/ai-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt }),
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

  const submit = useCallback(() => {
    if (tab === 'projects') void runProjectsSearch(query)
    else void runPluginsSearch(query)
  }, [tab, query, runProjectsSearch, runPluginsSearch])

  const projectsBusy = projects.status === 'loading'
  const pluginsBusy = plugins.status === 'loading'

  return (
    <>
      <AddWorkspaceDialog />
      <button
        type="button"
        className={css.footerButton}
        aria-label="GitHub 插件搜索"
        aria-expanded={open}
        title="插件发现（GitHub 项目 / npm 插件）"
        onClick={() => { setOpen((current) => !current) }}
      >
        <GitHubIcon />
        {wide && <span className={css.footerLabel}>发现</span>}
      </button>

      {open && (
        <div
          className={css.panelBackdrop}
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div className={css.panel} role="dialog" aria-label="插件发现">
            <div className={css.panelHeader}>
              <span className={css.panelTitle}>插件发现</span>
              <button type="button" className={css.close} aria-label="关闭" onClick={() => { setOpen(false) }}>
                ✕
              </button>
            </div>

            <div className={css.tabs} role="tablist" aria-label="搜索来源">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'projects'}
                className={tab === 'projects' ? css.tabActive : css.tab}
                onClick={() => { setTab('projects') }}
              >
                项目
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'plugins'}
                className={tab === 'plugins' ? css.tabActive : css.tab}
                onClick={() => { setTab('plugins') }}
              >
                插件
              </button>
            </div>

            <form
              className={css.searchRow}
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <input
                className={css.searchInput}
                type="text"
                spellCheck={false}
                placeholder={tab === 'projects' ? '搜 GitHub 项目（留空 = topic:dsh-plugin）' : '搜 npm 插件（留空 = keywords:dsh-plugin）'}
                value={query}
                onChange={(event) => { setQuery(event.target.value) }}
              />
              <button type="submit" className={css.searchButton} disabled={projectsBusy || pluginsBusy}>
                {(projectsBusy || pluginsBusy) ? '搜索中…' : '搜索'}
              </button>
            </form>

            {tab === 'projects' && projects.status === 'idle' && (
              <div className={css.muted}>GitHub 上带 dsh-plugin 标签的项目（可加关键词过滤）。</div>
            )}
            {tab === 'projects' && projects.status === 'error' && (
              <div className={css.errorText}>搜索失败（GitHub API 限流或网络问题），稍后再试。</div>
            )}
            {tab === 'projects' && projects.status === 'done' && projects.repos.length === 0 && (
              <div className={css.muted}>没有找到匹配的 dsh-plugin 项目</div>
            )}

            {tab === 'plugins' && plugins.status === 'idle' && (
              <div className={css.muted}>npm 上标了 keywords:dsh-plugin 的插件包（可加关键词过滤）。</div>
            )}
            {tab === 'plugins' && plugins.status === 'error' && (
              <div className={css.errorText}>搜索失败（npm registry 不可用），稍后再试。</div>
            )}
            {tab === 'plugins' && plugins.status === 'done' && plugins.plugins.length === 0 && (
              <div className={css.muted}>没有找到匹配的 dsh 插件包</div>
            )}

            {tab === 'projects' && projects.status === 'done' && projects.repos.length > 0 && (
              <ul className={css.repoList}>
                {projects.repos.map((repo) => {
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
                          onClick={() => { void aiInstall(repo.full_name, installPromptForRepo(repo)) }}
                        >
                          {install?.status === 'working' ? '启动中…' : 'AI 安装'}
                        </button>
                      </div>
                      <span className={css.repoMeta}>
                        {repo.stargazers_count} ★{repo.language === null ? '' : ` · ${repo.language}`}
                      </span>
                      {repo.description !== null && <div className={css.repoDesc}>{repo.description}</div>}
                      {install?.status === 'done' && <div className={css.installOk} role="status">{install.message}</div>}
                      {install?.status === 'error' && <div className={css.errorText} role="status">{install.message}</div>}
                    </li>
                  )
                })}
              </ul>
            )}

            {tab === 'plugins' && plugins.status === 'done' && plugins.plugins.length > 0 && (
              <ul className={css.repoList}>
                {plugins.plugins.map((plugin) => {
                  const install = installs[plugin.name]
                  return (
                    <li key={plugin.name} className={css.repoItem}>
                      <div className={css.repoTop}>
                        <a
                          className={css.repoName}
                          href={plugin.repository ?? `https://www.npmjs.com/package/${plugin.name}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {plugin.name}
                        </a>
                        <button
                          type="button"
                          className={css.aiInstall}
                          disabled={install?.status === 'working'}
                          onClick={() => { void aiInstall(plugin.name, installPromptForNpm(plugin)) }}
                        >
                          {install?.status === 'working' ? '启动中…' : 'AI 安装'}
                        </button>
                      </div>
                      {plugin.version.length > 0 && <span className={css.repoMeta}>v{plugin.version}</span>}
                      {plugin.description.length > 0 && <div className={css.repoDesc}>{plugin.description}</div>}
                      {install?.status === 'done' && <div className={css.installOk} role="status">{install.message}</div>}
                      {install?.status === 'error' && <div className={css.errorText} role="status">{install.message}</div>}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  )
}
