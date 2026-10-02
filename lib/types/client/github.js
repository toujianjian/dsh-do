export function parseGitHubResults(payload) {
    if (typeof payload !== 'object' || payload === null || !('items' in payload) || !Array.isArray(payload.items)) {
        throw new Error('Invalid GitHub search response');
    }
    return payload.items.map((item) => {
        if (typeof item !== 'object' || item === null)
            throw new Error('Invalid GitHub repository');
        const repo = item;
        if (typeof repo.full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name) ||
            repo.html_url !== `https://github.com/${repo.full_name}` ||
            typeof repo.stargazers_count !== 'number' || !Number.isSafeInteger(repo.stargazers_count) || repo.stargazers_count < 0 ||
            !(repo.description === null || typeof repo.description === 'string') ||
            !(repo.language === null || typeof repo.language === 'string'))
            throw new Error('Invalid GitHub repository');
        return { full_name: repo.full_name, html_url: repo.html_url, description: repo.description,
            stargazers_count: repo.stargazers_count, language: repo.language };
    });
}
/** One request lane: superseded or disposed responses never own the UI. */
export function createRequestLane() {
    let current;
    return {
        begin() {
            current?.abort();
            const controller = new AbortController();
            current = controller;
            return { signal: controller.signal, isCurrent: () => current === controller && !controller.signal.aborted };
        },
        cancel() { current?.abort(); current = undefined; },
    };
}
//# sourceMappingURL=github.js.map