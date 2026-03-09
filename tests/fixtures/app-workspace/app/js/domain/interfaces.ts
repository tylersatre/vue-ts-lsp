import type { ChargeId } from 'Domain/types'

export interface ScenarioCharge {
    identifier: ChargeId
    name: string
    slug: string
    amount: number
    adjustment?: boolean
}

export interface ChargeGroup {
    name: string
    slug: string
    total: number
    charges: ScenarioCharge[]
}

export interface ScenarioSnapshot {
    title: string
    lastUpdatedAt: string
    groups: ChargeGroup[]
}
