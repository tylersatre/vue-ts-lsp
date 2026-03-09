import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { DocumentStore } from './documents.js'
import { DiagnosticsStore } from './diagnostics.js'
import { RetryTracker } from './recovery.js'
import type { WorkspaceConfig } from './config.js'
import type { CrashRecoveryOptions, PathAliasConfig, RecentPositionContext } from './proxy-types.js'
import { DOWNSTREAM_REQUEST_TIMEOUT_MS } from './proxy-types.js'

export interface ProxyContext {
    // Connections (mutable — reassigned during crash recovery)
    upstream: MessageConnection
    currentVtsls: MessageConnection
    currentVueLs: MessageConnection
    currentKillVtsls: (() => void) | undefined
    currentKillVueLs: (() => void) | undefined
    crashOptions: CrashRecoveryOptions | undefined

    // Initialization
    savedInitParams: InitializeParams | null
    savedVueTypescriptPluginLocation: string | null
    workspaceConfig: WorkspaceConfig
    initializeCompletedAt: number
    loggedVueTsWarmup: boolean

    // Recovery & timing
    delayMs: number
    requestTimeoutMs: number
    vtslsRetry: RetryTracker
    vueLsRetry: RetryTracker
    vtslsRecoveryPromise: Promise<void> | null
    vueLsRecoveryPromise: Promise<void> | null

    // Stores
    documentStore: DocumentStore
    diagnosticsStore: DiagnosticsStore
    pathAliasConfigCache: Map<string, PathAliasConfig[]>

    // Diagnostics nudging
    lastVtslsDiagnosticsAt: Map<string, number>
    pendingVueDiagnosticNudges: Map<string, ReturnType<typeof setTimeout>>
    queuedVueDiagnosticNudges: Set<string>
    pendingScriptDiagnosticNudges: Map<string, ReturnType<typeof setTimeout>>
    queuedScriptDiagnosticNudges: Set<string>
    pendingScriptDependentDiagnosticNudges: Map<string, ReturnType<typeof setTimeout>>
    queuedScriptDependentDiagnosticNudges: Set<string>

    // Background queue & tracking
    activeForegroundVtslsRequests: number
    vtslsBackgroundQueue: Promise<void>
    lastPositionContext: RecentPositionContext | null

    // Recovery callbacks (wired by orchestrator to avoid circular deps)
    recoverVtsls: (reason: string, forceKill?: boolean) => Promise<void>
    recoverVueLs: (reason: string, forceKill?: boolean) => Promise<void>
}

export function createProxyContext(
    upstream: MessageConnection,
    vtsls: MessageConnection,
    vueLs: MessageConnection,
    crashOptions?: CrashRecoveryOptions
): ProxyContext {
    return {
        upstream,
        currentVtsls: vtsls,
        currentVueLs: vueLs,
        currentKillVtsls: crashOptions?.killVtsls,
        currentKillVueLs: crashOptions?.killVueLs,
        crashOptions,

        savedInitParams: null,
        savedVueTypescriptPluginLocation: null,
        workspaceConfig: { ignoreDirectories: [], logLevel: null },
        initializeCompletedAt: 0,
        loggedVueTsWarmup: false,

        delayMs: crashOptions?.delayMs ?? 1000,
        requestTimeoutMs: crashOptions?.requestTimeoutMs ?? DOWNSTREAM_REQUEST_TIMEOUT_MS,
        vtslsRetry: new RetryTracker(crashOptions?.maxRestarts, crashOptions?.windowMs),
        vueLsRetry: new RetryTracker(crashOptions?.maxRestarts, crashOptions?.windowMs),
        vtslsRecoveryPromise: null,
        vueLsRecoveryPromise: null,

        documentStore: new DocumentStore(),
        diagnosticsStore: new DiagnosticsStore(),
        pathAliasConfigCache: new Map(),

        lastVtslsDiagnosticsAt: new Map(),
        pendingVueDiagnosticNudges: new Map(),
        queuedVueDiagnosticNudges: new Set(),
        pendingScriptDiagnosticNudges: new Map(),
        queuedScriptDiagnosticNudges: new Set(),
        pendingScriptDependentDiagnosticNudges: new Map(),
        queuedScriptDependentDiagnosticNudges: new Set(),

        activeForegroundVtslsRequests: 0,
        vtslsBackgroundQueue: Promise.resolve(),
        lastPositionContext: null,

        // Placeholder — wired by orchestrator after recovery module is set up
        recoverVtsls: () => Promise.resolve(),
        recoverVueLs: () => Promise.resolve()
    }
}
