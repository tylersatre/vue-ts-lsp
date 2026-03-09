import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node.js'

export function spawnServer(command: string, args: string[]): { conn: MessageConnection; kill: () => void } {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const { stdout, stdin } = child
    if (stdout === null || stdin === null) {
        throw new Error(`spawnServer expected piped stdio for ${command}`)
    }

    if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
            process.stderr.write(`[${command}] ${chunk.toString()}`)
        })
    }

    child.on('error', (err: Error) => {
        process.stderr.write(`[spawn] Failed to spawn ${command}: ${err.message}\n`)
        process.exit(1)
    })

    const reader = new StreamMessageReader(stdout)
    const writer = new StreamMessageWriter(stdin)
    const conn = createMessageConnection(reader, writer)
    return { conn, kill: () => child.kill('SIGTERM') }
}

const require = createRequire(import.meta.url)

export function vtslsCommand(): { command: string; args: string[] } {
    const binPath = path.resolve(path.dirname(require.resolve('@vtsls/language-server/package.json')), 'bin', 'vtsls.js')
    return { command: process.execPath, args: [binPath, '--stdio'] }
}

export function vueLsCommand(): { command: string; args: string[] } {
    const binPath = path.resolve(path.dirname(require.resolve('@vue/language-server/package.json')), 'bin', 'vue-language-server.js')
    return { command: process.execPath, args: [binPath, '--stdio'] }
}
