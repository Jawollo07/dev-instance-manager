'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { writeAudit, readAudit } = require('../../lib/audit')

test('audit events are stored without command or password payloads and returned newest first', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dim-audit-'))
  const previous = process.env.DIM_AUDIT_FILE
  process.env.DIM_AUDIT_FILE = path.join(dir, 'audit.jsonl')
  t.after(async () => {
    if (previous === undefined) delete process.env.DIM_AUDIT_FILE
    else process.env.DIM_AUDIT_FILE = previous
    await fs.rm(dir, { recursive: true, force: true })
  })

  await writeAudit({ actor: 'admin', action: 'workspace.start', target: 'test1', status: 'success', details: { slug: 'test1' } })
  await writeAudit({ actor: 'admin', action: 'user.password.reset', target: 'test1', status: 'success' })
  const events = await readAudit(1)
  assert.equal(events.length, 1)
  assert.equal(events[0].action, 'user.password.reset')
  assert.equal(events[0].actor, 'admin')
  assert.equal(events[0].target, 'test1')

  const raw = await fs.readFile(process.env.DIM_AUDIT_FILE, 'utf8')
  assert.equal(raw.includes('password123'), false)
  assert.equal((await fs.stat(process.env.DIM_AUDIT_FILE)).mode & 0o077, 0)
})
