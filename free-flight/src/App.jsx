import { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from './game/Game.js';
import { WORLDS } from './game/worlds.js';
import { useController } from './controller/useController.js';

function PhonePanel({ ctrl }) {
  if (!ctrl.urls.length && !ctrl.phones) return null;
  if (ctrl.ready) {
    return (
      <div className="phone-card linked">
        <i className="dot ok" />
        <span>Phone linked. Tilt to fly, then press <b>Take off</b> on your phone.</span>
      </div>
    );
  }
  return (
    <div className="phone-card">
      <div className="phone-title">Fly with your phone</div>
      <img className="qr" src={`/api/controller-qr?i=0&room=${ctrl.code}`} alt="QR code to open the phone controller" />
      <div className="room">
        <span>Your code</span>
        <b>{ctrl.code}</b>
      </div>
      <div className="url">{ctrl.urls[0]?.replace(/\?room=.*/, '')}</div>
      {ctrl.phones > 0 ? (
        <div className="hint warn">
          <i className="dot amber" />
          Controller page is open but no motion yet. On your phone, tap <b>Enable motion</b>.
        </div>
      ) : (
        <div className="hint">Same Wi-Fi · scan with the camera, or open the link and type the code · accept the certificate warning</div>
      )}
    </div>
  );
}

const CAM_LABEL = { chase: 'Chase', far: 'Wide', cockpit: 'Cockpit' };

export default function App() {
  const mountRef = useRef(null);
  const gameRef = useRef(null);
  const [phase, setPhase] = useState('menu'); // menu | flying
  const [hud, setHud] = useState({ speed: 0, altitude: null, heading: 0, world: WORLDS[0].name, worldId: WORLDS[0].id, camera: 'chase', paused: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const handlers = useRef({});
  const ctrl = useController(handlers);

  useEffect(() => {
    const game = new Game(mountRef.current, { onHud: setHud });
    gameRef.current = game;
    const pick = WORLDS.findIndex((w) => w.id === new URLSearchParams(location.search).get('world'));
    if (pick > 0) game.setWorld(pick);
    return () => game.dispose();
  }, []);

  const start = useCallback(() => {
    gameRef.current?.start();
    setPhase('flying');
    ctrl.send({ type: 'calibrate' });
  }, [ctrl.send]);

  const toMenu = useCallback(() => {
    gameRef.current?.toMenu();
    setPhase('menu');
  }, []);

  handlers.current = {
    onTilt: (x, y) => gameRef.current?.setRemoteInput(x, y),
    onAction: (action) => {
      const g = gameRef.current;
      if (!g) return;
      if (action === 'primary') {
        if (phaseRef.current === 'menu') start();
        else g.togglePause();
      } else if (action === 'menu') toMenu();
      else if (action === 'scene') g.nextWorld();
      else if (action === 'view') g.cycleCamera();
      else if (action === 'respawn') g.respawn();
      else if (action === 'boost-on') g.setRemoteButton('boost', true);
      else if (action === 'boost-off') g.setRemoteButton('boost', false);
      else if (action === 'brake-on') g.setRemoteButton('brake', true);
      else if (action === 'brake-off') g.setRemoteButton('brake', false);
    },
  };

  // state back to the phone
  useEffect(() => {
    ctrl.send({
      type: 'state',
      mode: phase,
      paused: !!hud.paused,
      speed: hud.speed,
      altitude: hud.altitude,
      altNorm: hud.altNorm ?? 0.5,
      world: hud.world,
      camera: CAM_LABEL[hud.camera] || hud.camera,
    });
  }, [hud, phase, ctrl.send, ctrl.phones]);

  // a little buzz when switching scenes
  const lastWorld = useRef(hud.worldId);
  useEffect(() => {
    if (lastWorld.current !== hud.worldId) ctrl.send({ type: 'haptic', pattern: 'double' });
    lastWorld.current = hud.worldId;
  }, [hud.worldId, ctrl.send]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.code === 'Enter' || e.code === 'Space') && phaseRef.current === 'menu') {
        e.preventDefault();
        start();
      }
      if (e.code === 'KeyM' && phaseRef.current === 'flying') toMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start, toMenu]);

  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(hud.heading / 45) % 8];

  return (
    <div className={`app world-${hud.worldId}`}>
      <div className="stage" ref={mountRef} />
      <div className="vignette" />

      {phase === 'flying' && (
        <>
          <div className="hud">
            <div className="gauge">
              <span>SPD</span>
              <b>{hud.speed}</b>
              <small>km/h</small>
            </div>
            {hud.altitude != null && (
              <div className="gauge">
                <span>ALT</span>
                <b>{hud.altitude}</b>
                <small>m</small>
              </div>
            )}
            <div className="gauge">
              <span>HDG</span>
              <b>{String(hud.heading).padStart(3, '0')}°</b>
              <small>{compass}</small>
            </div>
          </div>
          <div className="topbar">
            <span className="chip">{hud.world}</span>
            <span className="chip">{CAM_LABEL[hud.camera]} cam</span>
            {ctrl.ready ? <span className="chip ok">📱 linked</span> : <span className="chip">Code {ctrl.code}</span>}
            {hud.boosting && <span className="chip boost">BOOST</span>}
          </div>
          <button className="pause-btn" onClick={() => gameRef.current?.togglePause()} aria-label="Pause">
            {hud.paused ? '▶' : '❚❚'}
          </button>
          {hud.paused && (
            <div className="overlay">
              <div className="panel">
                <h2>PAUSED</h2>
                <button className="btn" onClick={() => gameRef.current?.togglePause()}>Resume</button>
                <button className="btn ghost" onClick={() => { gameRef.current?.nextWorld(); }}>Switch scene</button>
                <button className="btn ghost" onClick={toMenu}>Menu</button>
              </div>
            </div>
          )}
        </>
      )}

      {phase === 'menu' && (
        <div className="overlay menu">
          <div className="panel">
            <h1>FREE<span>FLIGHT</span></h1>
            <p className="tag">No score. No crashes. Just fly.</p>
            <div className="worlds">
              {WORLDS.map((w, i) => (
                <button
                  key={w.id}
                  className={`world-btn ${hud.worldId === w.id ? 'on' : ''}`}
                  onClick={() => gameRef.current?.setWorld(i)}
                >
                  <i className={`swatch ${w.id}`} />
                  {w.name}
                </button>
              ))}
            </div>
            <button className="btn" onClick={start}>Take off</button>
            <PhonePanel ctrl={ctrl} />
            <div className="help">
              <div><kbd>W</kbd><kbd>S</kbd> / <kbd>↑</kbd><kbd>↓</kbd> climb · dive &nbsp; <kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd> turn</div>
              <div><kbd>Q</kbd><kbd>E</kbd> roll · <kbd>Shift</kbd> boost · <kbd>Space</kbd> brake</div>
              <div><kbd>C</kbd> camera · <kbd>N</kbd> scene · <kbd>R</kbd> respawn · <kbd>P</kbd> pause · drag to steer</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
