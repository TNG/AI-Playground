"""Self-contained chat + login page served by the local-web Home Agent server.

Ported verbatim from the PoC's ``WebUI/electron/localWebChatAppHtml.ts`` so the
browser experience is identical, but served by the Python channel instead of an
Electron-side Node server. Kept in its own module (mirroring the TS split) so the
channel logic in ``local_web.py`` stays readable.

The page connects to ``/api/events`` (Server-Sent Events) for outbound traffic
and POSTs to ``/api/chat`` for inbound messages, guarded by a password login
(``/api/login`` → ``HttpOnly`` session cookie).
"""

# NB: raw string — the embedded JS contains regex escapes (\*, \n) that must
# reach the browser literally.
LOCAL_WEB_CHAT_APP_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Home Agent</title>
  <style>
    :root {
      color-scheme: light dark;
      --tg-bg: #0e1621;
      --tg-header: #17212b;
      --tg-compose: #17212b;
      --tg-user: #2b5278;
      --tg-bot: #182533;
      --tg-text: #f5f5f5;
      --tg-muted: #708499;
      --tg-accent: #6ab3f3;
      --tg-input: #242f3d;
      --err: #e57373;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --tg-bg: #99ba92;
        --tg-header: #517da2;
        --tg-compose: #f0f0f0;
        --tg-user: #effdde;
        --tg-bot: #ffffff;
        --tg-text: #0f0f0f;
        --tg-muted: #5d6c7b;
        --tg-accent: #168acd;
        --tg-input: #ffffff;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--tg-bg); color: var(--tg-text); min-height: 100dvh; }
    .screen { min-height: 100dvh; display: flex; flex-direction: column; }
    .hidden { display: none !important; }
    #login-screen { align-items: center; justify-content: center; padding: 24px; background: var(--tg-header); }
    .login-card { width: 100%; max-width: 360px; background: var(--tg-bot); border-radius: 12px; padding: 24px; box-shadow: 0 4px 24px #0004; }
    .login-card h1 { margin: 0 0 8px; font-size: 1.25rem; }
    .login-card p { margin: 0 0 16px; font-size: 13px; color: var(--tg-muted); line-height: 1.45; }
    .login-card label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .login-card input[type=password] { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #0002; background: var(--tg-input); color: var(--tg-text); font: inherit; }
    .login-card button { margin-top: 14px; width: 100%; border: none; border-radius: 8px; padding: 11px; background: var(--tg-accent); color: #fff; font-weight: 600; cursor: pointer; font: inherit; }
    #login-error { color: var(--err); font-size: 12px; min-height: 1.2em; margin-top: 8px; }
    #chat-screen { background: var(--tg-bg) url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h60v60H0z' fill='none'/%3E%3Ccircle cx='8' cy='8' r='1' fill='%23ffffff' fill-opacity='.04'/%3E%3C/svg%3E"); }
    .tg-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--tg-header); box-shadow: 0 1px 0 #0003; }
    .tg-avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--tg-accent); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex-shrink: 0; }
    .tg-header-text { flex: 1; min-width: 0; }
    .tg-header-text .title { font-weight: 600; font-size: 15px; }
    .tg-header-text .sub { font-size: 12px; color: var(--tg-muted); }
    #log { flex: 1; overflow-y: auto; padding: 8px 10px 88px; display: flex; flex-direction: column; gap: 6px; }
    .row { display: flex; align-items: flex-end; gap: 8px; max-width: 100%; }
    .row-user { justify-content: flex-end; }
    .row-bot { justify-content: flex-start; }
    .bubble { max-width: min(85%, 520px); padding: 8px 12px 6px; border-radius: 12px; line-height: 1.45; font-size: 15px; word-break: break-word; box-shadow: 0 1px 1px #0002; }
    .row-user .bubble { background: var(--tg-user); color: var(--tg-text); border-bottom-right-radius: 4px; white-space: pre-wrap; }
    .row-bot .bubble { background: var(--tg-bot); color: var(--tg-text); border-bottom-left-radius: 4px; }
    .row-bot .bubble.streaming { min-width: 48px; min-height: 20px; }
    .bubble .time { display: block; text-align: right; font-size: 11px; color: var(--tg-muted); margin-top: 4px; }
    .bubble code { font-family: ui-monospace, monospace; font-size: 0.9em; background: #0001; padding: 1px 4px; border-radius: 4px; }
    .bubble strong { font-weight: 600; }
    .sys { align-self: center; font-size: 12px; color: var(--tg-muted); background: #0003; padding: 4px 10px; border-radius: 12px; margin: 4px 0; }
    .typing-dots { display: inline-flex; gap: 4px; padding: 4px 0; }
    .typing-dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--tg-muted); animation: bounce 1.2s infinite ease-in-out; }
    .typing-dots span:nth-child(2) { animation-delay: .15s; }
    .typing-dots span:nth-child(3) { animation-delay: .3s; }
    @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }
    .cursor { animation: blink 1s step-end infinite; opacity: .7; }
    @keyframes blink { 50% { opacity: 0; } }
    .compose { position: fixed; bottom: 0; left: 0; right: 0; display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); background: var(--tg-compose); border-top: 1px solid #0002; }
    .compose-inner { flex: 1; display: flex; align-items: flex-end; background: var(--tg-input); border-radius: 22px; padding: 6px 6px 6px 14px; border: 1px solid #0002; }
    #input { flex: 1; border: none; background: transparent; color: var(--tg-text); font: inherit; font-size: 15px; resize: none; max-height: 120px; line-height: 1.35; padding: 6px 0; outline: none; }
    #send { width: 42px; height: 42px; border: none; border-radius: 50%; background: var(--tg-accent); color: #fff; font-size: 18px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    #send:disabled { opacity: 0.45; }
    img.inline { max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; }
    .kbd-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .kbd-row button { background: var(--tg-input); color: var(--tg-text); border: 1px solid #0002; font-weight: 500; padding: 8px 12px; font-size: 13px; border-radius: 8px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="login-screen" class="screen">
    <div class="login-card">
      <h1>Home Agent</h1>
      <p>Enter the password from AI Playground &rarr; Home Agent &rarr; LAN chat.</p>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Password" />
      <div id="login-error"></div>
      <button type="button" id="login-btn">Sign in</button>
    </div>
  </div>
  <div id="chat-screen" class="screen hidden">
    <div class="tg-header">
      <div class="tg-avatar">HA</div>
      <div class="tg-header-text">
        <div class="title">Home Agent</div>
        <div class="sub" id="status-line">online</div>
      </div>
    </div>
    <div id="log"></div>
    <div class="compose">
      <div class="compose-inner">
        <textarea id="input" rows="1" placeholder="Message" autocomplete="off"></textarea>
      </div>
      <button type="button" id="send" title="Send">&#10148;</button>
    </div>
  </div>
  <script>
    const loginScreen = document.getElementById('login-screen')
    const chatScreen = document.getElementById('chat-screen')
    const passwordInput = document.getElementById('password')
    const loginBtn = document.getElementById('login-btn')
    const loginError = document.getElementById('login-error')
    const log = document.getElementById('log')
    const input = document.getElementById('input')
    const sendBtn = document.getElementById('send')
    const statusLine = document.getElementById('status-line')
    let draftBubble = null
    let draftRow = null
    let typingRow = null
    let es = null

    function scrollBottom() { log.scrollTop = log.scrollHeight }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }
    function formatBotText(raw) {
      if (!raw) return ''
      let s = escapeHtml(raw)
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
      s = s.replace(/\n/g, '<br>')
      return s
    }
    function timeNow() {
      const d = new Date()
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    function appendSys(text) {
      const el = document.createElement('div')
      el.className = 'sys'
      el.textContent = text
      log.appendChild(el)
      scrollBottom()
    }

    function appendUser(text) {
      const row = document.createElement('div')
      row.className = 'row row-user'
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.textContent = text
      const t = document.createElement('span')
      t.className = 'time'
      t.textContent = timeNow()
      bubble.appendChild(t)
      row.appendChild(bubble)
      log.appendChild(row)
      scrollBottom()
    }

    function appendBotHtml(html, withTime) {
      clearDraft()
      hideTyping()
      const row = document.createElement('div')
      row.className = 'row row-bot'
      const av = document.createElement('div')
      av.className = 'tg-avatar'
      av.style.width = '32px'
      av.style.height = '32px'
      av.style.fontSize = '11px'
      av.textContent = 'HA'
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.innerHTML = html
      if (withTime !== false) {
        const tm = document.createElement('span')
        tm.className = 'time'
        tm.textContent = timeNow()
        bubble.appendChild(tm)
      }
      row.appendChild(av)
      row.appendChild(bubble)
      log.appendChild(row)
      scrollBottom()
      return bubble
    }

    function showTyping() {
      if (typingRow || draftRow) return
      typingRow = document.createElement('div')
      typingRow.className = 'row row-bot'
      const av = document.createElement('div')
      av.className = 'tg-avatar'
      av.style.width = '32px'
      av.style.height = '32px'
      av.style.fontSize = '11px'
      av.textContent = 'HA'
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>'
      typingRow.appendChild(av)
      typingRow.appendChild(bubble)
      log.appendChild(typingRow)
      statusLine.textContent = 'typing…'
      scrollBottom()
    }

    function hideTyping() {
      if (typingRow) { typingRow.remove(); typingRow = null }
      statusLine.textContent = 'online'
    }

    function ensureDraftRow() {
      hideTyping()
      if (draftRow) return
      draftRow = document.createElement('div')
      draftRow.className = 'row row-bot'
      const av = document.createElement('div')
      av.className = 'tg-avatar'
      av.style.width = '32px'
      av.style.height = '32px'
      av.style.fontSize = '11px'
      av.textContent = 'HA'
      draftBubble = document.createElement('div')
      draftBubble.className = 'bubble streaming'
      draftRow.appendChild(av)
      draftRow.appendChild(draftBubble)
      log.appendChild(draftRow)
    }

    function setDraft(text) {
      ensureDraftRow()
      draftBubble.innerHTML = formatBotText(text) + '<span class="cursor">▋</span>'
      scrollBottom()
    }

    function clearDraft() {
      if (draftRow) { draftRow.remove(); draftRow = null; draftBubble = null }
    }

    function finalizeBot(text) {
      const html = formatBotText(text)
      if (draftBubble && draftRow) {
        draftBubble.classList.remove('streaming')
        draftBubble.innerHTML = html
        const tm = document.createElement('span')
        tm.className = 'time'
        tm.textContent = timeNow()
        draftBubble.appendChild(tm)
        draftRow = null
        draftBubble = null
        scrollBottom()
        return
      }
      appendBotHtml(html)
    }

    async function api(path, body) {
      const res = await fetch(path, {
        method: body !== undefined ? 'POST' : 'GET',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) throw new Error(await res.text() || res.statusText)
      return res.json().catch(() => ({}))
    }

    function showChat() { loginScreen.classList.add('hidden'); chatScreen.classList.remove('hidden') }
    function showLogin(msg) {
      chatScreen.classList.add('hidden')
      loginScreen.classList.remove('hidden')
      if (es) { es.close(); es = null }
      if (msg) loginError.textContent = msg
    }

    async function trySession() {
      try {
        const s = await api('/api/session')
        if (s.ok) { showChat(); startChat(); return }
      } catch (_) {}
      showLogin('')
    }

    async function doLogin() {
      loginError.textContent = ''
      loginBtn.disabled = true
      try {
        await api('/api/login', { password: passwordInput.value })
        passwordInput.value = ''
        showChat()
        startChat()
      } catch (_) {
        loginError.textContent = 'Wrong password. Check AI Playground setup.'
      } finally {
        loginBtn.disabled = false
      }
    }

    loginBtn.onclick = () => doLogin()
    passwordInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin() }

    async function sendText(text) {
      const t = text.trim()
      if (!t) return
      appendUser(t)
      input.value = ''
      input.style.height = 'auto'
      await api('/api/chat', { text: t })
    }

    sendBtn.onclick = () => sendText(input.value)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value) }
    })
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 120) + 'px'
    })

    function onEvent(ev) {
      const d = ev.data ? JSON.parse(ev.data) : {}
      const action = d.action
      if (action === 'typing') { showTyping(); return }
      if (action === 'draftUpdate' || action === 'update') {
        setDraft(d.text || '')
        return
      }
      if (action === 'draftFinal' || action === 'reply') {
        finalizeBot(d.text || '')
        return
      }
      if (action === 'photo' && d.base64) {
        clearDraft()
        hideTyping()
        const cap = d.caption ? formatBotText(d.caption) + '<br>' : ''
        appendBotHtml(cap + '<img class="inline" src="data:image/jpeg;base64,' + d.base64 + '" />')
        return
      }
      if (action === 'keyboard' && d.buttons) {
        const wrap = appendBotHtml(formatBotText(d.text || '') + '<div class="kbd-row" id="kbd"></div>', false)
        const row = wrap.querySelector('#kbd')
        for (const btn of d.buttons.flat()) {
          const cb = btn.callbackData || btn.callback
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = btn.text || cb
          b.onclick = () => api('/api/chat', { callback: cb })
          row.appendChild(b)
        }
        const tm = document.createElement('span')
        tm.className = 'time'
        tm.textContent = timeNow()
        wrap.appendChild(tm)
        scrollBottom()
      }
    }

    function startChat() {
      log.innerHTML = ''
      clearDraft()
      hideTyping()
      appendSys('Connected · try /help')
      if (es) es.close()
      es = new EventSource('/api/events', { withCredentials: true })
      es.onmessage = onEvent
      es.onerror = () => appendSys('Connection lost — refresh and sign in again')
    }

    trySession()
  </script>
</body>
</html>"""
