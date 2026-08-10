import type { Position, Range } from 'vscode-languageserver-protocol'
import type { CallHierarchyItemLike, LspLocation } from '../proxy-types.js'

export function lineCharToOffset(text: string, position: Position): number {
    const lines = text.split('\n')
    let offset = 0
    for (let line = 0; line < position.line && line < lines.length; line += 1) {
        offset += lines[line]!.length + 1
    }
    return offset + position.character
}

export function offsetToPosition(text: string, offset: number): Position {
    const prior = text.slice(0, offset).split('\n')
    return { line: prior.length - 1, character: prior[prior.length - 1]!.length }
}

export function clampPositionToText(text: string, position: Position): Position {
    const lines = text.split('\n')
    if (lines.length === 0) {
        return { line: 0, character: 0 }
    }

    const line = Math.max(0, Math.min(position.line, lines.length - 1))
    const character = Math.max(0, Math.min(position.character, lines[line]!.length))
    return { line, character }
}

export function offsetsToRange(text: string, start: number, end: number): Range {
    return {
        start: offsetToPosition(text, start),
        end: offsetToPosition(text, end)
    }
}

export function distanceToRange(offset: number, start: number, end: number): number {
    if (offset >= start && offset <= end) return 0
    return offset < start ? start - offset : offset - end
}

export function inferReplacementProbeOffsets(oldText: string, newText: string): { oldOffsets: number[]; newOffsets: number[] } | null {
    const sharedPrefixLength = Math.min(oldText.length, newText.length)
    let start = 0
    while (start < sharedPrefixLength && oldText[start] === newText[start]) {
        start += 1
    }

    if (start === oldText.length && start === newText.length) {
        return null
    }

    let oldEnd = oldText.length
    let newEnd = newText.length
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
        oldEnd -= 1
        newEnd -= 1
    }

    const oldOffsets = uniqueSortedOffsets([clampOffset(start, oldText.length), clampOffset(Math.max(start, oldEnd - 1), oldText.length)])
    const newOffsets = uniqueSortedOffsets([clampOffset(start, newText.length), clampOffset(Math.max(start, newEnd - 1), newText.length)])

    return { oldOffsets, newOffsets }
}

export function clampOffset(offset: number, length: number): number {
    if (length <= 0) {
        return 0
    }
    return Math.max(0, Math.min(offset, length - 1))
}

export function uniqueSortedOffsets(offsets: number[]): number[] {
    return Array.from(new Set(offsets)).sort((left, right) => left - right)
}

export function rangeContains(range: Range, position: Position): boolean {
    return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0
}

export function comparePosition(a: Position, b: Position): number {
    if (a.line !== b.line) return a.line - b.line
    return a.character - b.character
}

export function rangeSpan(range: Range): number {
    return (range.end.line - range.start.line) * 100_000 + (range.end.character - range.start.character)
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

export function getLineWindow(text: string, offset: number): { lineStart: number; lineEnd: number; localOffset: number } {
    let lineStart = offset
    while (lineStart > 0 && text[lineStart - 1] !== '\n') {
        lineStart -= 1
    }

    let lineEnd = offset
    while (lineEnd < text.length && text[lineEnd] !== '\n') {
        lineEnd += 1
    }

    return { lineStart, lineEnd, localOffset: offset - lineStart }
}

export function isPosition(value: unknown): value is Position {
    return (
        value !== null &&
        typeof value === 'object' &&
        'line' in value &&
        'character' in value &&
        typeof (value as { line: unknown }).line === 'number' &&
        typeof (value as { character: unknown }).character === 'number'
    )
}

export function isRange(value: unknown): value is Range {
    return (
        value !== null &&
        typeof value === 'object' &&
        'start' in value &&
        'end' in value &&
        isPosition((value as { start: unknown }).start) &&
        isPosition((value as { end: unknown }).end)
    )
}

export function isLocation(value: unknown): value is LspLocation {
    return (
        value !== null &&
        typeof value === 'object' &&
        'uri' in value &&
        typeof (value as { uri: unknown }).uri === 'string' &&
        'range' in value &&
        isRange((value as { range: unknown }).range)
    )
}

export function isCallHierarchyItem(value: unknown): value is CallHierarchyItemLike {
    return (
        value !== null &&
        typeof value === 'object' &&
        'uri' in value &&
        typeof (value as { uri: unknown }).uri === 'string' &&
        'name' in value &&
        typeof (value as { name: unknown }).name === 'string' &&
        'kind' in value &&
        typeof (value as { kind: unknown }).kind === 'number' &&
        'range' in value &&
        isRange((value as { range: unknown }).range) &&
        'selectionRange' in value &&
        isRange((value as { selectionRange: unknown }).selectionRange)
    )
}
