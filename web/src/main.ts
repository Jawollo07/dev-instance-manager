type AuthResponse = {
  user?: string
  role?: 'admin' | 'user'
  redirectTo?: string
  error?: string
}

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('App root not found')

root.innerHTML = \`
  <main class="shell">
    <section class="card">
      <div class="mark" aria-hidden="true">⌘</div>
      <p class="eyebrow">PRIVATE DEVELOPMENT PLATFORM</p>
      <h1>Dev Instance Manager</h1>
      <p class="intro">Melde dich an. Wir öffnen automatisch deinen persönlichen VS Code Workspace oder die Administration.</p>
      <form id="login-form">
        <label for="username">Benutzername</label>
        <input id="username" name="username" autocomplete="username" maxlength="64" required autofocus>
        <label for="password">Passwort</label>
        <input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
        <button id="submit" type="submit">Anmelden <span aria-hidden="true">→</span></button>
        <p id="message" role="status" aria-live="polite"></p>
      </form>
      <footer>Self-hosted · Sichere Sitzung · Persönliche Entwicklungsumgebung</footer>
    </section>
  </main>
\`

const style = document.createElement('style')
style.textContent = \`
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#edf1fa;background:#0b0d12;color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-width:320px;min-height:100vh;background:radial-gradient(ellipse at 15% 0%,#17213a,#0b0d12 56%)}
  .shell{min-height:100vh;display:grid;place-items:center;padding:24px}
  .card{width:min(100%,430px);padding:32px;border:1px solid #30394b;border-radius:18px;background:linear-gradient(145deg,#191f2ef5,#11151ef5);box-shadow:0 24px 70px #0005}
  .mark{width:46px;height:46px;display:grid;place-items:center;border:1px solid #394b71;border-radius:13px;background:#1b2944;color:#b8d0ff;font-size:27px;margin-bottom:26px}
  .eyebrow{font-size:10px;letter-spacing:.17em;color:#91a7cb;font-weight:800;margin:0 0 8px}
  h1{font-size:27px;letter-spacing:-.04em;margin:0}
  .intro{color:#a3aec2;font-size:13px;line-height:1.7;margin:12px 0 26px}
  form{display:flex;flex-direction:column;gap:9px}
  label{font-size:12px;color:#b8c3d8;margin-top:7px}
  input{width:100%;min-width:0;border:1px solid #394459;border-radius:9px;background:#0d121b;padding:12px;color:#edf1fa;font:inherit}
  input:focus{outline:2px solid #729bd7;outline-offset:1px}
  button{display:flex;align-items:center;justify-content:space-between;margin-top:13px;border:1px solid #b6d4ff;border-radius:9px;padding:12px 14px;background:#b6d4ff;color:#0d1b30;font:inherit;font-size:13px;font-weight:750;cursor:pointer}
  button:disabled{opacity:.6;cursor:wait}
  #message{min-height:18px;margin:5px 0 0;font-size:12px;line-height:1.5;color:#a3aec2}
  #message.error{color:#ff9ca3}
  footer{border-top:1px solid #2a3240;margin-top:25px;padding-top:17px;color:#77849b;font-size:10px;line-height:1.6}
  @media(max-width:480px){.shell{padding:14px}.card{padding:24px}}
\`
document.head.append(style)

const form = document.getElementById('login-form') as HTMLFormElement
const username = document.getElementById('username') as HTMLInputElement
const password = document.getElementById('password') as HTMLInputElement
const submit = document.getElementById('submit') as HTMLButtonElement
const message = document.getElementById('message') as HTMLElement

function showError(text: string) {
  message.textContent = text
  message.className = 'error'
}

async function redirectIfAuthenticated() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json() as AuthResponse
    if (data.redirectTo) window.location.replace(data.redirectTo)
  } catch {
    // Keep the login form usable if the session endpoint is temporarily unavailable.
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  submit.disabled = true
  message.className = ''
  message.textContent = 'Anmeldung wird geprüft …'

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value })
    })
    const data = await response.json() as AuthResponse
    if (!response.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen.')
    if (!data.redirectTo) throw new Error('Für dieses Konto ist kein Ziel konfiguriert.')
    password.value = ''
    message.textContent = 'Erfolgreich angemeldet. Workspace wird geöffnet …'
    window.location.assign(data.redirectTo)
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen.')
    password.value = ''
    password.focus()
    submit.disabled = false
  }
})

void redirectIfAuthenticated()
