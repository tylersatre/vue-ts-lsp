import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const RELEASE_WORKFLOW_PATH = path.resolve(process.cwd(), '.github', 'workflows', 'release.yml')

const CI_WORKFLOW_PATH = path.resolve(process.cwd(), '.github', 'workflows', 'ci.yml')
const STDOUT_GUARD_PATTERN = String.raw`console\.[A-Za-z]+\(|process\.stdout`

describe('release workflow', () => {
    it('installs smoke fixture dependencies before running tests', () => {
        const workflow = fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8')
        const installStep = 'run: npm run install:smoke-fixture'
        const testStep = 'run: npm test'

        expect(workflow).toContain(installStep)
        expect(workflow.indexOf(installStep)).toBeGreaterThanOrEqual(0)
        expect(workflow.indexOf(testStep)).toBeGreaterThan(workflow.indexOf(installStep))
    })

    it('runs the broadened stdout guard before publishing', () => {
        const workflow = fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8')
        expect(workflow).toContain(STDOUT_GUARD_PATTERN)
    })

    it('requests npm provenance on the publish step', () => {
        const workflow = fs.readFileSync(RELEASE_WORKFLOW_PATH, 'utf8')
        expect(workflow).toContain('NPM_CONFIG_PROVENANCE')
    })
})

describe('ci workflow', () => {
    it('runs the broadened stdout guard (not just console.log)', () => {
        const workflow = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8')
        expect(workflow).toContain(STDOUT_GUARD_PATTERN)
        // The exclusion must stay line-scoped: excluding the whole upstream.ts file
        // would whitelist debug prints in the module that owns the stdout transport.
        expect(workflow).toContain("grep -v 'StreamMessageWriter(process.stdout)'")
        expect(workflow).not.toContain("grep -v 'src/upstream.ts")
    })

    it('runs format:check', () => {
        const workflow = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8')
        expect(workflow).toContain('npm run format:check')
    })

    it('runs the test suite with coverage so thresholds gate PRs', () => {
        const workflow = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8')
        expect(workflow).toContain('npm run test:coverage')
    })
})

describe('dependency policy', () => {
    it('tells Dependabot never to offer TypeScript major updates (no TS 7 API)', () => {
        const dependabot = fs.readFileSync(path.resolve(process.cwd(), '.github', 'dependabot.yml'), 'utf8')
        expect(dependabot).toContain('dependency-name: typescript')
        expect(dependabot).toContain('version-update:semver-major')
    })

    it('keeps typescript pinned to the 6.x line', () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
            dependencies: Record<string, string>
        }
        expect(pkg.dependencies['typescript']).toMatch(/^\^6\./)
    })
})
