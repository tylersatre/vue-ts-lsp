<template>
    <input
        :value="modelValue"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
</template>

<script setup lang="ts">
defineProps<{
    modelValue?: string | number
}>()

defineEmits<{
    (e: 'update:modelValue', value: string): void
}>()
</script>
