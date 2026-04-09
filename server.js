const express = require('express')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const API_KEY = process.env.WA_SERVICE_API_KEY || 'changeme'
const SESSION_DIR = process.env.SESSION_DIR || '/data/session'

// Ensure session directory exists
fs.mkdirSync(SESSION_DIR, { recursive: true })

let sock = null
let qrCodeData = null  // latest QR as base64 PNG
let isConnected = false

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key']
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ── Start WhatsApp connection ────────────────────────────────────────────────
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['PNM Dashboard', 'Chrome', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('QR code generated — scan at /qr')
      qrCodeData = await QRCode.toDataURL(qr)
      isConnected = false
    }

    if (connection === 'open') {
      console.log('WhatsApp connected ✓')
      isConnected = true
      qrCodeData = null
      // Set profile name to Wiom
      try { await sock.updateProfileName('Wiom') } catch (e) { console.log('Profile name update skipped:', e.message) }
    }

    if (connection === 'close') {
      isConnected = false
      const loggedOut = lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output?.statusCode === DisconnectReason.loggedOut

      console.log('WhatsApp disconnected. loggedOut:', loggedOut)
      if (loggedOut) {
        // Wipe session so a fresh QR is generated for a new number
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true })
          fs.mkdirSync(SESSION_DIR, { recursive: true })
          console.log('Session cleared after logout')
        } catch (e) {
          console.error('Failed to clear session:', e)
        }
      }
      setTimeout(startSock, 3000)
    }
  })
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isConnected, hasQr: !!qrCodeData })
})

// QR code page — open this URL in browser to scan
app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send('<h2 style="font-family:sans-serif;color:green">✓ WhatsApp Connected</h2>')
  }
  if (!qrCodeData) {
    return res.send('<h2 style="font-family:sans-serif">Generating QR code... Refresh in a few seconds.</h2>')
  }
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WhatsApp QR</title>
        <meta http-equiv="refresh" content="30">
        <style>
          body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0fdf4; }
          img { width: 300px; height: 300px; border: 4px solid #16a34a; border-radius: 12px; }
          h2 { color: #15803d; }
          p { color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <h2>Scan with WhatsApp (9289448810)</h2>
        <img src="${qrCodeData}" />
        <p>Open WhatsApp → Linked Devices → Link a Device → Scan</p>
        <p>Page auto-refreshes every 30s</p>
      </body>
    </html>
  `)
})

// Send WhatsApp message (protected)
app.post('/send', requireApiKey, async (req, res) => {
  const { to, message } = req.body

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' })
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected. Check /qr to scan.' })
  }

  // Format number — ensure 91 prefix, strip any +
  const digits = String(to).replace(/\D/g, '')
  const jid = digits.startsWith('91') ? `${digits}@s.whatsapp.net` : `91${digits}@s.whatsapp.net`

  try {
    await sock.sendMessage(jid, { text: message })
    console.log(`Message sent to ${jid}`)
    res.json({ success: true })
  } catch (err) {
    console.error('Send error:', err)
    res.status(500).json({ error: 'Failed to send message', detail: String(err) })
  }
})

// Logout — end session and wipe creds so a new number can be linked (protected)
app.post('/logout', requireApiKey, async (req, res) => {
  try {
    if (sock) {
      try { await sock.logout() } catch (e) { console.log('sock.logout error (ignored):', e.message) }
    }
    isConnected = false
    qrCodeData = null
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true })
      fs.mkdirSync(SESSION_DIR, { recursive: true })
    } catch (e) {
      console.error('Session wipe failed:', e)
    }
    setTimeout(startSock, 1500)
    res.json({ success: true, message: 'Logged out. Visit /qr to scan a new number.' })
  } catch (err) {
    res.status(500).json({ error: 'Logout failed', detail: String(err) })
  }
})

// Update profile display name (protected)
app.post('/set-name', requireApiKey, async (req, res) => {
  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })
  if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp not connected' })
  try {
    await sock.updateProfileName(name)
    res.json({ success: true, name })
  } catch (err) {
    res.status(500).json({ error: 'Failed to update name', detail: String(err) })
  }
})

// ── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WA Service running on port ${PORT}`)
  startSock()
})
