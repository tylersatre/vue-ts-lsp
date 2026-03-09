import type { Position } from 'vscode-languageserver-protocol'

import { lineCharToOffset } from './position-utils.js'

export function extractRequestUri(params: unknown): string | null {
    if (
        params !== null &&
        typeof params === 'object' &&
        'textDocument' in params &&
        params.textDocument !== null &&
        typeof params.textDocument === 'object' &&
        'uri' in params.textDocument &&
        typeof (params.textDocument as { uri: unknown }).uri === 'string'
    ) {
        return (params.textDocument as { uri: string }).uri
    }

    if (
        params !== null &&
        typeof params === 'object' &&
        'item' in params &&
        params.item !== null &&
        typeof params.item === 'object' &&
        'uri' in params.item &&
        typeof (params.item as { uri: unknown }).uri === 'string'
    ) {
        return (params.item as { uri: string }).uri
    }

    return null
}

export function extractIdentifierAtPosition(text: string, position: Position): string | null {
    const offset = lineCharToOffset(text, position)
    const current = text[offset] ?? ''
    const previous = text[offset - 1] ?? ''

    const seedOffset = isIdentifierChar(current) ? offset : isIdentifierChar(previous) ? offset - 1 : -1
    if (seedOffset < 0) {
        return null
    }

    let start = seedOffset
    let end = seedOffset + 1
    while (start > 0 && isIdentifierChar(text[start - 1] ?? '')) {
        start -= 1
    }
    while (end < text.length && isIdentifierChar(text[end] ?? '')) {
        end += 1
    }

    return start < end ? text.slice(start, end) : null
}

export function isIdentifierChar(char: string): boolean {
    return /[A-Za-z0-9_$]/.test(char)
}
