import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { Position, Range } from 'vscode-languageserver-protocol'
import type { LogLevel } from './logger.js'

export type ContentChange = {
    range?: {
        start: { line: number; character: number }
        end: { line: number; character: number }
    }
    text: string
}

export type LspLocation = {
    uri: string
    range: Range
}

export type CallHierarchyItemLike = {
    uri: string
    name: string
    kind: number
    range: Range
    selectionRange: Range
    detail?: string
    data?: unknown
}

export type RecentPositionContext = {
    uri: string
    position: Position
    capturedAt: number
}

export type TsserverDisplayPartLike = {
    text: string
}

export type TsserverJSDocTagLike = {
    name: string
    text?: string | TsserverDisplayPartLike[]
}

export type TsserverQuickInfoBodyLike = {
    displayString: string
    documentation?: string | TsserverDisplayPartLike[]
    tags?: TsserverJSDocTagLike[]
}

export type IncomingCallLike = {
    from: CallHierarchyItemLike
    fromSpans: Range[]
}

export type SpawnedConnection =
    | MessageConnection
    | {
          conn: MessageConnection
          kill?: () => void
      }

export type SpawnedConnectionResult = {
    conn: MessageConnection
    kill?: () => void
}

export type DownstreamTarget = 'vtsls' | 'vue_ls'

export type DownstreamRequestPriority = 'foreground' | 'background'

export type DownstreamRequestOptions = {
    retryOnTimeout?: boolean
    timeoutMs?: number
    priority?: DownstreamRequestPriority
}

export type PathAliasConfig = {
    baseUrl: string
    paths: Record<string, string[]>
}

export type TsserverRequestExecuteInfo = {
    executionTarget?: number
    expectsResult?: boolean
    isAsync?: boolean
    lowPriority?: boolean
}

export class DownstreamRequestTimeoutError extends Error {
    constructor(
        readonly target: DownstreamTarget,
        readonly method: string,
        readonly timeoutMs: number
    ) {
        super(`${target} ${method} timed out after ${timeoutMs}ms`)
        this.name = 'DownstreamRequestTimeoutError'
    }
}

export interface CrashRecoveryOptions {
    cliLogLevel?: LogLevel | null
    spawnVtsls?: () => SpawnedConnection
    spawnVueLs?: () => SpawnedConnection
    delayMs?: number
    maxRestarts?: number
    windowMs?: number
    killVtsls?: () => void
    killVueLs?: () => void
    shutdownTimeoutMs?: number
    requestTimeoutMs?: number
}

export const VUE_DEFINITION_RETRY_DELAY_MS = 1000
export const VUE_TS_WARMUP_WINDOW_MS = 5000
export const VUE_PROJECT_WARMUP_DELAY_MS = 250
export const VUE_DIAGNOSTIC_NUDGE_DELAY_MS = 150
export const SCRIPT_DIAGNOSTIC_NUDGE_DELAY_MS = 100
export const SCRIPT_DEPENDENT_DIAGNOSTIC_NUDGE_DELAY_MS = 175
export const VUE_LOADING_HOVER_RETRY_DELAY_MS = 150
export const WORKSPACE_SYMBOL_CONTEXT_MAX_AGE_MS = 120_000
export const DOWNSTREAM_REQUEST_TIMEOUT_MS = 15_000
export const VUE_DEFINITION_TIMEOUT_MS = 5000
export const VUE_HOVER_TIMEOUT_MS = 5000
export const WORKSPACE_SYMBOL_TIMEOUT_MS = 5000
export const VTSLS_BACKGROUND_IDLE_POLL_MS = 50
export const VTSLS_BACKGROUND_IDLE_MAX_WAIT_MS = 3_000
export const VTSLS_BACKGROUND_REQUEST_TIMEOUT_MS = 5_000
export const SCRIPT_DEPENDENT_DIAGNOSTIC_SYMBOL_LIMIT = 3
export const SCRIPT_DEPENDENT_DIAGNOSTIC_FILE_LIMIT = 24
export const TS_EXECUTION_TARGET_SEMANTIC = 0
