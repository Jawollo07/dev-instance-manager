'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const FILE = () => process.env.DIM_AUDIT_FILE || path.join(path.dirname(process.env.DIM_USERS_FILE || '/var/lib/dev-instance-manager-users/users.json'), 'audit.jsonl')
const ALLOWED_ACTION = /^[a-z][a-z0-9._-]{0,63}$/

async function writeAudit(event) {
  const record = {
    id: crypto.randomBytes(12).toString('hex'),
    at: new Date().toISOString(),
    actor: String(event.actor || 'system').slice(0, 64),
    action: ALLOWED_ACTION.test(String(event.action || '')) ? event.action : 'unknown',
    target: event.target ? String(event.target).slice(0, 64) : undefined,
    status: ['started', 'finished', 'success', 'failed'].includes(event.status) ? event.status : 'success',
    details: event.details && typeof event.details === 'object' ? event.details : undefined
  }
  const file = FILE()
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 })
  await fs.chmod(file, 0o600)
  return record
}

async function readAudit(limit = 50) {
  let content
  try { content = await fs.readFile(FILE(), 'utf8') }
  catch (err) { if (err.code === 'ENOENT') return []; throw err }
  const lines = content.split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 200)))
  const events = []
  for (const line of lines.reverse()) {
    try {
      const item = JSON.parse(line)
      if (item && typeof item.at === 'string' && typeof item.actor === 'string' && typeof item.action === 'string') events.push(item)
    } catch {}
  }
  return events
}

module.exports = { writeAudit, readAudit }
