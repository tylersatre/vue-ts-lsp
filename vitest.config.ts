import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: {
            '@src': path.resolve(__dirname, 'src')
        }
    },
    test: {
        passWithNoTests: true,
        coverage: {
            provider: 'v8',
            include: ['src/**'],
            reporter: ['text', 'lcov'],
            // Modest starting floor just under current coverage (85% lines / 76%
            // branches at introduction) — ratchet upward as gaps close.
            thresholds: {
                lines: 80,
                functions: 90,
                branches: 70,
                statements: 80
            }
        }
    }
})
