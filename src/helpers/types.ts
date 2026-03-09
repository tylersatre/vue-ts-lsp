import type { Position, Range } from 'vscode-languageserver-protocol'

export type TsserverRequestShape = 'flat' | 'nested'

export interface ParsedTsserverRequest {
    id: number
    command: string
    args: unknown
    shape: TsserverRequestShape
}

export interface DefinitionClassification {
    kind: 'empty' | 'self' | 'workspace' | 'external-library' | 'mixed'
    count: number
    hasSelf: boolean
    hasWorkspace: boolean
    hasExternalLibrary: boolean
}

export type DefinitionLocation =
    | { uri: string; range?: Range }
    | {
          targetUri: string
          targetSelectionRange?: Range
          targetRange?: Range
          originSelectionRange?: Range
      }

export interface VueImportTarget {
    moduleSpecifier: string
    importKind: 'named' | 'default' | 'namespace'
    importedName: string | null
    localName: string
}

export interface ResolvedVueImportTarget extends VueImportTarget {
    selectionPosition: Position
}

export interface DefinitionProbe {
    uri: string
    text: string
    position: Position
}

export interface OutgoingCallTarget {
    name: string
    range: Range
}

export interface SymbolMatch {
    uri: string
    name: string
    kind: number
    range: Range
    selectionRange: Range
    detail?: string
}

export interface StoreToRefsBindingMatch {
    localName: string
    propertyName: string
    storeFactoryName: string | null
}

export type ReferenceTargetKind = 'component' | 'enum' | 'function' | 'interface' | 'method' | 'type-alias' | 'variable'

export interface ReferenceTarget {
    name: string
    kind: ReferenceTargetKind
    exported: boolean
    range: Range
    selectionRange: Range
}

export interface TextDocumentContentChangeLike {
    range?: Range
    text: string
}
