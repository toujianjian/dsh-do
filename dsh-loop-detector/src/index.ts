/**
 * dsh-loop-detector …?DSH Standard component.
 *
 * Detects model self-loops (long repeated text segments across recent
 * messages) through the `messages.dsh/v1alpha1` `MessageObserver` protocol,
 * records detection snapshots, and contributes `loop-detector.status` /
 * `loop-detector.clear` commands.
 *
 * The MessageObserver protocol is read-only by design; this component does not
 * cancel or rewrite messages. Hosts that want automatic termination can wire
 * the exported `detectRepeat` / `LoopDetector` helpers to native agent control
 * outside the standard protocol surface.
 *
 * @module dsh-loop-detector
 */
import { defineFacet, defineProtocolKey, protocol, optionalProtocol, type FacetModule } from '@dsh-std/sdk'
import type { ActivationContext } from '@dsh-std/lifecycle'
import {
  API_VERSION as MESSAGES_API_VERSION,
  KIND as MESSAGE_OBSERVER_KIND,
} from '@dsh-std/messages'
import type { ApiReference } from '@dsh-std/core'

/** MessageObserver client surface this component expects after negotiation. */
export interface MessageObserverClient {
  subscribe(handler: (event: MessageObserverEvent) => void, scope?: string): () => void
}

export interface MessageObserverEvent {
  readonly eventType: 'messages.observe'
  readonly eventVersion: '0.15'
  readonly eventId: string
  readonly scope: string
  readonly sequence: number
  readonly privacyClass: 'public' | 'internal' | 'sensitive'
  readonly summary: string
  readonly payload: {
    readonly kind: 'message.created' | 'message.received' | 'message.sent'
    readonly messageId?: string
    readonly author?: string
    readonly content: ReadonlyArray<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    readonly truncated?: boolean
  }
}

/** Typed accessor for the negotiated MessageObserver client. */
export const messageObserverKey = defineProtocolKey<MessageObserverClient>(
  { apiVersion: MESSAGES_API_VERSION, kind: MESSAGE_OBSERVER_KIND },
  (agreement) => {
    const binding = (agreement as unknown as { binding?: MessageObserverClient }).binding;
    // 当 binding 不存在时（host 没实现 MessageObserver），fromAgreement 返回 undefined，
    // optionalProtocol 会检测到 client 为 undefined，从而返回 { available: false }
    if (binding === undefined) return undefined as unknown as MessageObserverClient;
    return binding;
  },
)

export interface LoopDetectorOptions {
  threshold: number
  minRepeatLength: number
  maxHistory: number
}

export const DEFAULT_OPTIONS: LoopDetectorOptions = Object.freeze({
  threshold: 3,
  minRepeatLength: 100,
  maxHistory: 10,
})

export interface LoopDetectionRecord {
  readonly scope: string
  readonly detectedAt: number
  readonly repeatingSegments: readonly string[]
  readonly recentTexts: readonly string[]
}

/** Pure repetition detector over the most recent message texts. */
export function detectRepeat(texts: readonly string[], options: LoopDetectorOptions = DEFAULT_OPTIONS): readonly string[] {
  if (texts.length < 2) return []
  const last = texts[texts.length - 1]
  const prev = texts[texts.length - 2]
  return commonSegments(last, prev, options.minRepeatLength)
}

function commonSegments(a: string, b: string, minLength: number): readonly string[] {
  const segments: string[] = []
  const aLen = a.length
  const bLen = b.length
  if (aLen < minLength || bLen < minLength) return segments
  for (let i = 0; i <= aLen - minLength; i++) {
    for (let j = minLength; j <= aLen - i; j++) {
      const substr = a.slice(i, i + j)
      if (b.includes(substr)) segments.push(substr)
    }
  }
  return [...new Set(segments)].sort((x, y) => y.length - x.length)
}

function flattenContent(content: MessageObserverEvent['payload']['content']): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Session-scoped detector state. */
export class LoopDetector {
  private readonly history = new Map<string, string[]>()
  private readonly records = new Map<string, LoopDetectionRecord[]>()

  constructor(private readonly options: LoopDetectorOptions = DEFAULT_OPTIONS) {}

  observe(scope: string, text: string): LoopDetectionRecord | undefined {
    if (text.length === 0) return undefined
    let texts = this.history.get(scope) ?? []
    texts = [...texts, text]
    if (texts.length > this.options.maxHistory) texts = texts.slice(texts.length - this.options.maxHistory)
    this.history.set(scope, texts)

    const repeats = detectRepeat(texts, this.options)
    if (repeats.length === 0 || texts.length < this.options.threshold) return undefined

    const record: LoopDetectionRecord = Object.freeze({
      scope,
      detectedAt: Date.now(),
      repeatingSegments: Object.freeze(repeats.slice()),
      recentTexts: Object.freeze(texts.slice()),
    })
    const list = this.records.get(scope) ?? []
    this.records.set(scope, [...list.slice(-9), record])
    return record
  }

  status(scope?: string): readonly LoopDetectionRecord[] {
    if (scope === undefined) return Object.freeze([...this.records.values()].flat())
    return Object.freeze(this.records.get(scope) ?? [])
  }

  clear(scope?: string): void {
    if (scope === undefined) {
      this.history.clear()
      this.records.clear()
      return
    }
    this.history.delete(scope)
    this.records.delete(scope)
  }
}

/** Shared detector instance for command handlers and the facet activation. */
let sharedDetector: LoopDetector | undefined

export function detector(): LoopDetector {
  if (sharedDetector === undefined) sharedDetector = new LoopDetector()
  return sharedDetector
}

const STATUS_COMMAND_ID = 'loop-detector.status'
const CLEAR_COMMAND_ID = 'loop-detector.clear'

export interface LoopDetectorCommandHandler {
  execute(input: { readonly rawInput: string }, context: { readonly signal: AbortSignal }): { kind: 'success'; text: string } | { kind: 'error'; text: string }
}

function formatRecord(record: LoopDetectionRecord): string {
  const sample = record.repeatingSegments[0] ?? ''
  const preview = sample.length > 200 ? `${sample.slice(0, 200)}…` : sample
  return `[${new Date(record.detectedAt).toISOString()}] scope=${record.scope} repeats=${record.repeatingSegments.length} longest=${record.repeatingSegments[0]?.length ?? 0}\n  sample: ${preview}`
}

function statusHandler(input: { readonly rawInput: string }, context: { readonly signal: AbortSignal }): LoopDetectorCommandHandler['execute'] extends (...args: never[]) => infer R ? R : never {
  const scope = input.rawInput.trim() === '' ? undefined : input.rawInput.trim()
  const records = detector().status(scope)
  if (records.length === 0) return { kind: 'success', text: 'No self-loop detections recorded.' }
  const body = records.map(formatRecord).join('\n')
  return { kind: 'success', text: `Loop detector …?${records.length} detection(s):\n${body}` }
}

function clearHandler(input: { readonly rawInput: string }, context: { readonly signal: AbortSignal }): LoopDetectorCommandHandler['execute'] extends (...args: never[]) => infer R ? R : never {
  const scope = input.rawInput.trim() === '' ? undefined : input.rawInput.trim()
  detector().clear(scope)
  return { kind: 'success', text: scope === undefined ? 'Cleared all detection history.' : `Cleared detection history for scope ${scope}.` }
}

export const commandHandlers: ReadonlyRecord<string, LoopDetectorCommandHandler> = Object.freeze({
  [STATUS_COMMAND_ID]: { execute: statusHandler } as unknown as LoopDetectorCommandHandler,
  [CLEAR_COMMAND_ID]: { execute: clearHandler } as unknown as LoopDetectorCommandHandler,
})

type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V }

export const loopDetectorFacet: FacetModule = defineFacet(
  function activate(context: ActivationContext): void {
    const detectorInstance = detector()

    const observer = optionalProtocol(context, messageObserverKey)
    if (observer.available) {
      const unsubscribe = observer.client.subscribe((event) => {
        if (event.payload.kind !== 'message.received' && event.payload.kind !== 'message.sent') return
        const text = flattenContent(event.payload.content)
        if (text.length === 0) return
        const record = detectorInstance.observe(event.scope, text)
        if (record !== undefined) {
          console.warn(`[loop-detector] self-loop detected in scope ${record.scope}; ${record.repeatingSegments.length} repeating segment(s). Use command "loop-detector.status" to inspect.`)
        }
      })
      context.scope.add(unsubscribe)
    } else {
      console.warn('[loop-detector] MessageObserver unavailable; detection commands are registered but no live self-loop detection will occur.')
    }

    const publishCommands = context.extensions.publish
    const disposeStatus = publishCommands(
      { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' } as ApiReference,
      STATUS_COMMAND_ID,
      commandHandlers[STATUS_COMMAND_ID],
    )
    context.scope.add(disposeStatus)
    const disposeClear = publishCommands(
      { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' } as ApiReference,
      CLEAR_COMMAND_ID,
      commandHandlers[CLEAR_COMMAND_ID],
    )
    context.scope.add(disposeClear)
  },
  function deactivate(reason: string): void {
    // The cleanup scope already removes the subscription and command extensions.
    // Preserve detection records across deactivation so a re-activation or a
    // status query can still report the last known loops.
    void reason
  },
  function snapshot() {
    const records = detector().status()
    return {
      state: 'active' as const,
      message: records.length === 0 ? undefined : `${records.length} detection(s) recorded`,
    }
  },
)

export default loopDetectorFacet
