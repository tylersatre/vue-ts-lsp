import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node.js'

/** Creates the stdin/stdout JSON-RPC transport. stdout must stay protocol-only. */
export function createUpstreamConnection(): MessageConnection {
    const reader = new StreamMessageReader(process.stdin)
    const writer = new StreamMessageWriter(process.stdout)
    const connection = createMessageConnection(reader, writer)
    connection.listen()
    return connection
}
