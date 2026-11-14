import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Connects the game (laptop) to the WebSocket relay so a phone can act as a
 * gyro "air blade". `handlers.current` receives { onPointer(x, y), onAction(name) }.
 */
export function useController(handlers) {
  const [phones, setPhones] = useState(0);
  const [connected, setConnected] = useState(false);
  const [urls, setUrls] = useState([]);
  const [ready, setReady] = useState(false); // tilt data actually arriving
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
      .then((d) => setUrls(d.phoneUrls || []))
      .catch(() => {});

    let ws;
    let timer;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`wss://${location.host}/gyro-ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: 'hello', role: 'game' }));
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
        else if (m.type === 'pointer') {
          if (performance.now() - lastTilt.current > 1500) setReady(true);
          lastTilt.current = performance.now();
          handlers.current?.onPointer?.(m.x, m.y);
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
  }, [handlers]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }, []);

  return { phones, ready: ready && phones > 0, connected, urls, send };
}
