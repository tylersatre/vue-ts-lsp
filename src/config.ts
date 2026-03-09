import fs from 'node:fs'
import path from 'node:path'
import type { LogLevel } from './logger.js'

const VALID_LOG_LEVELS = new Set<LogLevel>(['error', 'warn', 'info', 'debug'])

export interface WorkspaceConfig {
    ignoreDirectories: string[]
    logLevel: LogLevel | null
}

export interface WorkspaceConfigLoadResult {
    path: string | null
    config: WorkspaceConfig
    warnings: string[]
}

const DEFAULT_CONFIG: WorkspaceConfig = {
    ignoreDirectories: [],
    logLevel: null
}

export function getWorkspaceConfigPath(rootPath: string): string {
    return path.join(rootPath, '.claude', 'vue-ts-lsp.json')
}

export function loadWorkspaceConfig(rootPath: string): WorkspaceConfigLoadResult {
    const configPath = getWorkspaceConfigPath(rootPath)
    if (!fs.existsSync(configPath)) {
        return { path: null, config: { ...DEFAULT_CONFIG }, warnings: [] }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
        return {
            path: configPath,
            config: { ...DEFAULT_CONFIG },
            warnings: [`failed to parse ${configPath}`]
        }
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            path: configPath,
            config: { ...DEFAULT_CONFIG },
            warnings: ['config file must contain a JSON object']
        }
    }

    const raw = parsed as {
        ignoreDirectories?: unknown
        logLevel?: unknown
    }
    const warnings: string[] = []
    const ignoreDirectories: string[] = []
    let sawInvalidIgnoreDirectory = false

    if (raw.ignoreDirectories !== undefined) {
        if (!Array.isArray(raw.ignoreDirectories)) {
            warnings.push('ignoreDirectories must be an array of strings')
        } else {
            for (const entry of raw.ignoreDirectories) {
                if (typeof entry !== 'string') {
                    sawInvalidIgnoreDirectory = true
                    continue
                }
                const normalized = normalizeConfigPath(entry)
                if (normalized === null) {
                    sawInvalidIgnoreDirectory = true
                    continue
                }
                if (!ignoreDirectories.includes(normalized)) {
                    ignoreDirectories.push(normalized)
                }
            }

            if (sawInvalidIgnoreDirectory) {
                warnings.push('ignoreDirectories must contain only non-empty strings')
            }
        }
    }

    let logLevel: LogLevel | null = null
    if (raw.logLevel !== undefined) {
        if (typeof raw.logLevel === 'string' && VALID_LOG_LEVELS.has(raw.logLevel as LogLevel)) {
            logLevel = raw.logLevel as LogLevel
        } else {
            warnings.push('logLevel must be one of: error, warn, info, debug')
        }
    }

    return {
        path: configPath,
        config: {
            ignoreDirectories,
            logLevel
        },
        warnings
    }
}

function normalizeConfigPath(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
        return null
    }

    const normalized = trimmed
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')

    return normalized.length > 0 ? normalized : null
}
