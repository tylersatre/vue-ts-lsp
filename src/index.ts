import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setLogLevel, initFileLogging, type LogLevel } from './logger.js'
import { createUpstreamConnection } from './upstream.js'
import { spawnServer, vtslsCommand, vueLsCommand } from './spawn.js'
import { setupProxy } from './proxy.js'

const VALID_LEVELS = new Set<LogLevel>(['error', 'warn', 'info', 'debug'])

export function parseArgs(argv: string[]): { logLevel: LogLevel } {
    let logLevel: LogLevel = 'error'
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--log-level' && i + 1 < argv.length) {
            const candidate = argv[i + 1]
            if (VALID_LEVELS.has(candidate as LogLevel)) {
                logLevel = candidate as LogLevel
            }
        } else if (argv[i]?.startsWith('--log-level=')) {
            const candidate = argv[i]!.slice('--log-level='.length)
            if (VALID_LEVELS.has(candidate as LogLevel)) {
                logLevel = candidate as LogLevel
            }
        }
    }
    return { logLevel }
}

export function hasExplicitLogLevelArg(argv: string[]): boolean {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--log-level' && i + 1 < argv.length) {
            const candidate = argv[i + 1]
            if (VALID_LEVELS.has(candidate as LogLevel)) {
                return true
            }
        } else if (argv[i]?.startsWith('--log-level=')) {
            const candidate = argv[i]!.slice('--log-level='.length)
            if (VALID_LEVELS.has(candidate as LogLevel)) {
                return true
            }
        }
    }
    return false
}

// Resolve symlinks so npm-linked binaries still satisfy the entrypoint guard.
if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    const argv = process.argv.slice(2)
    const { logLevel } = parseArgs(argv)
    const cliLogLevel = hasExplicitLogLevelArg(argv) ? logLevel : null
    setLogLevel(logLevel)

    try {
        initFileLogging()
    } catch {
        process.stderr.write('[vue-ts-lsp] Warning: could not initialize file logging\n')
    }

    const upstream = createUpstreamConnection()
    const vtslsCfg = vtslsCommand()
    const vueLsCfg = vueLsCommand()
    const { conn: vtsls, kill: killVtsls } = spawnServer(vtslsCfg.command, vtslsCfg.args)
    const { conn: vueLs, kill: killVueLs } = spawnServer(vueLsCfg.command, vueLsCfg.args)
    setupProxy(upstream, vtsls, vueLs, {
        cliLogLevel,
        spawnVtsls: () => spawnServer(vtslsCfg.command, vtslsCfg.args),
        spawnVueLs: () => spawnServer(vueLsCfg.command, vueLsCfg.args),
        killVtsls,
        killVueLs
    })
}
