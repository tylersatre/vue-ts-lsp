<template>
    <button
        class="action-button"
        :id="id"
        :disabled="disabled"
        @click="emit('click')"
    >
        {{ buttonText }}
    </button>
</template>

<script setup lang="ts">
defineProps<{
    buttonText?: string
    disabled?: boolean
    id?: string
}>()

const emit = defineEmits<{
    (e: 'click'): void
}>()
</script>
