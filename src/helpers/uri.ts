import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Returns one cache/store identity for equivalent local file URI spellings while
 * leaving non-file URIs untouched. Protocol messages can continue using the
 * client's original URI.
 */
export function normalizeUriIdentity(uri: string): string {
    if (!uri.startsWith('file:')) {
        return uri
    }

    try {
        return pathToFileURL(fileURLToPath(uri)).href
    } catch {
        return uri
    }
}
