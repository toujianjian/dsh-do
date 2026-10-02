/** Validated, owned view of public GitHub search data. */
export interface GitHubRepo {
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    language: string | null;
}
export declare function parseGitHubResults(payload: unknown): GitHubRepo[];
/** One request lane: superseded or disposed responses never own the UI. */
export declare function createRequestLane(): {
    begin(): {
        signal: AbortSignal;
        isCurrent: () => boolean;
    };
    cancel(): void;
};
//# sourceMappingURL=github.d.ts.map