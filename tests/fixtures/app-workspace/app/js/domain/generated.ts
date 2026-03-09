import type { LineItemId, ScenarioId } from 'Domain/types'

export interface ScenarioLineItem {
    identifier: LineItemId
    amount: number
    metric: number
    name: string
    category: string
    itemIndex: number
}

export interface ScenarioRecord {
    identifier: ScenarioId
    lineItems: ScenarioLineItem[]
}
