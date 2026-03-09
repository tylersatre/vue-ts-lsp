import type { ParsedTsserverRequest } from './types.js'

function isTuple(value: unknown): value is [number, string, unknown] {
    return Array.isArray(value) && value.length === 3 && typeof value[0] === 'number' && typeof value[1] === 'string'
}

export function parseTsserverRequest(params: unknown): ParsedTsserverRequest | null {
    if (isTuple(params)) {
        const [id, command, args] = params
        return { id, command, args, shape: 'flat' }
    }

    if (Array.isArray(params) && params.length === 1 && isTuple(params[0])) {
        const [id, command, args] = params[0]
        return { id, command, args, shape: 'nested' }
    }

    return null
}

export function extractTsserverRequestId(params: unknown): number | null {
    if (Array.isArray(params) && typeof params[0] === 'number') {
        return params[0]
    }

    if (Array.isArray(params) && params.length === 1 && Array.isArray(params[0]) && typeof params[0][0] === 'number') {
        return params[0][0]
    }

    return null
}

export function summarizeBridgeResponseBody(body: unknown): string {
    if (body === null || body === undefined) return 'null'
    if (Array.isArray(body)) return `array(${body.length})`
    if (typeof body === 'object') return `object(${Object.keys(body).length})`
    return typeof body
}
