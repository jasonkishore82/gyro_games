// Vite plugin: HTTPS (self-signed) + WebSocket relay so a phone can act as a
// gyro controller for the game running on the laptop.
// iPhone Safari only exposes DeviceOrientation on secure origins, hence HTTPS.
//
//   phone  --tilt/action-->  relay  --> game (laptop)
//   game   --state/haptic--> relay  --> phone
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

const WS_PATH = '/gyro-ws';
const CONTROLLER_PATH = '/controller.html';

function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (
        a.family === 'IPv4' &&
        !a.internal &&
        !a.address.startsWith('169.254.') &&
        !/vEthernet|WSL|VirtualBox|VMware|Hyper-V/i.test(name)
      ) {
        out.push(a.address);
      }
    }
  }
  // Home/office Wi-Fi ranges first (what the phone can reach); VPN/CGNAT (e.g. Tailscale 100.64/10) last
  const rank = (ip) => (/^192.168./.test(ip) ? 0 : /^10./.test(ip) ? 1 : /^172.(1[6-9]|2d|3[01])./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

// Self-signed cert, regenerated whenever the LAN IPs change.
function getCert(dir, ips) {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const ipFile = path.join(dir, 'ips.txt');
  const sig = ips.join(',');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(ipFile) && fs.readFileSync(ipFile, 'utf8') === sig) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'gyro-runner.local' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(ipFile, sig);
  return { key: pems.private, cert: pems.cert };
}

function attachRelay(httpServer, ips) {
  if (!httpServer) return;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== WS_PATH) return; // leave Vite HMR alone
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const broadcastStatus = () => {
    let phones = 0, games = 0;
    for (const c of wss.clients) {
      if (c.role === 'phone') phones++;
      else if (c.role === 'game') games++;
    }
    const msg = JSON.stringify({ type: 'status', phones, games });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };

  wss.on('connection', (ws, req) => {
    ws.role = 'unknown';
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const who = req.socket.remoteAddress;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'hello') {
        ws.role = msg.role === 'phone' ? 'phone' : 'game';
        console.log(`  [controller] ${ws.role} connected from ${who}`);
        broadcastStatus();
        return;
      }
      const to = ws.role === 'phone' ? 'game' : ws.role === 'game' ? 'phone' : null;
      if (!to) return;
      const out = JSON.stringify(msg);
      for (const c of wss.clients) if (c.role === to && c.readyState === 1) c.send(out);
    });
    ws.on('close', () => {
      if (ws.role !== 'unknown') console.log(`  [controller] ${ws.role} disconnected (${who})`);
      broadcastStatus();
    });
  });

  // Heartbeat: drop sockets that stopped answering (phone locked, tab killed, Wi-Fi lost)
  // so the game never shows a controller that isn't really there.
  const iv = setInterval(() => {
    for (const c of wss.clients) {
      if (!c.alive) { c.terminate(); continue; }
      c.alive = false;
      if (c.readyState === 1) c.ping();
    }
  }, 5000);
  httpServer.on('close', () => { clearInterval(iv); wss.close(); });
}

function apiMiddleware(httpServer, ips) {
  const port = () => httpServer?.address()?.port;
  const phoneUrl = (ip) => `https://${ip}:${port()}${CONTROLLER_PATH}`;
  return (req, res, next) => {
    const url = new URL(req.url, 'https://x');
    if (url.pathname === '/api/controller-info') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      return res.end(JSON.stringify({ phoneUrls: ips.map(phoneUrl) }));
    }
    if (url.pathname === '/api/controller-qr') {
      // only ever encodes our own controller URL (index into the LAN IP list)
      const ip = ips[Number(url.searchParams.get('i')) || 0];
      if (!ip) { res.statusCode = 404; return res.end(); }
      QRCode.toString(phoneUrl(ip), { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } })
        .then((svg) => {
          res.setHeader('content-type', 'image/svg+xml');
          res.setHeader('cache-control', 'no-store');
          res.end(svg);
        })
        .catch(() => { res.statusCode = 500; res.end(); });
      return;
    }
    next();
  };
}

export default function controllerPlugin({ certDir }) {
  const ips = lanIPs();
  const cert = getCert(certDir, ips);

  const setup = (server) => {
    attachRelay(server.httpServer, ips);
    server.middlewares.use(apiMiddleware(server.httpServer, ips));
    server.httpServer?.once('listening', () => {
      const p = server.httpServer.address().port;
      setTimeout(() => {
        console.log('\n  Gyro Runner: phone controller');
        console.log(`  Game (laptop):       https://localhost:${p}/`);
        for (const ip of ips) console.log(`  Controller (phone):  https://${ip}:${p}${CONTROLLER_PATH}`);
        console.log('  Self-signed cert: on each device choose "Advanced" / "Show Details" -> visit anyway.\n');
      }, 50);
    });
  };

  return {
    name: 'gyro-controller',
    config: () => ({
      server: { https: cert },
      preview: { https: cert },
    }),
    configureServer: setup,
    configurePreviewServer: setup,
  };
}
