<template>
    <section class="charge-editor">
        <div
            v-for="charge in charges"
            :key="charge.identifier"
            class="charge-row"
        >
            <TextField v-model="charge.name" />
            <CurrencyField v-model="charge.amount" />
        </div>
    </section>
</template>

<script setup lang="ts">
import type { ScenarioCharge } from 'Domain/interfaces'
import CurrencyField from 'Fields/CurrencyField.vue'
import TextField from './TextField.vue'
import { ref } from 'vue'

const charges = ref<ScenarioCharge[]>([
    {
        identifier: 'charge-1' as ScenarioCharge['identifier'],
        name: 'Kickoff review',
        slug: 'kickoff-review',
        amount: 240
    }
])
</script>
