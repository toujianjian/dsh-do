/**
 * Read every event of a session log in log order.
 *
 * @param session - an agent's session, or anything else; unknown shapes are tolerated.
 * @returns the session's events, or an empty array when no log can be read.
 */
export function readSessionEvents(session) {
    if (typeof session !== 'object' || session === null)
        return [];
    const carrier = session;
    // Prefer the newer accessor: on 0.1.5-rc.3 the legacy getter no longer exists,
    // and on older lines both are present and agree.
    if (typeof carrier.snapshotEvents === 'function') {
        const snapshot = carrier.snapshotEvents();
        if (Array.isArray(snapshot))
            return snapshot;
    }
    return Array.isArray(carrier.events) ? carrier.events : [];
}
//# sourceMappingURL=session-log.js.map