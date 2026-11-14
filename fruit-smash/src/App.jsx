import { useCallback, useEffect, useRef, useState } from 'react';
import { FruitGame } from './game/FruitGame.js';
import { useController } from './controller/useController.js';

const BEST_KEY = 'fruit-smash-best';
const loadBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const saveBest = (v) => { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* unavailable */ } };

function PhonePanel({ ctrl }) {
  if (!ctrl.urls.length && !ctrl.phones) return null;
  if (ctrl.ready) {
    return (
      <div className="phone-card linked">
        <i className="dot ok" />
        <span>Phone blade ready. Swing it at the screen, then press <b>Start</b> on your phone.</span>
      </div>
    );
  }
  return (
    <div className="phone-card">
      <div className="phone-title">Use your phone as the blade</div>
      <img className="qr" src="/api/controller-qr?i=0" alt="QR code to open the phone controller" />
      <div className="url">{ctrl.urls[0]}</div>
      {ctrl.phones > 0 ? (
        <div className="hint warn">
          <i className="dot amber" />
          Controller page open, but no motion yet. On your phone, tap <b>Enable motion</b>.
          (A controller tab open on this computer counts too; close it.)
        </div>
      ) : (
        <div className="hint">Same Wi-Fi · scan with the camera · accept the certificate warning</div>
      )}
    </div>
  );
}

function Lives({ lives }) {
  return (
    <div className="lives" aria-label={`${lives} lives left`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < 3 - lives ? 'x lost' : 'x'}>✕</span>
      ))}
    </div>
  );
}

export default function App() {
  const mountRef = useRef(null);
  const gameRef = useRef(null);
  const bestRef = useRef(loadBest());

  const [phase, setPhase] = useState('menu'); // menu | playing | over
  const [hud, setHud] = useState({ score: 0, lives: 3, mode: 'menu', paused: false });
  const [best, setBest] = useState(bestRef.current);
  const [result, setResult] = useState({ score: 0, record: false });

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const handlers = useRef({});
  const ctrl = useController(handlers);
  const sendRef = useRef(ctrl.send);
  sendRef.current = ctrl.send;

  useEffect(() => {
    let lastTap = 0;
    const game = new FruitGame(mountRef.current, {
      onHud: setHud,
      onEvent: (e) => {
        const send = sendRef.current;
        if (e.type === 'slice') {
          const now = performance.now();
          if (now - lastTap > 70) { send({ type: 'haptic', pattern: 'tap' }); lastTap = now; }
        } else if (e.type === 'combo') send({ type: 'haptic', pattern: 'triple' });
        else if (e.type === 'mine') send({ type: 'haptic', pattern: 'long' });
        else if (e.type === 'miss') send({ type: 'haptic', pattern: 'double' });
      },
      onGameOver: (score) => {
        const record = score > bestRef.current;
        if (record) {
          bestRef.current = score;
          saveBest(score);
          setBest(score);
        }
        setResult({ score, record });
        setPhase('over');
      },
    });
    gameRef.current = game;
    return () => game.dispose();
  }, []);

  const start = useCallback(() => {
    gameRef.current?.start();
    setPhase('playing');
  }, []);

  const toMenu = useCallback(() => {
    gameRef.current?.toMenu();
    setPhase('menu');
  }, []);

  handlers.current = {
    onPointer: (x, y) => gameRef.current?.setRemotePointer(x, y),
    onAction: (action) => {
      const p = phaseRef.current;
      const g = gameRef.current;
      if (action === 'primary') {
        if (p === 'menu' || p === 'over') start();
        else if (p === 'playing' && g?.mode === 'playing') g.togglePause();
      } else if (action === 'menu' && p !== 'menu') toMenu();
    },
  };

  // keep the phone's screen in sync
  useEffect(() => {
    ctrl.send({
      type: 'state',
      mode: phase,
      paused: !!hud.paused,
      score: phase === 'over' ? result.score : hud.score,
      lives: hud.lives,
      best,
    });
  }, [hud, phase, result.score, best, ctrl.send, ctrl.phones]);

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
      <div className="backdrop" />
      <div className="stage" ref={mountRef} />

      {phase === 'playing' && (
        <>
          <div className="score">
            <b>{hud.score}</b>
            <span>Best {Math.max(best, hud.score)}</span>
          </div>
          <Lives lives={hud.lives} />
          {ctrl.ready && <div className="linked-badge">📱 phone blade</div>}
          <button className="pause-btn" onClick={() => gameRef.current?.togglePause()} aria-label="Pause">
            {hud.paused ? '▶' : '❚❚'}
          </button>
          {hud.paused && (
            <div className="overlay">
              <div className="panel">
                <h2>Paused</h2>
                <button className="btn" onClick={() => gameRef.current?.togglePause()}>Resume</button>
                <button className="btn ghost" onClick={toMenu}>Menu</button>
              </div>
            </div>
          )}
        </>
      )}

      {phase === 'menu' && (
        <div className="overlay soft">
          <div className="panel">
            <h1>Fruit<span>Smash</span></h1>
            <p className="tag">Swipe through the fruit. Dodge the thorns.</p>
            <button className="btn" onClick={start}>Start</button>
            {best > 0 && <p className="best">Best: {best}</p>}
            <PhonePanel ctrl={ctrl} />
            <ul className="help">
              <li>Drag the mouse (or your finger) fast across fruit to slice it</li>
              <li>3 or more in one swipe = combo bonus · golden fruit = +5</li>
              <li>Miss a fruit or hit a thorn mine and you lose a life</li>
            </ul>
          </div>
        </div>
      )}

      {phase === 'over' && (
        <div className="overlay">
          <div className="panel">
            <h2>Game over</h2>
            <div className="stat"><span>Score</span><b>{result.score}</b></div>
            <div className="stat"><span>Best</span><b>{best}</b></div>
            {result.record && <p className="record">New record!</p>}
            <button className="btn" onClick={start}>Play again</button>
            <button className="btn ghost" onClick={toMenu}>Menu</button>
            {ctrl.ready && <p className="hint">or press <b>Play again</b> on your phone</p>}
          </div>
        </div>
      )}
    </div>
  );
}
