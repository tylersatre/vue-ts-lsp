import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { DocumentStore } from './documents.js'
import { DiagnosticsStore } from './diagnostics.js'
import { createWorkspaceScanCache, type WorkspaceScanCache } from './proxy-workspace.js'
import { RetryTracker } from './recovery.js'
import type { WorkspaceConfig } from './config.js'
import type { CrashRecoveryOptions, DiagnosticNudgeChannel, DiagnosticNudgeChannelState, PathAliasConfig, RecentPositionContext } from './proxy-types.js'
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
    // Wall-clock-independent bound on self-scheduled recovery retries: the sliding
    // RetryTracker window can't stop a chain whose attempts each outlast it.
    vtslsConsecutiveRecoveryFailures: number
    vueLsConsecutiveRecoveryFailures: number

    // Stores
    documentStore: DocumentStore
    diagnosticsStore: DiagnosticsStore
    pathAliasConfigCache: Map<string, PathAliasConfig[]>
    workspaceScanCache: WorkspaceScanCache

    // Diagnostics nudging
    lastVtslsDiagnosticsAt: Map<string, number>
    diagnosticNudges: Map<DiagnosticNudgeChannel, DiagnosticNudgeChannelState>

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
        vtslsConsecutiveRecoveryFailures: 0,
        vueLsConsecutiveRecoveryFailures: 0,

        documentStore: new DocumentStore(),
        diagnosticsStore: new DiagnosticsStore(),
        pathAliasConfigCache: new Map(),
        workspaceScanCache: createWorkspaceScanCache(),

        lastVtslsDiagnosticsAt: new Map(),
        diagnosticNudges: new Map([
            ['vue', { pending: new Map(), queued: new Set() }],
            ['script', { pending: new Map(), queued: new Set() }],
            ['script-dependent', { pending: new Map(), queued: new Set() }]
        ]),

        activeForegroundVtslsRequests: 0,
        vtslsBackgroundQueue: Promise.resolve(),
        lastPositionContext: null,

        // Placeholder — wired by orchestrator after recovery module is set up
        recoverVtsls: () => Promise.resolve(),
        recoverVueLs: () => Promise.resolve()
    }
}
