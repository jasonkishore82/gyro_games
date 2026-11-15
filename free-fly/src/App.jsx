import { useCallback, useEffect, useRef, useState } from 'react';
import { FlyGame } from './game/FlyGame.js';
import { useController } from './controller/useController.js';

const SCENE_KEY = 'free-fly-scene';
const SCENE_LABEL = { sky: 'Sky islands', space: 'Deep space' };

function loadScene() {
  try {
    const v = localStorage.getItem(SCENE_KEY);
    return v === 'space' ? 'space' : 'sky';
  } catch {
    return 'sky';
  }
}

function saveScene(v) {
  try {
    localStorage.setItem(SCENE_KEY, v);
  } catch {
    /* storage unavailable */
  }
}

const hasTilt = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && 'ontouchstart' in window;
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

function PhonePanel({ ctrl }) {
  if (!ctrl.urls.length && !ctrl.phones) return null;
  if (ctrl.ready) {
    return (
      <div className="phone-card linked">
        <i className="dot ok" />
        <span>Phone controller ready. Tilt to fly, then press <b>Start</b> on your phone.</span>
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

  const [phase, setPhase] = useState('menu'); // menu | playing
  const [hud, setHud] = useState({ mode: 'menu', paused: false, scene: loadScene(), speed: 0, altitude: 0, altNorm: 0, heading: 0, distance: 0, boost: false });
  const [scene, setSceneState] = useState(loadScene);
  const [warp, setWarp] = useState(0); // bumps to replay the scene-switch flash
  const [tiltOn, setTiltOn] = useState(false);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // ---- phone controller link ----
  const handlers = useRef({});
  const ctrl = useController(handlers);
  const sendRef = useRef(ctrl.send);
  sendRef.current = ctrl.send;

  useEffect(() => {
    const game = new FlyGame(mountRef.current, { onHud: setHud });
    game.setScene(loadScene());
    gameRef.current = game;
    return () => game.dispose();
  }, []);

  const chooseScene = useCallback((name) => {
    const g = gameRef.current;
    if (!g || g.sceneName === name) return;
    g.setScene(name);
    saveScene(name);
    setSceneState(name);
    setWarp((w) => w + 1);
    sendRef.current({ type: 'haptic', pattern: 'double' });
  }, []);

  const toggleScene = useCallback(() => {
    chooseScene(gameRef.current?.sceneName === 'sky' ? 'space' : 'sky');
  }, [chooseScene]);

  const start = useCallback(() => {
    gameRef.current?.start();
    setPhase('playing');
    sendRef.current({ type: 'calibrate' }); // recentre phone tilt to the current grip
  }, []);

  const toMenu = useCallback(() => {
    gameRef.current?.toMenu();
    setPhase('menu');
  }, []);

  handlers.current = {
    onTilt: (x, y, boost) => gameRef.current?.setRemoteInput(x, y, boost),
    onAction: (action) => {
      const p = phaseRef.current;
      if (action === 'primary') {
        if (p === 'menu') start();
        else gameRef.current?.togglePause();
      } else if (action === 'menu' && p !== 'menu') {
        toMenu();
      } else if (action === 'scene') {
        toggleScene();
      }
    },
  };

  // ---- feedback to the phone ----
  const prevBoost = useRef(false);
  useEffect(() => {
    ctrl.send({
      type: 'state',
      mode: phase,
      paused: !!hud.paused,
      scene: hud.scene,
      speed: hud.speed,
      altitude: hud.altNorm,
      alt: hud.altitude,
    });
    if (phase === 'playing' && hud.boost && !prevBoost.current) ctrl.send({ type: 'haptic', pattern: 'tap' });
    prevBoost.current = !!hud.boost;
  }, [hud, phase, ctrl.send]);

  const enableTilt = useCallback(async () => {
    const ok = await gameRef.current?.enableTilt();
    setTiltOn(!!ok);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.code === 'Enter' || e.code === 'Space') && phase === 'menu') {
        e.preventDefault();
        start();
      }
      if (e.code === 'KeyC' && !e.repeat) toggleScene();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, start, toggleScene]);

  return (
    <div className={`app scene-${scene}`}>
      <div className="stage" ref={mountRef} />
      <div className="vignette" />
      {warp > 0 && <div key={warp} className="warp" />}

      {phase === 'playing' && (
        <>
          <div className="hud">
            <div className="cell"><span>Speed</span><b>{hud.speed}<small> km/h</small></b></div>
            <div className="cell"><span>Altitude</span><b>{hud.altitude}<small> m</small></b></div>
            <div className="cell"><span>Heading</span><b>{String(hud.heading).padStart(3, '0')}°<small> {compass(hud.heading)}</small></b></div>
            <div className="cell"><span>Flown</span><b>{(hud.distance / 1000).toFixed(1)}<small> km</small></b></div>
          </div>
          <div className="scene-tag">{SCENE_LABEL[scene]} · <kbd>C</kbd> switch</div>
          {ctrl.ready && <div className="linked-badge">📱 phone linked</div>}
          {hud.boost && !hud.paused && <div className="boost">BOOST</div>}
          <button className="pause-btn" onClick={() => gameRef.current?.togglePause()} aria-label="Pause">
            {hud.paused ? '▶' : '❚❚'}
          </button>
          {hud.paused && (
            <div className="overlay">
              <div className="panel">
                <h2>PAUSED</h2>
                <button className="btn" onClick={() => gameRef.current?.togglePause()}>Resume</button>
                <button className="btn ghost" onClick={toggleScene}>
                  Go to {scene === 'sky' ? SCENE_LABEL.space : SCENE_LABEL.sky}
                </button>
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
              FREE<span>FLY</span>
            </h1>
            <p className="tag">No walls. No score. Just fly.</p>
            <div className="scene-pick" role="radiogroup" aria-label="Scene">
              {['sky', 'space'].map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={scene === s}
                  className={`pick ${scene === s ? 'on' : ''}`}
                  onClick={() => chooseScene(s)}
                >
                  {SCENE_LABEL[s]}
                </button>
              ))}
            </div>
            <button className="btn" onClick={start}>Take off</button>
            {hasTilt && (
              <button className="btn ghost" onClick={enableTilt} disabled={tiltOn}>
                {tiltOn ? 'Tilt steering on' : 'Enable tilt steering'}
              </button>
            )}
            <PhonePanel ctrl={ctrl} />
            <div className="help">
              <div><kbd>←</kbd><kbd>→</kbd> / <kbd>A</kbd><kbd>D</kbd> bank and turn</div>
              <div><kbd>↑</kbd><kbd>↓</kbd> / <kbd>W</kbd><kbd>S</kbd> climb · dive</div>
              <div><kbd>Shift</kbd> boost · <kbd>C</kbd> switch scene · <kbd>P</kbd> pause</div>
              <div>Mouse / touch: hold and drag from the centre</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
