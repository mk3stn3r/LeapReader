'use strict';
const easymidi = require('easymidi');
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const remap = (v, inMin, inMax, outMin, outMax) => clamp(Math.round(((v - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin), outMin, outMax);
const palmYToNote = (y) => remap(y, 100, 600, 36, 84);
const floatToCC = (v) => remap(v, 0, 1, 0, 127);
const palmXToCC = (x) => remap(x, -200, 200, 0, 127);
const velZToCC = (vz) => remap(vz, -500, 500, 0, 127);
const FINGER_CHANNEL = { right: { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5 }, left: { 0: 6, 1: 7, 2: 8, 3: 9, 4: 10 } };

class LeapMidiInterpreter {
  constructor(portName, options = {}) {
    this._portName = portName;
    this._verbose  = options.verbose ?? false;

    // Accept a pre-opened output injected by index.js (shared port scenario)
    if (options._output) {
      this._output         = options._output;
      this._externalOutput = true;  // index.js owns close()
    } else if (options.virtual) {
      this._output = new easymidi.Output(portName, true);
      console.log(`🎹 Opened virtual MIDI port: "${portName}"`);
    } else {
      const available = easymidi.getOutputs();
      if (!available.includes(portName)) {
        console.error(`❌ MIDI port "${portName}" not found.\nAvailable ports:\n  ${available.join('\n  ') || '(none)'}`);
        process.exit(1);
      }
      this._output = new easymidi.Output(portName);
      console.log(`🎹 Opened MIDI port: "${portName}"`);
    }
    this._activeNotes  = new Map();
    this._lastCC       = new Map();
    this._sustainState = false;
  }

  processFrame(data) {
    for (const hand of data.hands) this._processHand(hand);
    for (const gesture of data.gestures) this._processGesture(gesture, data.hands);
  }

  _processHand(hand) {
    const side      = hand.type;
    const ccChannel = side === 'right' ? 1 : 2;
    this._sendCC(ccChannel, 1,  palmXToCC(hand.palmPosition[0]), `${side} palm X→CC1`);
    this._sendCC(ccChannel, 11, floatToCC(hand.grabStrength),    `${side} grab→CC11`);
    this._sendCC(ccChannel, 7,  floatToCC(hand.pinchStrength),   `${side} pinch→CC7`);
    this._sendCC(ccChannel, 2,  velZToCC(hand.palmVelocity[2]),  `${side} velZ→CC2`);
    const pressure = remap(hand.palmNormal[1], -1, 1, 0, 127);
    this._sendAftertouch(ccChannel, pressure, `${side} tilt→aftertouch`);
    const channels = FINGER_CHANNEL[side];
    for (const finger of hand.fingers) {
      const ch  = channels[finger.type];
      const vel = clamp(Math.abs(Math.round(finger.tipVelocity[1] / 5)), 40, 127);
      if (finger.extended) {
        this._sendNoteOn(ch, palmYToNote(finger.tipPosition[1]), vel, `${side} ${finger.name} extended`);
      } else {
        this._releaseChannel(ch);
      }
    }
    if (hand.confidence < 0.4) for (const ch of Object.values(channels)) this._releaseChannel(ch);
  }

  _processGesture(gesture, hands) {
    const refHand = hands[0];
    const note    = refHand ? palmYToNote(refHand.palmPosition[1]) : 60;
    const ch      = 1;
    switch (gesture.type) {
      case 'swipe':
        if (gesture.state !== 'stop') break;
        if (gesture.direction[0] > 0) {
          this._sendNoteOn(ch, note, remap(gesture.speed, 100, 1500, 40, 127), 'swipe-right');
        } else {
          this._releaseChannel(ch);
        }
        break;
      case 'circle':
        if (gesture.state !== 'stop') break;
        {
          const sustain = gesture.clockwise ? 127 : 0;
          if (sustain !== (this._sustainState ? 127 : 0)) {
            this._sustainState = gesture.clockwise;
            this._output.send('cc', { channel: 0, controller: 64, value: sustain });
            this._log(`⭕ circle ${gesture.clockwise ? 'CW' : 'CCW'} → CC64 ${sustain}`);
          }
        }
        break;
      case 'keyTap':
        if (gesture.state !== 'stop') break;
        this._sendNoteOn(ch, note, 90, 'keyTap');
        setTimeout(() => this._sendNoteOff(ch, note, 'keyTap off'), 50);
        break;
      case 'screenTap':
        if (gesture.state !== 'stop') break;
        this._sendNoteOn(ch, note, 110, 'screenTap');
        setTimeout(() => this._sendNoteOff(ch, note, 'screenTap off'), 50);
        break;
    }
  }

  _sendNoteOn(channel, note, velocity, label) {
    const key      = `${channel}:${note}`;
    const existing = [...this._activeNotes.entries()].find(([k]) => k.startsWith(`${channel}:`) && k !== key);
    if (existing) {
      const oldNote = parseInt(existing[0].split(':')[1], 10);
      this._output.send('noteoff', { channel: channel - 1, note: oldNote, velocity: 0 });
      this._activeNotes.delete(existing[0]);
    }
    if (!this._activeNotes.has(key)) {
      this._output.send('noteon', { channel: channel - 1, note, velocity });
      this._activeNotes.set(key, true);
      this._log(`♪ NoteOn ch${channel} note${note} vel${velocity} [${label}]`);
    }
  }

  _sendNoteOff(channel, note, label) {
    const key = `${channel}:${note}`;
    if (this._activeNotes.has(key)) {
      this._output.send('noteoff', { channel: channel - 1, note, velocity: 0 });
      this._activeNotes.delete(key);
      this._log(`♩ NoteOff ch${channel} note${note} [${label}]`);
    }
  }

  _releaseChannel(channel) {
    for (const [key] of [...this._activeNotes.entries()]) {
      if (key.startsWith(`${channel}:`)) {
        this._sendNoteOff(channel, parseInt(key.split(':')[1], 10), `release ch${channel}`);
      }
    }
  }

  _sendCC(channel, controller, value, label) {
    const key = `${channel}:${controller}`;
    if (this._lastCC.get(key) === value) return;
    this._lastCC.set(key, value);
    this._output.send('cc', { channel: channel - 1, controller, value });
    this._log(`🎛 CC ch${channel} cc${controller}=${value} [${label}]`);
  }

  _sendAftertouch(channel, pressure, label) {
    this._output.send('channel aftertouch', { channel: channel - 1, pressure });
    this._log(`〰 Aftertouch ch${channel} p${pressure} [${label}]`);
  }

  _log(msg) { if (this._verbose) console.log(msg); }

  close() {
    for (const [key] of [...this._activeNotes.entries()]) {
      const [ch, note] = key.split(':').map(Number);
      this._output.send('noteoff', { channel: ch - 1, note, velocity: 0 });
    }
    this._activeNotes.clear();
    // Don't close if the output was injected externally — index.js owns it
    if (!this._externalOutput) {
      this._output.close();
      console.log('🎹 MIDI port closed.');
    }
  }

  static listPorts() {
    const ports = easymidi.getOutputs();
    if (!ports.length) console.log('No MIDI output ports found.');
    else { console.log('Available MIDI output ports:'); ports.forEach((p, i) => console.log(`  [${i}] ${p}`)); }
    return ports;
  }
}

module.exports = LeapMidiInterpreter;
