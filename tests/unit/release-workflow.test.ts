import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const RELEASE_WORKFLOW_PATH = path.resolve(process.cwd(), '.github', 'workflows', 'release.yml')

describe('release workflow', () => {
    it('installs smoke fixture dependencies before running tests', () => {
        const workflow = fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8')
        const installStep = "run: npm run install:smoke-fixture"
        const testStep = "run: npm test"

        expect(workflow).toContain(installStep)
        expect(workflow.indexOf(installStep)).toBeGreaterThanOrEqual(0)
        expect(workflow.indexOf(testStep)).toBeGreaterThan(workflow.indexOf(installStep))
    })
})
