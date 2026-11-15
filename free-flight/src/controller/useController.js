import { useCallback, useEffect, useRef, useState } from 'react';

// Same alphabet as the relay: no 0/O or 1/I/L to mix up when typing.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// One code per game tab; kept for the tab's lifetime so a refresh keeps the phone linked.
function roomCode() {
  try {
    const saved = sessionStorage.getItem('gyro-room');
    if (saved && /^[A-Z2-9]{4}$/.test(saved)) return saved;
  } catch {}
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  try { sessionStorage.setItem('gyro-room', code); } catch {}
  return code;
}

/**
 * Connects the game (laptop) to the WebSocket relay so a phone can act as a
 * gyro controller. `handlers.current` receives { onTilt(x, y), onAction(name) }.
 */
export function useController(handlers) {
  const [phones, setPhones] = useState(0);
  const [connected, setConnected] = useState(false);
  const [urls, setUrls] = useState([]);
  const [ready, setReady] = useState(false); // tilt data actually arriving
  const [code] = useState(roomCode);
  const wsRef = useRef(null);
  const lastTilt = useRef(0);

  useEffect(() => {
    const iv = setInterval(() => setReady(performance.now() - lastTilt.current < 1500), 400);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (location.protocol !== 'https:') return undefined; // relay only runs on the HTTPS server

    fetch('/api/controller-info')
      .then((r) => (r.ok ? r.json() : { phoneUrls: [] }))
      .then((d) => setUrls((d.phoneUrls || []).map((u) => `${u}?room=${code}`)))
      .catch(() => {});

    let ws;
    let timer;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`wss://${location.host}/gyro-ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: 'hello', role: 'game', room: code }));
      };
      ws.onclose = () => {
        setConnected(false);
        setPhones(0);
        if (!closed) timer = setTimeout(connect, 1000);
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'status') setPhones(m.phones || 0);
        else if (m.type === 'tilt') {
          if (performance.now() - lastTilt.current > 1500) setReady(true);
          lastTilt.current = performance.now();
          handlers.current?.onTilt?.(m.x, m.y);
        }
        else if (m.type === 'action') handlers.current?.onAction?.(m.action);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws && ws.close();
    };
  }, [handlers, code]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }, []);

  return { phones, ready: ready && phones > 0, connected, urls, code, send };
}
