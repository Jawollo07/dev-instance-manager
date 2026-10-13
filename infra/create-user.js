#!/usr/bin/env node
'use strict'

// Run as the API service account so the JSON store remains writable by that account.
// Read the password from stdin; never put it in argv.
// Usage: printf '%s' "$PASSWORD" | node infra/create-user.js <username> <slug> [--admin]

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const username = process.argv[2] || ''
const slug = process.argv[3] || ''
const role = process.argv[4] === '--admin' ? 'admin' : 'user'
const file = process.env.DIM_USERS_FILE || '/var/lib/dev-instance-manager-users/users.json'

async function main() {
  if (!/^[a-zA-Z0-9@._+-]{1,64}$/.test(username)) throw new Error('Ungültiger Benutzername.')
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) throw new Error('Slug muss aus Kleinbuchstaben, Ziffern und Bindestrichen bestehen.')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('Passwort muss mindestens 12 Zeichen lang sein und höchstens 1024 Byte enthalten.')
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  let store = { users: [] }
  try {
    store = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!store || !Array.isArray(store.users)) throw new Error('Ungültiges Benutzerdateiformat.')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (store.users.some(user => user.username !== username && (user.slug === slug || user.username.toLowerCase() === username.toLowerCase()))) {
    throw new Error('Benutzername oder Slug ist bereits vergeben.')
  }
  const salt = crypto.randomBytes(16)
  const hash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, value) => err ? reject(err) : resolve(value)))
  const user = { username, slug, role, disabled: false, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: new Date().toISOString() }
  const index = store.users.findIndex(item => item.username === username)
  if (index >= 0) store.users[index] = user
  else store.users.push(user)
  const temp = file + '.tmp-' + process.pid
  await fs.writeFile(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await fs.rename(temp, file)
  await fs.chmod(file, 0o600)
  console.log(`Konto ${username} (${role}) wurde ${index >= 0 ? 'aktualisiert' : 'angelegt'}.`)
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
