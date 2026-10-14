'use strict'

const crypto = require('node:crypto')
const { query } = require('./auth')
const ALLOWED_ACTION = /^[a-z][a-z0-9._-]{0,63}$/

async function writeAudit(event) {
  const record = {
    id: crypto.randomBytes(12).toString('hex'),
    at: new Date().toISOString(),
    actor: String(event.actor || 'system').slice(0, 64),
    action: ALLOWED_ACTION.test(String(event.action || '')) ? event.action : 'unknown',
    target: event.target ? String(event.target).slice(0, 64) : null,
    status: ['started', 'finished', 'success', 'failed'].includes(event.status) ? event.status : 'success',
    details: event.details && typeof event.details === 'object' ? event.details : null
  }
  await query('INSERT INTO dim_audit (id,event_at,actor,action,target,status,details) VALUES (?,?,?,?,?,?,?)',
    [record.id, record.at, record.actor, record.action, record.target, record.status, record.details ? JSON.stringify(record.details) : null])
  return record
}

async function readAudit(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 50, 200))
  const [rows] = await query('SELECT id,event_at AS at,actor,action,target,status,details FROM dim_audit ORDER BY event_at DESC LIMIT ?', [safeLimit])
  return rows.map(row => {
    let details = row.details
    if (typeof details === 'string') { try { details = JSON.parse(details) } catch { details = undefined } }
    return { ...row, details: details || undefined, target: row.target || undefined }
  })
}

module.exports = { writeAudit, readAudit }
