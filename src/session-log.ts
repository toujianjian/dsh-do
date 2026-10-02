/**
 * Read a session's event log across DSH generations.
 *
 * DSH up to and including 0.1.0-rc.8 exposed the append-only log as a public
 * getter, `Session.events`. From 0.1.5-rc.3 that getter is gone and the log is
 * only reachable through `Session.snapshotEvents(fromSeq?, toSeqExclusive?)`,
 * which materializes a frozen snapshot of a half-open range and defaults to the
 * whole log. The platform's own replacement is deliberately *not* `ownEvents()`,
 * which returns only the events after a fork-inherited prefix: both callers here
 * need the complete log, exactly what the old getter returned.
 *
 * Reading through this helper keeps one published build working on both lines.
 * An unrecognized shape yields an empty log rather than throwing, because both
 * call sites sit on paths where a throw is far worse than a wrong count — one is
 * the driver's round accounting, the other runs inside a tool call.
 *
 * @module dsh-do/session-log
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * The two log accessors seen in the wild, and nothing else this plugin depends
 * on. Both are optional so that either generation's session satisfies the type.
 */
interface SessionLogCarrier {
	/** DSH >= 0.1.5-rc.3: materialize a frozen snapshot of a half-open range. */
	snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => unknown
	/** DSH <= 0.1.0-rc.8: the live append-only log, exposed as a getter. */
	events?: unknown
}

/**
 * Read every event of a session log in log order.
 *
 * @param session - an agent's session, or anything else; unknown shapes are tolerated.
 * @returns the session's events, or an empty array when no log can be read.
 */
export function readSessionEvents(session: unknown): readonly SessionEvent[] {
	if (typeof session !== 'object' || session === null) return []
	const carrier = session as SessionLogCarrier
	// Prefer the newer accessor: on 0.1.5-rc.3 the legacy getter no longer exists,
	// and on older lines both are present and agree.
	if (typeof carrier.snapshotEvents === 'function') {
		const snapshot = carrier.snapshotEvents()
		if (Array.isArray(snapshot)) return snapshot as readonly SessionEvent[]
	}
	return Array.isArray(carrier.events) ? (carrier.events as readonly SessionEvent[]) : []
}
