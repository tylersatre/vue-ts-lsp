import ts from 'typescript'
import type { Position, Range } from 'vscode-languageserver-protocol'
import type { OutgoingCallTarget } from './types.js'
import { lineCharToOffset, offsetToPosition, offsetsToRange, distanceToRange, clamp, getLineWindow } from './position-utils.js'
import { findScriptBlockAtOffset, findNodeAtOffset, collectParseTargets } from './ast-utils.js'

export function findVueTemplateComponentAtPosition(text: string, position: Position): string | null {
    const offset = lineCharToOffset(text, position)
    if (findScriptBlockAtOffset(text, offset) !== null) {
        return null
    }

    const { lineStart, lineEnd, localOffset } = getLineWindow(text, offset)
    const line = text.slice(lineStart, lineEnd)
    const tagPattern = /<\/?([A-Za-z][\w-]*)/g
    for (const match of line.matchAll(tagPattern)) {
        const fullMatch = match[0]
        const name = match[1]
        if (name === undefined) {
            continue
        }
        const nameOffset = match.index! + fullMatch.length - name.length
        const nameEnd = nameOffset + name.length
        if (localOffset >= nameOffset && localOffset <= nameEnd) {
            if (/^[A-Z]/.test(name) || name.includes('-')) {
                return name
            }
            return null
        }
    }

    return null
}

export function normalizeVueTemplateExpressionPosition(text: string, position: Position): Position | null {
    const offset = lineCharToOffset(text, position)
    if (findScriptBlockAtOffset(text, offset) !== null) {
        return null
    }

    const { lineStart, lineEnd, localOffset } = getLineWindow(text, offset)
    const line = text.slice(lineStart, lineEnd)
    const expressionRange = findNearestTemplateExpressionRange(line, localOffset)
    if (expressionRange === null) {
        return null
    }

    const expression = line.slice(expressionRange.start, expressionRange.end)
    const relativeOffset = clamp(localOffset - expressionRange.start, 0, expression.length)
    const memberChain = findNearestMemberChain(expression, relativeOffset)
    if (memberChain !== null) {
        return offsetToPosition(text, lineStart + expressionRange.start + memberChain.lastSegmentStart)
    }

    const identifierOffset = findNearestIdentifierOffset(expression, relativeOffset)
    if (identifierOffset === null) {
        return null
    }

    return offsetToPosition(text, lineStart + expressionRange.start + identifierOffset)
}

export function isVueTemplatePosition(text: string, position: Position): boolean {
    const offset = lineCharToOffset(text, position)
    return findScriptBlockAtOffset(text, offset) === null
}

export function extractVueOutgoingCalls(text: string, position: Position): OutgoingCallTarget[] {
    const documentOffset = lineCharToOffset(text, position)
    const block = findScriptBlockAtOffset(text, documentOffset)
    if (block === null) {
        return []
    }

    const sourceFile = ts.createSourceFile('component.ts', block.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const node = findNodeAtOffset(sourceFile, documentOffset - block.contentStart)
    if (node === null) {
        return []
    }

    const container = findCallContainer(node)
    if (container === null) {
        return []
    }

    const body = getCallContainerBody(container)
    if (body === null) {
        return []
    }

    const calls: OutgoingCallTarget[] = []
    const visit = (current: ts.Node): void => {
        if (ts.isCallExpression(current)) {
            const target = getCallTargetName(current.expression)
            if (target !== null) {
                const start = block.contentStart + current.expression.getStart(sourceFile)
                const end = block.contentStart + current.expression.getEnd()
                calls.push({
                    name: target,
                    range: {
                        start: offsetToPosition(text, start),
                        end: offsetToPosition(text, end)
                    }
                })
            }
        }
        ts.forEachChild(current, visit)
    }

    visit(body)
    return calls
}

export function collectVueTemplateIdentifierRanges(text: string, identifier: string): Range[] {
    const ranges: Range[] = []
    const escapedIdentifier = escapeRegExp(identifier)
    const pattern = new RegExp(`\\b${escapedIdentifier}\\b`, 'g')
    const scriptTargets = collectParseTargets('file:///component.vue', text).map((target) => ({
        start: target.contentStart,
        end: target.contentStart + target.content.length
    }))

    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
        const start = match.index
        const end = start + identifier.length
        if (scriptTargets.some((target) => start >= target.start && end <= target.end)) {
            continue
        }

        const { lineStart, lineEnd, localOffset } = getLineWindow(text, start)
        const line = text.slice(lineStart, lineEnd)
        const lineRelativeEnd = localOffset + identifier.length
        const expressionRange = findNearestTemplateExpressionRange(line, localOffset)
        if (expressionRange !== null && localOffset >= expressionRange.start && lineRelativeEnd <= expressionRange.end) {
            ranges.push(offsetsToRange(text, start, end))
            continue
        }

        const tagPattern = /<\/?([A-Za-z][\w-]*)/g
        for (const tagMatch of line.matchAll(tagPattern)) {
            const tagName = tagMatch[1]
            if (tagName !== identifier || tagMatch.index === undefined) {
                continue
            }
            const tagStart = lineStart + tagMatch.index + tagMatch[0].length - tagName.length
            const tagEnd = tagStart + tagName.length
            if (start === tagStart && end === tagEnd) {
                ranges.push(offsetsToRange(text, start, end))
                break
            }
        }
    }

    return ranges
}

function findNearestTemplateExpressionRange(line: string, localOffset: number): { start: number; end: number } | null {
    const ranges: Array<{ start: number; end: number; distance: number }> = []
    const attributePattern = /"([^"]*)"|'([^']*)'/g
    for (const match of line.matchAll(attributePattern)) {
        const fullMatch = match[0]
        const start = match.index! + 1
        const end = match.index! + fullMatch.length - 1
        ranges.push({
            start,
            end,
            distance: distanceToRange(localOffset, start, end)
        })
    }

    const interpolationPattern = /\{\{([\s\S]*?)\}\}/g
    for (const match of line.matchAll(interpolationPattern)) {
        const fullMatch = match[0]
        const start = match.index! + 2
        const end = match.index! + fullMatch.length - 2
        ranges.push({
            start,
            end,
            distance: distanceToRange(localOffset, start, end)
        })
    }

    if (ranges.length === 0) {
        return null
    }

    ranges.sort((left, right) => left.distance - right.distance)
    const best = ranges[0]!
    return best.distance <= 24 ? { start: best.start, end: best.end } : null
}

function findNearestMemberChain(expression: string, localOffset: number): { lastSegmentStart: number } | null {
    const pattern = /[A-Za-z_$][\w$]*(?:\?\.)?(?:\.[A-Za-z_$][\w$]*|\?\.[A-Za-z_$][\w$]*)+/g
    const candidates = Array.from(expression.matchAll(pattern)).map((match) => ({
        text: match[0],
        start: match.index!,
        end: match.index! + match[0].length
    }))
    if (candidates.length === 0) {
        return null
    }

    candidates.sort((left, right) => distanceToRange(localOffset, left.start, left.end) - distanceToRange(localOffset, right.start, right.end))
    const best = candidates[0]!
    if (distanceToRange(localOffset, best.start, best.end) > 12) {
        return null
    }

    const segmentPattern = /[A-Za-z_$][\w$]*/g
    const segments = Array.from(best.text.matchAll(segmentPattern))
    const lastSegment = segments[segments.length - 1]
    if (lastSegment === undefined || lastSegment.index === undefined) {
        return null
    }

    return {
        lastSegmentStart: best.start + lastSegment.index
    }
}

function findNearestIdentifierOffset(expression: string, localOffset: number): number | null {
    const pattern = /[A-Za-z_$][\w$]*/g
    const identifiers = Array.from(expression.matchAll(pattern)).map((match) => ({
        start: match.index!,
        end: match.index! + match[0].length
    }))
    if (identifiers.length === 0) {
        return null
    }

    identifiers.sort((left, right) => distanceToRange(localOffset, left.start, left.end) - distanceToRange(localOffset, right.start, right.end))
    const best = identifiers[0]!
    return distanceToRange(localOffset, best.start, best.end) <= 12 ? best.start : null
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findCallContainer(node: ts.Node): ts.Node | null {
    let current: ts.Node | undefined = node
    while (current !== undefined) {
        if (
            ts.isFunctionDeclaration(current) ||
            ts.isFunctionExpression(current) ||
            ts.isArrowFunction(current) ||
            ts.isMethodDeclaration(current) ||
            (ts.isVariableDeclaration(current) &&
                current.initializer !== undefined &&
                (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer)))
        ) {
            return current
        }
        current = current.parent
    }
    return null
}

function getCallContainerBody(node: ts.Node): ts.ConciseBody | null {
    if (ts.isVariableDeclaration(node)) {
        return node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
            ? node.initializer.body
            : null
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
        return node.body ?? null
    }
    return null
}

function getCallTargetName(expression: ts.LeftHandSideExpression): string | null {
    if (ts.isIdentifier(expression)) {
        return expression.text
    }
    if (ts.isPropertyAccessExpression(expression)) {
        return expression.name.text
    }
    return null
}
