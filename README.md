# gyro_games

Browser games built with React + three.js where the **laptop is the screen** and a **phone is the motion controller**, linked over local Wi-Fi.

| Game | Folder | Port | Phone controller |
|---|---|---|---|
| Gyro Runner: endless flyer through a field of towers | [`gyro-runner/`](gyro-runner) | 5274 | Tilt to steer, tip forward/back to dive/climb |
| Fruit Smash: slice tossed fruit, dodge thorn mines | [`fruit-smash/`](fruit-smash) | 5275 | Point like a remote and swing to slash |

## Run a game

```bash
cd gyro-runner   # or fruit-smash
npm install
npm run dev
```

1. On the laptop, open `https://localhost:<port>`.
2. Scan the QR code on the game's menu with your phone (same Wi-Fi), or open the controller URL printed in the terminal.
3. Both devices warn about the certificate. Choose **Advanced / Show Details** and continue.
4. On the phone, tap **Enable motion**, then **Start**.

Keyboard, mouse and touch controls also work without a phone.

## How the link works

Each game's dev server runs over HTTPS (iPhone Safari only exposes motion sensors on secure pages) using a self-signed certificate generated into `.cert/` on first run; that folder is git-ignored. A small WebSocket relay at `/gyro-ws` passes controller input from phone to game, and game state and haptic cues back to the phone. See `server/controllerPlugin.js` in each game.
