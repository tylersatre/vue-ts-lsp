/// <reference types="vitest" />
import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            State: path.resolve('app/js/state'),
            UiKit: path.resolve('app/js/ui-kit'),
            App: path.resolve('app/js'),
            Domain: path.resolve('app/js/domain'),
            Theme: path.resolve('app/styles'),
            Fields: path.resolve('app/js/ui-kit/components/fields'),
            vue: 'vue/dist/vue.esm-bundler.js'
        }
    },
    server: {
        port: 8181,
        host: true,
        watch: {
            usePolling: true,
            interval: 250,
            awaitWriteFinish: {
                stabilityThreshold: 125,
                pollInterval: 25
            },
            ignored: ['**/node_modules/**', '**/.git/**']
        }
    },
    build: {
        sourcemap: 'hidden'
    },
    test: {
        dir: 'tests',
        setupFiles: ['./tests/setup.ts'],
        environment: 'jsdom',
        globals: true
    },
    css: {
        preprocessorOptions: {
            scss: {
                quietDeps: true
            }
        }
    }
})
