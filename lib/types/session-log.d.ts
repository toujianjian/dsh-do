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
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/**
 * Read every event of a session log in log order.
 *
 * @param session - an agent's session, or anything else; unknown shapes are tolerated.
 * @returns the session's events, or an empty array when no log can be read.
 */
export declare function readSessionEvents(session: unknown): readonly SessionEvent[];
