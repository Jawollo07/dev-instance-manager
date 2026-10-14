
type User = {
  username: string
  slug: string
  role: 'user' | 'admin'
  disabled: boolean
  instance: { exists: boolean; name?: string; status?: string; ip?: string | null } | null
}

type UsersResponse = {
  users: User[]
  error?: string
}

type CommandResult = {
  username: string
  slug: string
  status: string
  reason?: string
  exitCode?: number
  stdout?: string
  stderr?: string
}

type ApiResponse = {
  error?: string
  user?: User
  instance?: unknown
  ok?: boolean
  results?: CommandResult[]
  command?: string
}

type UserAction = 'create' | 'start' | 'stop'

const root = document.querySelector<HTMLDivElement>('#admin-app')
if (!root) throw new Error('Admin root not found')

root.innerHTML = `
  <div class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">DEV INSTANCE MANAGER</p>
        <h1>Administration</h1>
      </div>
      <button id="logout" class="secondary">Abmelden</button>
    </header>

    <section id="login" class="panel login" hidden>
      <h2>Admin-Anmeldung</h2>
      <p>Bitte mit einem lokalen Administratorkonto anmelden.</p>
      <form id="login-form">
        <label>
          Benutzername
          <input name="username" autocomplete="username" required maxlength="64">
        </label>
        <label>
          Passwort
          <input name="password" type="password" autocomplete="current-password" required maxlength="1024">
        </label>
        <button class="primary">Anmelden</button>
        <p id="login-message" class="message" role="status"></p>
      </form>
    </section>

    <section id="dashboard" hidden>
      <div class="stats">
        <article class="panel">
          <span>Benutzer-Workspaces</span>
          <strong id="user-count">0 / 8</strong>
        </article>
        <article class="panel">
          <span>Laufende Instanzen</span>
          <strong id="running-count">0</strong>
        </article>
        <article class="panel">
          <span>Admin-Konten</span>
          <strong id="admin-count">0</strong>
        </article>
      </div>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Neuen Benutzer erstellen</h2>
            <p>Es wird ein eigener Workspace mit eigener URL und Basic Auth angelegt.</p>
          </div>
        </div>

        <form id="create-form" class="create-form">
          <label>
            Anzeigename / Login
            <input name="username" required maxlength="64" pattern="[A-Za-z0-9@._+-]+" placeholder="test1">
          </label>
          <label>
            URL-Route
            <input name="slug" required maxlength="32" pattern="[a-z0-9][a-z0-9-]{0,31}" placeholder="test1">
          </label>
          <label>
            Startpasswort
            <input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="new-password">
          </label>
          <button class="primary" id="create-submit">Benutzer + Workspace erstellen</button>
        </form>
        <p id="create-message" class="message" role="status"></p>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Befehl auf allen Instanzen ausführen</h2>
            <p>Der Befehl läuft auf allen laufenden Benutzer-Workspaces als unprivilegierter Benutzer <code>coder</code>. Er wird nicht als root ausgeführt.</p>
          </div>
        </div>

        <form id="command-form" class="command-form">
          <label for="broadcast-command">Shell-Befehl</label>
          <textarea id="broadcast-command" name="command" required maxlength="4096" rows="3" spellcheck="false" placeholder="z. B. git -C /home/coder/project status"></textarea>
          <div class="command-actions">
            <span class="message">Gestoppte oder fehlende Instanzen werden übersprungen.</span>
            <button class="danger" id="command-submit">Auf allen laufenden Instanzen ausführen</button>
          </div>
        </form>
        <pre id="command-output" class="command-output" hidden></pre>
        <p id="command-message" class="message" role="status"></p>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Benutzer &amp; Instanzen</h2>
            <p>Jeder Workspace ist unter seiner Route erreichbar.</p>
          </div>
          <div class="head-actions">
            <button id="backup" class="secondary">Backup aller Workspaces</button>
            <button id="refresh" class="secondary">Aktualisieren</button>
          </div>
        </div>
        <div id="users" class="users"></div>
        <p id="page-message" class="message" role="status"></p>
      </section>
    </section>

    <footer>Adminzugriff nur über HTTPS · Workspaces sind per URL-Slug und HTTP Basic Auth getrennt.</footer>
  </div>
`

const style = document.createElement('style')
style.textContent = `
  :root {
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    color: #edf1fa;
    background: #0b0d12;
    color-scheme: dark;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-width: 320px;
    background: radial-gradient(ellipse at 10% 0%, #17213a, #0b0d12 50%);
  }

  button, input {
    font: inherit;
  }

  button {
    cursor: pointer;
    border: 1px solid #394459;
    border-radius: 8px;
    padding: 10px 13px;
    color: #edf1fa;
    background: #1a2231;
  }

  button:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  .primary { background: #3568b5; border-color: #4e81d0; }
  .secondary { background: #151b27; }
  .danger { border-color: #773b45; background: #3b2026; }

  .page {
    max-width: 1200px;
    margin: auto;
    padding: 30px 22px;
  }

  .topbar,
  .section-head,
  .head-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .head-actions { flex-wrap: wrap; }

  .topbar {
    padding-bottom: 24px;
    border-bottom: 1px solid #252c39;
    margin-bottom: 24px;
  }

  .eyebrow {
    font-size: 10px;
    letter-spacing: 0.17em;
    color: #8ea1c4;
    font-weight: 800;
    margin: 0 0 5px;
  }

  h1 { font-size: 28px; margin: 0; }
  h2 { font-size: 18px; margin: 0 0 7px; }

  .panel {
    border: 1px solid #30394b;
    border-radius: 14px;
    background: #151b27;
    padding: 20px;
    margin-bottom: 18px;
  }

  .panel p,
  .section-head p {
    font-size: 13px;
    color: #a6b1c5;
    line-height: 1.5;
    margin: 5px 0 0;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }

  .stats article {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .stats span {
    font-size: 12px;
    color: #a6b1c5;
  }

  .stats strong { font-size: 26px; }

  .create-form {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 18px;
    align-items: end;
  }

  .create-form label,
  .login label {
    display: flex;
    flex-direction: column;
    gap: 7px;
    color: #b8c3d8;
    font-size: 12px;
  }

  .command-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 16px;
  }

  .command-form label {
    font-size: 12px;
    color: #b8c3d8;
  }

  .command-form textarea {
    width: 100%;
    resize: vertical;
    min-height: 84px;
    border: 1px solid #394459;
    border-radius: 8px;
    background: #0d121b;
    padding: 12px;
    color: #edf1fa;
    font: 13px ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  .command-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .command-output {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 520px;
    overflow: auto;
    border: 1px solid #30394b;
    border-radius: 8px;
    background: #0b1018;
    padding: 14px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    color: #d7e0ef;
  }

  .command-output[hidden] { display: none; }

  .create-form input,
  .login input {
    width: 100%;
    min-width: 0;
    border: 1px solid #394459;
    border-radius: 8px;
    background: #0d121b;
    padding: 11px;
    color: #edf1fa;
  }

  .users {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 18px;
  }

  .user {
    border: 1px solid #30394b;
    border-radius: 11px;
    padding: 15px;
    display: grid;
    grid-template-columns: minmax(180px, 1.2fr) minmax(160px, 1fr) auto;
    gap: 12px;
    align-items: center;
  }

  .user h3 {
    font-size: 14px;
    margin: 0 0 5px;
  }

  .user p {
    font-size: 12px;
    color: #a6b1c5;
    margin: 4px 0;
    overflow-wrap: anywhere;
  }

  .user a {
    color: #9fc4ff;
    text-decoration: none;
  }

  .pill {
    display: inline-block;
    border-radius: 999px;
    background: #263345;
    padding: 5px 8px;
    font-size: 11px;
  }

  .pill.running { color: #7ee0b5; background: #15352c; }
  .pill.stopped { color: #f3c781; background: #3a2c18; }
  .pill.disabled { color: #f3a2a2; background: #3d2225; }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    justify-content: flex-end;
  }

  .actions button {
    font-size: 12px;
    padding: 8px 10px;
  }

  .message {
    font-size: 12px;
    color: #b9c8df;
    min-height: 16px;
  }

  .login {
    max-width: 430px;
    margin: 60px auto;
  }

  .login form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 18px;
  }

  footer {
    font-size: 11px;
    color: #77849b;
    padding: 10px 2px 30px;
  }

  @media (max-width: 800px) {
    .create-form { grid-template-columns: 1fr 1fr; }
    .create-form button { grid-column: 1 / -1; }
    .user { grid-template-columns: 1fr; }
    .actions { justify-content: flex-start; }
  }

  @media (max-width: 520px) {
    .stats { grid-template-columns: 1fr; }
    .create-form { grid-template-columns: 1fr; }
    .create-form button { grid-column: auto; }
    .page { padding: 20px 12px; }
    .panel { padding: 15px; }
  }
`
document.head.append(style)

const login = document.getElementById('login') as HTMLElement
const dashboard = document.getElementById('dashboard') as HTMLElement
const loginForm = document.getElementById('login-form') as HTMLFormElement
const loginMessage = document.getElementById('login-message') as HTMLElement
const createForm = document.getElementById('create-form') as HTMLFormElement
const createMessage = document.getElementById('create-message') as HTMLElement
const pageMessage = document.getElementById('page-message') as HTMLElement
const usersNode = document.getElementById('users') as HTMLElement
const logout = document.getElementById('logout') as HTMLButtonElement
const refreshButton = document.getElementById('refresh') as HTMLButtonElement
const backupButton = document.getElementById('backup') as HTMLButtonElement
const createSubmit = document.getElementById('create-submit') as HTMLButtonElement
const commandForm = document.getElementById('command-form') as HTMLFormElement
const commandSubmit = document.getElementById('command-submit') as HTMLButtonElement
const commandOutput = document.getElementById('command-output') as HTMLPreElement
const commandMessage = document.getElementById('command-message') as HTMLElement

const USER_ACTION_LABELS: Record<UserAction, string> = {
  create: 'Erstellen',
  start: 'Starten',
  stop: 'Stoppen',
}

async function api<T extends ApiResponse>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const data = (await response.json()) as T
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function showLogin(message = 'Bitte mit einem Administratorkonto anmelden.') {
  login.hidden = false
  dashboard.hidden = true
  logout.hidden = true
  loginMessage.textContent = message
}

function showDashboard() {
  login.hidden = true
  dashboard.hidden = false
  logout.hidden = false
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function getUserPillClass(user: User): string {
  if (user.disabled) return 'disabled'
  if (user.role === 'admin') return 'stopped'
  return user.instance?.status === 'Running' ? 'running' : 'stopped'
}

function getUserStatusLabel(user: User): string {
  if (user.disabled) return 'Gesperrt'
  if (user.role === 'admin') return 'Admin-Konto'
  return user.instance?.status || 'Unbekannt'
}

function buildUserCard(user: User): HTMLElement {
  const card = el('article', 'user')
  const details = el('div', 'details')
  details.append(el('h3', '', user.username + (user.role === 'admin' ? ' · Admin' : '')))
  details.append(el('p', '', 'Route: /' + user.slug))

  if (user.role === 'user') {
    const link = el('a', '', window.location.origin + '/' + user.slug) as HTMLAnchorElement
    link.href = '/' + encodeURIComponent(user.slug)
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    details.append(link)
  }

  const state = el('div', 'state')
  const pill = el('span', 'pill ' + getUserPillClass(user), getUserStatusLabel(user))
  state.append(pill)

  if (user.instance?.ip) {
    state.append(el('p', '', 'VM-IP: ' + user.instance.ip))
  }

  const actions = el('div', 'actions')
  if (user.role === 'user') {
    for (const operation of ['create', 'start', 'stop'] as const) {
      const button = el('button', 'secondary', USER_ACTION_LABELS[operation])
      button.addEventListener('click', () => void instanceAction(user, operation, button))
      actions.append(button)
    }

    const toggle = el('button', 'secondary', user.disabled ? 'Entsperren' : 'Sperren')
    toggle.addEventListener('click', () => void toggleUser(user, toggle))
    actions.append(toggle)

    const reset = el('button', 'secondary', 'Passwort setzen')
    reset.addEventListener('click', () => void resetPassword(user, reset))
    actions.append(reset)

    const remove = el('button', 'danger', 'Löschen')
    remove.addEventListener('click', () => void deleteUser(user, remove))
    actions.append(remove)
  }

  card.append(details, state, actions)
  return card
}

function formatCommandResults(results: CommandResult[]): string {
  if (!results.length) return 'Keine Benutzer-Workspaces vorhanden.'

  const lines: string[] = []
  for (const item of results) {
    const exitInfo = item.exitCode === undefined ? '' : ' · Exit-Code ' + item.exitCode
    lines.push(`=== ${item.username} (/${item.slug}) · ${item.status}${exitInfo} ===`)

    if (item.reason) lines.push(item.reason)
    if (item.stdout) lines.push('STDOUT:\n' + item.stdout.trimEnd())
    if (item.stderr) lines.push('STDERR:\n' + item.stderr.trimEnd())
    if (!item.stdout && !item.stderr && !item.reason) lines.push('(keine Ausgabe)')
    lines.push('')
  }

  return lines.join('\n')
}

async function loadUsers() {
  refreshButton.disabled = true
  pageMessage.textContent = 'Lade Benutzer …'

  try {
    const data = await api<UsersResponse>('/api/admin/users')
    const normalUsers = data.users.filter(user => user.role === 'user')

    document.getElementById('user-count')!.textContent = `${normalUsers.length} / 8`
    document.getElementById('running-count')!.textContent = String(
      normalUsers.filter(user => user.instance?.status === 'Running').length,
    )
    document.getElementById('admin-count')!.textContent = String(
      data.users.filter(user => user.role === 'admin').length,
    )

    usersNode.replaceChildren()
    if (!data.users.length) {
      usersNode.append(el('p', 'message', 'Noch keine Benutzer vorhanden.'))
    }

    for (const user of data.users) {
      usersNode.append(buildUserCard(user))
    }

    pageMessage.textContent = 'Stand: ' + new Date().toLocaleTimeString()
  } catch (err) {
    if (err instanceof Error && /401|403|Admin-Berechtigung/.test(err.message)) {
      showLogin('Dieses Konto hat keine Admin-Berechtigung. Bitte als Admin anmelden.')
    } else {
      pageMessage.textContent = err instanceof Error ? err.message : 'Laden fehlgeschlagen.'
    }
  } finally {
    refreshButton.disabled = false
  }
}

async function instanceAction(user: User, op: UserAction, button: HTMLButtonElement) {
  button.disabled = true
  pageMessage.textContent = `${user.username}: ${op} läuft …`

  try {
    await api('/api/admin/users/' + encodeURIComponent(user.username) + '/instance/' + op, 'POST', {})
    await loadUsers()
  } catch (err) {
    pageMessage.textContent = err instanceof Error ? err.message : 'Aktion fehlgeschlagen.'
  } finally {
    button.disabled = false
  }
}

async function toggleUser(user: User, button: HTMLButtonElement) {
  button.disabled = true

  try {
    await api('/api/admin/users/' + encodeURIComponent(user.username), 'PATCH', { disabled: !user.disabled })
    await loadUsers()
  } catch (err) {
    pageMessage.textContent = err instanceof Error ? err.message : 'Aktion fehlgeschlagen.'
  } finally {
    button.disabled = false
  }
}

async function resetPassword(user: User, button: HTMLButtonElement) {
  const password = window.prompt('Neues Passwort für ' + user.username + ' (mindestens 12 Zeichen):')
  if (password === null) return

  button.disabled = true

  try {
    await api('/api/admin/users/' + encodeURIComponent(user.username), 'PATCH', { password })
    pageMessage.textContent = 'Passwort aktualisiert.'
  } catch (err) {
    pageMessage.textContent = err instanceof Error ? err.message : 'Passwort konnte nicht geändert werden.'
  } finally {
    button.disabled = false
  }
}

async function deleteUser(user: User, button: HTMLButtonElement) {
  if (!window.confirm('Benutzer ' + user.username + ' und seine VM samt Projekten unwiderruflich löschen? Erstelle vorher ein Backup.')) return

  button.disabled = true

  try {
    await api('/api/admin/users/' + encodeURIComponent(user.username), 'DELETE')
    await loadUsers()
  } catch (err) {
    pageMessage.textContent = err instanceof Error ? err.message : 'Löschen fehlgeschlagen.'
  } finally {
    button.disabled = false
  }
}

commandForm.addEventListener('submit', async event => {
  event.preventDefault()

  const command = String(new FormData(commandForm).get('command') ?? '').trim()
  if (!command) {
    commandMessage.textContent = 'Bitte einen Befehl eingeben.'
    return
  }

  if (!window.confirm('Diesen Befehl auf allen laufenden Benutzer-Workspaces als coder ausführen? Prüfe besonders Befehle, die Dateien ändern oder löschen.')) {
    return
  }

  commandSubmit.disabled = true
  commandMessage.textContent = 'Befehl wird auf allen laufenden Instanzen ausgeführt …'
  commandOutput.hidden = true

  try {
    const result = await api<ApiResponse>('/api/admin/commands', 'POST', { command })
    const results = result.results ?? []

    commandOutput.textContent = formatCommandResults(results)
    commandOutput.hidden = false

    const success = results.filter(item => item.status === 'success').length
    const failed = results.filter(item => item.status === 'failed').length
    const skipped = results.filter(item => item.status === 'skipped').length
    commandMessage.textContent = `Fertig: ${success} erfolgreich, ${failed} fehlgeschlagen, ${skipped} übersprungen.`
  } catch (err) {
    commandMessage.textContent = err instanceof Error ? err.message : 'Befehl fehlgeschlagen.'
  } finally {
    commandSubmit.disabled = false
  }
})

createForm.addEventListener('submit', async event => {
  event.preventDefault()

  createSubmit.disabled = true
  createMessage.textContent = 'Benutzer und VM werden erstellt. Das kann einige Minuten dauern …'

  const form = new FormData(createForm)
  try {
    await api('/api/admin/users', 'POST', {
      username: String(form.get('username') || ''),
      slug: String(form.get('slug') || ''),
      password: String(form.get('password') || ''),
    })
    createForm.reset()
    createMessage.textContent = 'Benutzer und Workspace angelegt.'
    await loadUsers()
  } catch (err) {
    createMessage.textContent = err instanceof Error ? err.message : 'Erstellen fehlgeschlagen.'
  } finally {
    createSubmit.disabled = false
  }
})

loginForm.addEventListener('submit', async event => {
  event.preventDefault()

  const form = new FormData(loginForm)
  const button = loginForm.querySelector('button') as HTMLButtonElement
  button.disabled = true

  try {
    await api('/api/auth/login', 'POST', {
      username: String(form.get('username') || ''),
      password: String(form.get('password') || ''),
    })
    showDashboard()
    await loadUsers()
  } catch (err) {
    loginMessage.textContent = err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen.'
  } finally {
    button.disabled = false
  }
})

logout.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', 'POST', {})
    showLogin('Abgemeldet.')
  } catch (err) {
    pageMessage.textContent = err instanceof Error ? err.message : 'Abmeldung fehlgeschlagen.'
  }
})

refreshButton.addEventListener('click', () => void loadUsers())

backupButton.addEventListener('click', async () => {
  if (!window.confirm('Backup aller dev-* Workspaces jetzt starten? Dies kann mehrere Minuten dauern.')) return

  backupButton.disabled = true
  pageMessage.textContent = 'Backup läuft … bitte warten.'

  try {
    const result = await api<ApiResponse & { output?: string }>('/api/admin/backups', 'POST', {})
    pageMessage.textContent = result.output || 'Backup abgeschlossen.'
  } catch (err) {
    pageMessage.textContent = err instanceof Error ? err.message : 'Backup fehlgeschlagen.'
  } finally {
    backupButton.disabled = false
  }
})

async function init() {
  try {
    await api('/api/auth/me')
    showDashboard()
    await loadUsers()
  } catch {
    showLogin()
  }
}

void init()
