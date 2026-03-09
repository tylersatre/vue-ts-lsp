function extractHoverText(value: unknown): string {
    if (typeof value === 'string') {
        return value
    }

    if (Array.isArray(value)) {
        return value.map((entry) => extractHoverText(entry)).join('\n')
    }

    if (value === null || value === undefined || typeof value !== 'object') {
        return ''
    }

    if ('value' in value) {
        return extractHoverText((value as { value: unknown }).value)
    }

    if ('contents' in value) {
        return extractHoverText((value as { contents: unknown }).contents)
    }

    return ''
}

export function hoverResultLooksAny(result: unknown): boolean {
    const text = extractHoverText(result)
        .replace(/```[a-z0-9_-]*\n?/gi, ' ')
        .replace(/```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

    if (text.length === 0) {
        return false
    }

    return (
        text === 'any' ||
        (/\bany\b/.test(text) &&
            (/\b:\s*any\b/.test(text) || /\b=>\s*any\b/.test(text) || /\b(?:const|let|var)\s+\w+\s*:\s*any\b/.test(text) || /\b\w+\s*:\s*any\b/.test(text)))
    )
}
