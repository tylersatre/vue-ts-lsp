import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_RANK: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
}

let currentLevel: LogLevel = 'error'
let fileStream: fs.WriteStream | null = null

export function setLogLevel(level: LogLevel): void {
    currentLevel = level
}

export function getLogLevel(): LogLevel {
    return currentLevel
}

export function initFileLogging(filePath?: string): void {
    const logFilePath = filePath ?? path.join(os.homedir(), '.cache', 'vue-ts-lsp', 'vue-ts-lsp.log')
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
    fileStream = fs.createWriteStream(logFilePath, { flags: 'w' })
    fileStream.on('error', () => {
        fileStream = null
    })
}

export function closeFileLogging(): void {
    if (fileStream !== null) {
        fileStream.end()
        fileStream = null
    }
}

function shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[currentLevel]
}

function formatEntry(level: LogLevel, source: string, message: string): string {
    const ts = new Date().toISOString()
    return `[${ts}] [${level.toUpperCase()}] [${source}] ${message}\n`
}

export function error(source: string, message: string): void {
    if (shouldLog('error')) {
        const entry = formatEntry('error', source, message)
        process.stderr.write(entry)
        fileStream?.write(entry)
    }
}

export function warn(source: string, message: string): void {
    if (shouldLog('warn')) {
        const entry = formatEntry('warn', source, message)
        process.stderr.write(entry)
        fileStream?.write(entry)
    }
}

export function info(source: string, message: string): void {
    if (shouldLog('info')) {
        const entry = formatEntry('info', source, message)
        process.stderr.write(entry)
        fileStream?.write(entry)
    }
}

export function debug(source: string, message: string): void {
    if (shouldLog('debug')) {
        const entry = formatEntry('debug', source, message)
        process.stderr.write(entry)
        fileStream?.write(entry)
    }
}
