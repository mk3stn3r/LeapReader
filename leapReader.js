// leap-reader.js
const Leap = require('leapjs');

const controller = new Leap.Controller({
  background:     true,
  enableGestures: true,
  optimizeHMD:    false, // desktop mode
});

// --- Connection lifecycle ---
controller.on('connect', () => {
  console.log('✅ Connected to Leap Motion service.');
});

controller.on('disconnect', () => {
  console.log('🔌 Disconnected from Leap Motion service.');
});

// --- Device streaming (replaces deprecated deviceConnected/deviceDisconnected) ---
controller.on('streamingStarted', (deviceInfo) => {
  console.log('🖐️  Device streaming started:', deviceInfo);
});

controller.on('streamingStopped', (deviceInfo) => {
  console.log('✋ Device streaming stopped:', deviceInfo);
});

// --- Focus events (desktop background mode) ---
controller.on('focus', ()  => console.log('🟢 App gained focus.'));
controller.on('blur',  ()  => console.log('🟡 App lost focus (background mode active).'));

// --- Frame data ---
controller.on('frame', (frame) => {
  if (!frame.valid || (frame.hands &&frame.hands.length === 0)) return;

  console.log(`\n─── Frame #${frame.id} ────────────────────────────────`);
  console.log(`    Hands: ${frame.hands.length}  |  Fingers: ${frame.fingers.length}  |  FPS: ${frame.currentFrameRate.toFixed(1)}`);

  frame.hands.forEach((hand) => {
    const p = hand.palmPosition;
    const v = hand.palmVelocity;
    const n = hand.palmNormal;
    const d = hand.direction;

    console.log(`\n  ✋ ${hand.type.toUpperCase()} hand  (confidence: ${hand.confidence.toFixed(2)})`);
    console.log(`     Palm position : [${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}] mm`);
    console.log(`     Palm velocity : [${v[0].toFixed(1)}, ${v[1].toFixed(1)}, ${v[2].toFixed(1)}] mm/s`);
    console.log(`     Palm normal   : [${n[0].toFixed(2)}, ${n[1].toFixed(2)}, ${n[2].toFixed(2)}]`);
    console.log(`     Direction     : [${d[0].toFixed(2)}, ${d[1].toFixed(2)}, ${d[2].toFixed(2)}]`);
    console.log(`     Grab strength : ${hand.grabStrength.toFixed(2)}`);
    console.log(`     Pinch strength: ${hand.pinchStrength.toFixed(2)}`);
    console.log(`     Sphere radius : ${hand.sphereRadius.toFixed(1)} mm`);

    const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
    hand.fingers.forEach((finger) => {
      const tip = finger.tipPosition;
      const vel = finger.tipVelocity;
      console.log(
        `       ${FINGER_NAMES[finger.type].padEnd(6)} ` +
        `tip: [${tip[0].toFixed(1)}, ${tip[1].toFixed(1)}, ${tip[2].toFixed(1)}]  ` +
        `vel: [${vel[0].toFixed(0)}, ${vel[1].toFixed(0)}, ${vel[2].toFixed(0)}]  ` +
        `extended: ${finger.extended ? 'yes' : 'no '}`
      );
    });
  });

  // --- Gestures ---
  if (frame && frame.gestures && frame.gestures.length > 0) {
    console.log('\n  👆 Gestures:');
    frame.gestures.forEach((g) => {
      switch (g.type) {
        case 'circle':
          console.log(`     circle — state: ${g.state}, clockwise: ${g.clockwise}, progress: ${g.progress.toFixed(2)}`);
          break;
        case 'swipe':
          console.log(`     swipe  — state: ${g.state}, speed: ${g.speed.toFixed(0)} mm/s, dir: [${g.direction.map(v => v.toFixed(2)).join(', ')}]`);
          break;
        case 'keyTap':
          console.log(`     keyTap — finger: ${g.handIds[0]}, pos: [${g.position.map(v => v.toFixed(1)).join(', ')}]`);
          break;
        case 'screenTap':
          console.log(`     screenTap — pos: [${g.position.map(v => v.toFixed(1)).join(', ')}]`);
          break;
        default:
          console.log(`     ${g.type} — state: ${g.state}`);
      }
    });
  }
});

controller.connect();

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  controller.disconnect();
  process.exit(0);
});