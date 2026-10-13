#!/usr/bin/env node
'use strict'

// Usage: read the password from stdin, never from command-line arguments:
//   read -rsp 'Password: ' PASSWORD; printf '\n'; printf '%s' "$PASSWORD" | sudo -E node infra/create-user.js alice
// Run as root; users.json must remain root-owned and unreadable by other users.

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const username = process.argv[2] || ''
const file = process.env.DIM_USERS_FILE || '/etc/dev-instance-manager/users.json'

async function main() {
  if (!/^[a-zA-Z0-9@._+-]{1,64}$/.test(username)) throw new Error('Ungültiger Benutzername (1–64 Zeichen: Buchstaben, Ziffern, @ . _ + -).')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('Passwort muss mindestens 12 Zeichen lang sein und höchstens 1024 Byte enthalten.')
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  let store = { users: [] }
  try {
    store = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!store || !Array.isArray(store.users)) throw new Error('Ungültiges Benutzerdateiformat.')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const salt = crypto.randomBytes(16)
  const hash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, value) => err ? reject(err) : resolve(value)))
  const user = { username, salt: salt.toString('hex'), hash: hash.toString('hex'), disabled: false }
  const index = store.users.findIndex(item => item.username === username)
  if (index >= 0) store.users[index] = user
  else store.users.push(user)
  const temp = file + '.tmp-' + process.pid
  await fs.writeFile(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await fs.rename(temp, file)
  await fs.chmod(file, 0o640)
  console.log(`Benutzer ${username} wurde ${index >= 0 ? 'aktualisiert' : 'angelegt'}.`)
}

main().catch(err => { console.error(err.message); process.exitCode = 1 })
