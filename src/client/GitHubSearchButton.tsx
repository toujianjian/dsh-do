import { useCallback, useEffect, useRef, useState } from 'react'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AddWorkspaceDialog } from './AddWorkspaceDialog.tsx'
import css from './GitHubSearch.module.css'

/** One GitHub repository search hit (the fields the demo renders). */
interface GitHubRepo {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  language: string | null
}

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
 * Sidebar GitHub button: opens a search panel over GitHub's `dsh-plugin`
 * tagged repositories (free-text filter optional), each hit carrying an "AI
 * install" button that opens a brand-new session pre-filled with an install
 * prompt. The right-click "add workspace" dialog rides along.
 * @param props - the sidebar footer action owner share (`wide` = expanded sidebar).
 * @returns the footer button, its search panel, and the workspace dialog.
 */
export function GitHubSearchButton({ wide }: SidebarFooterActionOwnerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; repos: GitHubRepo[] }>({
    status: 'idle',
    repos: [],
  })
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const runSearch = useCallback(async (rawQuery: string) => {
    setSearch((current) => ({ ...current, status: 'loading' }))
    try {
      const terms = rawQuery.trim()
      const q = terms.length === 0 ? SEARCH_QUERY : `${SEARCH_QUERY} ${terms}`
      const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, {
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
  }, [])

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
      <button
        type="button"
        className={css.footerButton}
        aria-label="GitHub 插件搜索"
        aria-expanded={open}
        title="GitHub 插件搜索"
        onClick={() => { setOpen((current) => !current) }}
      >
        <GitHubIcon />
        {wide && <span className={css.footerLabel}>GitHub</span>}
      </button>

      {open && (
        <div
          className={css.panelBackdrop}
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div className={css.panel} role="dialog" aria-label="GitHub 插件搜索">
            <div className={css.panelHeader}>
              <span className={css.panelTitle}>GitHub 插件搜索</span>
              <button type="button" className={css.close} aria-label="关闭" onClick={() => { setOpen(false) }}>
                ✕
              </button>
            </div>

            <form
              className={css.searchRow}
              onSubmit={(event) => {
                event.preventDefault()
                void runSearch(query)
              }}
            >
              <input
                className={css.searchInput}
                type="text"
                spellCheck={false}
                placeholder="搜索 dsh 插件（留空 = topic:dsh-plugin）"
                value={query}
                onChange={(event) => { setQuery(event.target.value) }}
              />
              <button
                type="submit"
                className={css.searchButton}
                disabled={search.status === 'loading'}
              >
                {search.status === 'loading' ? '搜索中…' : '搜索'}
              </button>
            </form>

            {search.status === 'idle' && (
              <div className={css.muted}>输入关键词或直接搜索 GitHub 上的 dsh-plugin 项目。</div>
            )}
            {search.status === 'error' && (
              <div className={css.errorText}>搜索失败（GitHub API 限流或网络问题），稍后再试。</div>
            )}
            {search.status === 'done' && search.repos.length === 0 && (
              <div className={css.muted}>没有找到匹配的 dsh-plugin 项目</div>
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
          </div>
        </div>
      )}
    </>
  )
}
