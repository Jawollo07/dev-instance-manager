type Instance = { exists: boolean; name: string; network: string | null; status: string; ip: string | null }
type InstanceResponse = { user: string; instance: Instance }
type ActionResponse = { instance: Instance; error?: string }
type ErrorResponse = { error?: string }
const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('App root not found')
root.innerHTML = `
<main class="shell">
<header class="topbar"><div class="mark">⌘</div><div><p class="eyebrow">DEVELOPMENT PLATFORM</p><h1>Dev Instance Manager</h1></div><span class="private"><i></i> Private workspace</span></header>
<section class="intro"><p class="eyebrow">YOUR ENVIRONMENT</p><h2>Dein persönlicher Entwicklungsplatz.</h2><p class="sub">Eine isolierte Ubuntu-VM mit VS Code im Browser. Deine Projekte bleiben erhalten, wenn du die Instanz stoppst.</p></section>
<section class="workspace"><div class="cardhead"><div class="vscode">VS</div><div class="name"><h3>Mein Workspace</h3><p id="username">Authentifizierung wird geprüft …</p></div><span id="status" class="pill"><i></i><span id="status-label">Lade Status</span></span></div>
<div class="metrics"><div><small>CPU-Limit</small><b>2 vCPU</b></div><div><small>Arbeitsspeicher</small><b>3 GiB</b></div><div><small>Projektlaufwerk</small><b>20 GiB</b></div><div><small>Isolation</small><b>Eigene VM</b></div></div>
<div class="actions"><button id="create" class="primary">Workspace erstellen</button><button id="start">Starten</button><button id="stop">Stoppen</button><button id="open" class="open" disabled>VS Code öffnen ↗</button><button id="refresh" class="refresh" title="Status aktualisieren" aria-label="Status aktualisieren">↻</button></div><p id="message" class="message" role="status" aria-live="polite">Verbinde mit dem Instanz-Manager …</p></section>
<section class="features"><article><strong>⌁</strong><h3>Persistente Dateien</h3><p>Deine Projektdateien bleiben nach dem Stoppen erhalten.</p></article><article><strong>▣</strong><h3>Eigene VM</h3><p>Deine Laufzeit ist von anderen Workspaces getrennt und ressourcenbegrenzt.</p></article><article><strong>↗</strong><h3>Netzwerkregeln</h3><p>Interne Netze sind gesperrt. Öffentlicher Internetzugriff kann Datenabfluss ermöglichen.</p></article></section>
<footer>Self-hosted · LXD · code-server <span>Aktionen werden serverseitig geprüft.</span></footer></main>
`
const css = document.createElement('style')
css.textContent = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#edf1fa;background:#0b0d12}*{box-sizing:border-box}body{margin:0;min-width:320px;min-height:100vh;background:radial-gradient(ellipse at 15% 0%,#17213a,#0b0d12 48%)}button{font:inherit}.shell{max-width:1050px;margin:auto;padding:32px 24px}.topbar{display:flex;align-items:center;gap:13px;border-bottom:1px solid #242a36;padding-bottom:24px}.mark{width:42px;height:42px;display:grid;place-items:center;border:1px solid #394b71;border-radius:12px;background:#1b2944;color:#b8d0ff;font-size:25px}.topbar h1{font-size:17px}.eyebrow{font-size:10px;letter-spacing:.16em;color:#8998b5;font-weight:700;margin:0 0 5px}.private{margin-left:auto;color:#aab6cc;font-size:12px;display:flex;align-items:center;gap:8px}.private i{width:7px;height:7px;background:#59d6a0;border-radius:50%}.intro{padding:42px 0 25px}.intro h2{font-size:clamp(26px,4vw,39px);letter-spacing:-.04em;line-height:1.15;margin:9px 0 13px}.sub{color:#a3aec2;max-width:670px;line-height:1.65;font-size:14px}.workspace{border:1px solid #30394b;background:linear-gradient(145deg,#191f2ef5,#11151ef5);border-radius:18px;padding:25px;box-shadow:0 24px 70px #0004}.cardhead{display:flex;align-items:center;gap:14px}.vscode{height:48px;width:48px;border-radius:13px;display:grid;place-items:center;background:#143e68;color:#9cd3ff;font-weight:800;border:1px solid #266aa4}.name{flex:1;min-width:0}.name h3{font-size:16px;margin:0 0 5px}.name p{font-size:12px;color:#98a5bb;overflow-wrap:anywhere}.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;border-radius:99px;border:1px solid #3a4557;background:#1c2432;color:#c6d0e2;font-size:11px;white-space:nowrap}.pill i{height:7px;width:7px;border-radius:50%;background:#8b98ad}.pill.running{color:#94edc5;border-color:#28664f;background:#102b23}.pill.running i{background:#55d69d}.pill.error{color:#ffb4b4;border-color:#713c42;background:#321c21}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:25px 0;padding:18px 0;border-block:1px solid #2a3240}.metrics div{display:flex;flex-direction:column;gap:8px}.metrics small{font-size:11px;color:#8f9cb2}.metrics b{font-size:14px}.actions{display:flex;flex-wrap:wrap;gap:10px}button{border-radius:9px;border:1px solid #394459;padding:10px 14px;font-size:12px;font-weight:650;cursor:pointer;color:#dbe5f7;background:#202838}button:hover:not(:disabled){background:#2b364b;border-color:#60749a}button:disabled{opacity:.4;cursor:not-allowed}.primary{background:#b6d4ff;color:#0d1b30;border-color:#b6d4ff}.open{margin-left:auto;background:#173e35;border-color:#286e59;color:#a3f0cf}.refresh{font-size:20px;padding:5px 12px}.message{font-size:12px;line-height:1.5;color:#91a0b7;margin:16px 0 0;min-height:18px}.message.error{color:#ff9ca3}.message.success{color:#86e6b9}.features{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:17px}.features article{border:1px solid #242c3a;background:#121720b8;border-radius:14px;padding:18px}.features strong{color:#9fc7ff;font-size:20px}.features h3{font-size:13px;margin:14px 0 8px}.features p{font-size:12px;line-height:1.65;color:#98a5ba;margin:0}footer{display:flex;justify-content:space-between;gap:12px;margin-top:26px;font-size:11px;color:#69768b}footer span{text-align:right}@media(max-width:650px){.shell{padding:20px 14px}.intro{padding-top:30px}.workspace{padding:17px}.private{display:none}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:20px}.features{grid-template-columns:1fr}.open{margin-left:0}.cardhead{flex-wrap:wrap}.pill{margin-left:auto}.actions button{flex:1}.actions .refresh{flex:0 0 auto}footer{flex-direction:column}footer span{text-align:left}}
`
document.head.append(css)
const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error('Missing element: ' + id)
  return node as T
}
const usernameEl = el<HTMLElement>('username'), statusEl = el<HTMLElement>('status'), statusLabel = el<HTMLElement>('status-label'), messageEl = el<HTMLElement>('message')
const createBtn = el<HTMLButtonElement>('create'), startBtn = el<HTMLButtonElement>('start'), stopBtn = el<HTMLButtonElement>('stop'), openBtn = el<HTMLButtonElement>('open'), refreshBtn = el<HTMLButtonElement>('refresh')
let current: Instance | null = null, busy = false
function setMessage(text: string, kind = '') { messageEl.textContent = text; messageEl.className = 'message' + (kind ? ' ' + kind : '') }
function render(vm: Instance) {
 current = vm
 const running = vm.status === 'Running'
 statusEl.className = 'pill ' + (running ? 'running' : '')
 statusLabel.textContent = !vm.exists ? 'Nicht erstellt' : running ? 'Läuft' : vm.status === 'Stopped' ? 'Gestoppt' : vm.status
 createBtn.disabled = busy || (vm.exists && running); startBtn.disabled = busy || !vm.exists || running; stopBtn.disabled = busy || !vm.exists || !running; openBtn.disabled = busy || !vm.exists || !running || !vm.ip; refreshBtn.disabled = busy
}
async function api<T extends ErrorResponse>(url: string, method = 'GET'): Promise<T> {
 const response = await fetch(url, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })
 const data = await response.json() as T
 if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status))
 return data
}
async function refresh() {
 try {
  const data = await api<InstanceResponse & ErrorResponse>('/api/instance')
  usernameEl.textContent = data.user; render(data.instance)
  if (data.instance.exists && data.instance.status === 'Running' && !data.instance.ip) setMessage('VM startet. IP wird noch ermittelt …')
  else if (data.instance.exists && data.instance.status === 'Running') setMessage('Deine VM läuft. VS Code kann geöffnet werden.', 'success')
  else if (!data.instance.exists) setMessage('Erstelle deinen Workspace, um loszulegen.')
  else setMessage('Deine Projektdateien bleiben beim Stoppen erhalten.')
 } catch (err) {
  statusEl.className = 'pill error'; statusLabel.textContent = 'Nicht verfügbar'; usernameEl.textContent = 'Authentifizierung erforderlich'
  setMessage(err instanceof Error ? err.message : 'Verbindung fehlgeschlagen', 'error')
  createBtn.disabled = startBtn.disabled = stopBtn.disabled = openBtn.disabled = true
 }
}
async function perform(action: 'create' | 'start' | 'stop') {
 if (busy) return
 busy = true; render(current || { exists: false, name: '', network: null, status: 'Missing', ip: null })
 setMessage(action === 'create' ? 'VM wird erstellt. Das kann beim ersten Mal einige Minuten dauern …' : action === 'start' ? 'VM wird gestartet …' : 'VM wird gestoppt …')
 try {
  const data = await api<ActionResponse>('/api/instance/' + action, 'POST')
  render(data.instance); setMessage(action === 'stop' ? 'VM gestoppt. Dateien bleiben erhalten.' : 'Aktion angenommen; Status wird aktualisiert.', 'success')
 } catch (err) { setMessage(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error') }
 finally { busy = false; await refresh() }
}
createBtn.addEventListener('click', () => void perform('create')); startBtn.addEventListener('click', () => void perform('start')); stopBtn.addEventListener('click', () => void perform('stop')); refreshBtn.addEventListener('click', () => void refresh()); openBtn.addEventListener('click', () => window.location.assign('/workspace/'))
void refresh()
window.setInterval(() => { if (!busy) void refresh() }, 8000)
