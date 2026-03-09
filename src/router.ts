import { extractRequestUri } from './helpers/identifiers.js'

export type ServerTarget = 'vtsls' | 'vue_ls'

const VUE_REQUESTS_HANDLED_BY_VTSLS = new Set([
    'textDocument/definition',
    'textDocument/implementation',
    'textDocument/hover',
    'textDocument/references',
    'textDocument/prepareCallHierarchy',
    'callHierarchy/incomingCalls',
    'callHierarchy/outgoingCalls'
])

export function routeRequest(method: string, params: unknown): ServerTarget {
    if (method === 'workspace/symbol') {
        return 'vtsls'
    }

    const uri = extractRequestUri(params)

    if (uri === null) {
        return 'vtsls'
    }

    const extension = getUriExtension(uri)

    if (extension === '.vue') {
        return VUE_REQUESTS_HANDLED_BY_VTSLS.has(method) ? 'vtsls' : 'vue_ls'
    }

    return 'vtsls'
}

function getUriExtension(uri: string): string {
    const lastSlash = uri.lastIndexOf('/')
    const filename = lastSlash >= 0 ? uri.slice(lastSlash + 1) : uri
    const dot = filename.lastIndexOf('.')
    return dot >= 0 ? filename.slice(dot) : ''
}
