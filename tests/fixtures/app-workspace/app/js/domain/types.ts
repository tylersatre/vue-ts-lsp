export type Brand<T, B extends string> = T & { readonly __brand: B }

export type ChargeId = Brand<string, 'ChargeId'>
export type LineItemId = Brand<string, 'LineItemId'>
export type ScenarioId = Brand<string, 'ScenarioId'>

export interface VisibilityMap {
    [key: string]: boolean
}

export enum WorkspaceViewMode {
    Summary = 'summary',
    Detail = 'detail'
}
