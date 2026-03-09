<template>
    <div
        class="t-list-tile"
        :class="{ 't-list-tile-title': title }"
        :data-testid="dataTestid"
    >
        <div
            class="t-list-tile-name"
            :class="{ 't-list-tile-bold': bold }"
        >
            {{ displayName }}
        </div>
        <div
            v-if="amount !== null"
            class="t-list-tile-fee"
            :class="{ 't-list-tile-bold': bold }"
            :id="amountId"
        >
            {{ adjustment ? `(${displayAmount})` : displayAmount }}
        </div>
        <div class="t-list-tile-addon">
            <slot></slot>
        </div>
    </div>
</template>

<script setup lang="ts">
import { formatCurrency } from 'App/utils/misc'
import { camelCase } from 'lodash'
import { computed } from 'vue'

interface Props {
    name: string
    amount?: number | string | null
    title?: boolean
    bold?: boolean
    adjustment?: boolean
    dataTestid?: string
}

const props = withDefaults(defineProps<Props>(), {
    amount: null,
    title: false,
    bold: false,
    adjustment: false
})

const displayAmount = computed(() => {
    return typeof props.amount === 'number' ? formatCurrency(props.amount) : props.amount
})

const amountId = computed(() => camelCase(props.name))
const displayName = computed(() => props.name)
</script>

<style scoped lang="scss">
.t-list-tile {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 12px;
    align-items: center;
}

.t-list-tile-name {
    min-width: 0;
}

.t-list-tile-fee {
    text-align: right;
}

.t-list-tile-bold {
    font-weight: 700;
}

.t-list-tile-addon {
    display: flex;
    justify-content: end;
}
</style>
