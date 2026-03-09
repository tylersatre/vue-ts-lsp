<template>
    <BaseTextInput v-model="internalValue" />
</template>

<script setup lang="ts">
import BaseTextInput from 'Fields/BaseTextInput.vue'
import { computed, ref, watchEffect } from 'vue'

const model = defineModel<number>()
const internalValue = ref<string>('')

const amountLabel = computed(() => model.value?.toFixed(2) ?? '0.00')

watchEffect(() => {
    internalValue.value = amountLabel.value
})
</script>
