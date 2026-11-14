import { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from './game/Game.js';
import { useController } from './controller/useController.js';

const BEST_KEY = 'gyro-runner-best';

function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(v) {
  try {
    localStorage.setItem(BEST_KEY, String(v));
  } catch {
    /* storage unavailable */
  }
}

const hasTilt = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && 'ontouchstart' in window;

function PhonePanel({ ctrl }) {
  if (!ctrl.urls.length && !ctrl.phones) return null;
  if (ctrl.ready) {
    return (
      <div className="phone-card linked">
        <i className="dot ok" />
        <span>Phone controller ready. Tilt to steer, then press <b>Start</b> on your phone.</span>
      </div>
    );
  }
  return (
    <div className="phone-card">
      <div className="phone-title">Use your phone as the controller</div>
      <img className="qr" src="/api/controller-qr?i=0" alt="QR code to open the phone controller" />
      <div className="url">{ctrl.urls[0]}</div>
      {ctrl.phones > 0 ? (
        <div className="hint warn">
          <i className="dot amber" />
          A controller page is open but no motion data is arriving yet. On your phone, tap <b>Enable motion</b>.
          (A controller tab open on this computer counts too; close it.)
        </div>
      ) : (
        <div className="hint">Same Wi-Fi · scan with the camera · accept the certificate warning</div>
      )}
    </div>
  );
}

export default function App() {
  const mountRef = useRef(null);
  const gameRef = useRef(null);
  const bestRef = useRef(loadBest());

  const [phase, setPhase] = useState('menu'); // menu | playing | over
  const [hud, setHud] = useState({ distance: 0, target: 1000, warn: false, reached: false, paused: false, mode: 'menu' });
  const [best, setBest] = useState(bestRef.current);
  const [result, setResult] = useState({ distance: 0, record: false });
  const [tiltOn, setTiltOn] = useState(false);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // ---- phone controller link ----
  const handlers = useRef({});
  const ctrl = useController(handlers);
  const sendRef = useRef(ctrl.send);
  sendRef.current = ctrl.send;

  useEffect(() => {
    const game = new Game(mountRef.current, {
      onHud: setHud,
      onCrash: (distance) => {
        const record = distance > bestRef.current;
        if (record) {
          bestRef.current = distance;
          saveBest(distance);
          setBest(distance);
        }
        setResult({ distance, record });
        setPhase('over');
      },
    });
    gameRef.current = game;
    return () => game.dispose();
  }, []);

  const start = useCallback(() => {
    gameRef.current?.start(bestRef.current);
    setPhase('playing');
    sendRef.current({ type: 'calibrate' }); // recentre phone tilt to the current grip
  }, []);

  const toMenu = useCallback(() => {
    gameRef.current?.toMenu();
    setPhase('menu');
  }, []);

  handlers.current = {
    onTilt: (x, y) => gameRef.current?.setRemoteInput(x, y),
    onAction: (action) => {
      const p = phaseRef.current;
      const g = gameRef.current;
      if (action === 'primary') {
        if (p === 'menu' || p === 'over') start();
        else if (p === 'playing' && g?.mode === 'playing') g.togglePause();
      } else if (action === 'menu' && p !== 'menu') {
        toMenu();
      }
    },
  };

  // ---- feedback to the phone: state + haptics ----
  const prev = useRef({ warn: false, reached: false, warnAt: 0 });
  useEffect(() => {
    const mode = phase === 'playing' && hud.mode === 'crashed' ? 'crashed' : phase;
    ctrl.send({
      type: 'state',
      mode,
      paused: !!hud.paused,
      altitude: hud.altitude ?? 0,
      distance: phase === 'over' ? result.distance : phase === 'playing' ? hud.distance : 0,
      target: phase === 'playing' ? hud.target : best || null,
    });

    const p = prev.current;
    const now = performance.now();
    if (phase === 'playing') {
      if (hud.warn && !p.warn && now - p.warnAt > 700) {
        ctrl.send({ type: 'haptic', pattern: 'tap' });
        p.warnAt = now;
      }
      if (hud.reached && !p.reached) ctrl.send({ type: 'haptic', pattern: 'double' });
    }
    p.warn = !!hud.warn;
    p.reached = !!hud.reached;
  }, [hud, phase, result.distance, best, ctrl.send]);

  // Crash buzz as soon as the ship explodes (before the game-over screen)
  useEffect(() => {
    if (hud.mode === 'crashed') ctrl.send({ type: 'haptic', pattern: 'long' });
  }, [hud.mode, ctrl.send]);

  // Tell a newly connected phone where we are
  useEffect(() => {
    if (ctrl.phones) setHud((h) => ({ ...h }));
  }, [ctrl.phones]);

  const enableTilt = useCallback(async () => {
    const ok = await gameRef.current?.enableTilt();
    setTiltOn(!!ok);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.code === 'Enter' || e.code === 'Space') && phase !== 'playing') {
        e.preventDefault();
        start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, start]);

  return (
    <div className="app">
      <div className="stage" ref={mountRef} />
      <div className="vignette" />

      {phase === 'playing' && (
        <>
          <div className="hud">
            <div className="row">
              <span>Distance:</span>
              <b>{hud.distance} m</b>
            </div>
            <div className="row">
              <span>Target:</span>
              <b>{hud.target} m</b>
            </div>
          </div>
          {ctrl.ready && <div className="linked-badge">📱 phone linked</div>}
          {hud.reached && <div className="banner">TARGET REACHED</div>}
          {hud.warn && !hud.paused && <div className="lookout">LOOK OUT!</div>}
          <button className="pause-btn" onClick={() => gameRef.current?.togglePause()} aria-label="Pause">
            {hud.paused ? '▶' : '❚❚'}
          </button>
          {hud.paused && (
            <div className="overlay">
              <div className="panel">
                <h2>PAUSED</h2>
                <button className="btn" onClick={() => gameRef.current?.togglePause()}>Resume</button>
                <button className="btn ghost" onClick={toMenu}>Menu</button>
              </div>
            </div>
          )}
        </>
      )}

      {phase === 'menu' && (
        <div className="overlay">
          <div className="panel">
            <h1>
              GYRO<span>RUNNER</span>
            </h1>
            <p className="tag">Thread the needle. Don't stop.</p>
            <button className="btn" onClick={start}>Start</button>
            {hasTilt && (
              <button className="btn ghost" onClick={enableTilt} disabled={tiltOn}>
                {tiltOn ? 'Tilt steering on' : 'Enable tilt steering'}
              </button>
            )}
            {best > 0 && <p className="best">Best: {best} m</p>}
            <PhonePanel ctrl={ctrl} />
            <div className="help">
              <div><kbd>←</kbd><kbd>→</kbd> / <kbd>A</kbd><kbd>D</kbd> steer</div>
              <div><kbd>↑</kbd><kbd>↓</kbd> / <kbd>W</kbd><kbd>S</kbd> climb · dive</div>
              <div>Touch: hold left / right side · <kbd>P</kbd> pause</div>
            </div>
          </div>
        </div>
      )}

      {phase === 'over' && (
        <div className="overlay">
          <div className="panel">
            <h2 className="crash">CRASHED</h2>
            <div className="stat">
              <span>Distance</span>
              <b>{result.distance} m</b>
            </div>
            <div className="stat">
              <span>Best</span>
              <b>{best} m</b>
            </div>
            {result.record && <p className="record">NEW RECORD</p>}
            <button className="btn" onClick={start}>Fly again</button>
            <button className="btn ghost" onClick={toMenu}>Menu</button>
            {ctrl.ready && <p className="hint">or press <b>Fly again</b> on your phone</p>}
          </div>
        </div>
      )}
    </div>
  );
}
