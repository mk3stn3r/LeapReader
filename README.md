# leap-midi 🖐🎹

Real-time Leap Motion → MIDI bridge using `leapjs` and `easymidi`.  
Supports a JSON mapping system with scale quantization, velocity curves,
monophonic/polyphonic modes, multi-CC per hand, and hot-reload.

---

## Install

```bash
npm install
```

Requires:
- Leap Motion service running (v2 SDK / Orion / Ultraleap)
- Node.js 16+
- A real or virtual MIDI port

---

## Quick Start

```bash
# 1 — list available MIDI ports
node index.js --list-ports

# 2 — run with built-in interpreter (no mapping file)
node index.js --port 0

# 3 — run with a JSON mapping file
node index.js --port 0 --mapping mappings/minitaur.json

# 4 — verbose MIDI output + raw Leap frame display
node index.js --port 0 --mapping mappings/minitaur.json --verbose --display

# 5 — create a virtual MIDI port (macOS/Linux)
node index.js --virtual --mapping mappings/theremin.json
```

---

## CLI Reference

| Flag | Description |
|---|---|
| `--port <N>` | Select MIDI output port by index from `--list-ports` |
| `--mapping <path>` | Path to a JSON mapping file. Omit to use built-in interpreter |
| `--virtual` | Open a virtual MIDI port instead of a hardware one |
| `--verbose` | Log every MIDI message sent |
| `--display` | Print raw Leap frame data to the console |
| `--frame-skip N` | Process every N+1 frames (default: 2, reduces CPU) |
| `--list-ports` | List available MIDI output ports and exit |
| `--help` | Show usage help |

---

## Mapping File Format

JSON mapping files describe how Leap Motion data maps to MIDI messages.
All keys beginning with `_` are treated as comments and are ignored.

### Top-level fields

```jsonc
{
  "midi_channel":          0,        // 0-indexed MIDI channel (0 = channel 1)
  "velocity_fixed":        null,     // set a number to override all velocities
  "velocity_curve":        "soft",   // global curve: linear|soft|hard|exp|log|fixed:<N>
  "gesture_note_duration": 0.10,     // gesture note length in seconds
  "scale": {
    "name": "minor",                 // see Scale Names below
    "root": "A"                      // root note: C C# D D# E F F# G G# A A# B  (or Bb Eb etc.)
  }
}
```

### Hand configuration

```jsonc
"right_hand": {
  "axis":           "palm_y",    // axis driving note pitch — see Axis Names below
  "note_min":       48,          // lowest MIDI note at bottom of axis range
  "note_max":       60,          // highest MIDI note at top of axis range
  "trigger_mode":   "retrigger", // retrigger | hold | gate
  "polyphonic":     false,       // true = all positions generate independent notes
  "velocity_axis":  "vel_y",     // axis driving velocity (null = use palm speed)
  "velocity_curve": "hard",      // overrides global curve for this hand
  "min_confidence": 0.35,        // ignore hand data below this confidence (0–1)

  // Single CC (legacy / simple):
  "cc_send":   true,
  "cc_number": 74,
  "cc_axis":   "grab",

  // Multi CC (array form):
  "cc_send": [
    { "cc_number": 16, "cc_axis": "palm_x" },
    { "cc_number": 17, "cc_axis": "pinch",  "velocity_curve": "log" }
  ]
}
```

### Trigger modes

| Mode | Behaviour |
|---|---|
| `retrigger` | New Note On fired every time the pitch changes; previous note is released first |
| `hold` | First note stays held until hand leaves the field |
| `gate` | Note held while hand is present; re-fires if pitch changes |

### Circle CC

```jsonc
"circle_cc": {
  "cc_number": 74,   // CC number to sweep
  "step": 4          // amount added/subtracted per frame; increase for faster sweeps
}
```
Set to `null` to use CC64 sustain-pedal toggle mode instead.

### Gestures

```jsonc
"gestures": {
  "swipe_right":     { "type": "swipe",     "direction": "right",  "note": 43, "velocity": 110 },
  "key_tap_right_1": { "type": "keyTap",    "hand": "right", "finger": 1, "note": 50, "velocity": 127 },
  "screen_tap_left_2":{ "type": "screenTap","hand": "left",  "finger": 2, "note": 16, "velocity": 110 }
}
```

Swipe directions: `left` `right` `up` `down` `toward` `away`  
Finger numbers:  `0` Thumb · `1` Index · `2` Middle · `3` Ring · `4` Pinky

---

## Axis Names

| Name | Source | Range |
|---|---|---|
| `palm_y` | Palm height (mm) | 80–650 |
| `palm_x` | Palm left/right (mm) | −250–250 |
| `palm_z` | Palm depth (mm) | −250–250 |
| `grab` | Grab/fist strength | 0–1 |
| `pinch` | Pinch strength | 0–1 |
| `roll` | Palm roll (side tilt) | −1–1 |
| `pitch` | Palm pitch (forward tilt) | −1–1 |
| `yaw` | Palm yaw (left/right point) | −1–1 |
| `vel_y` | Palm vertical speed (mm/s) | −600–600 |
| `vel_x` | Palm horizontal speed | −600–600 |
| `vel_z` | Palm depth speed | −600–600 |

---

## Scale Names

`chromatic` `major` `minor` `harmonic_minor` `melodic_minor`  
`dorian` `phrygian` `lydian` `mixolydian`  
`pentatonic` `minor_pentatonic` `blues` `whole_tone` `diminished` `augmented`

---

## Velocity Curves

| Curve | Effect |
|---|---|
| `linear` | No shaping — input = output |
| `soft` | Gentle response, quieter at low velocities |
| `hard` | Punchy response, louder at low velocities |
| `exp` | Very soft until high input — dramatic curve |
| `log` | Loud quickly — good for percussion |
| `fixed:<N>` | Always outputs value N (e.g. `"fixed:100"`) |

---

## Hot Reload

Edit any mapping JSON file while the script is running — changes are detected and applied automatically within 150 ms, with all held notes released cleanly first.

```bash
# Edit mappings/minitaur.json in your editor while the script runs
# Changes apply immediately — no restart needed
```

---

## Included Mappings

| File | Device | Notes |
|---|---|---|
| `mappings/minitaur.json` | Moog Minitaur | A minor, soft curve, CC74/71, per-finger taps |
| `mappings/digitakt.json` | Elektron Digitakt | C pentatonic, hard curve, multi-CC per hand |
| `mappings/theremin.json` | Any synth | Chromatic, gate mode, left hand = volume |

---

## Module API

### LeapReader (`leap-reader.js`)

```js
const LeapReader = require('./leap-reader');
const reader = new LeapReader({ frameSkip: 2 });
reader.on('frame', (data) => { /* structured frame */ });
reader.connect();
reader.disconnect();
```

### MappingReader (`mappingReader.js`)

```js
const MappingReader = require('./mappingReader');
const midi = new MappingReader('mappings/minitaur.json', output, { verbose: true });
midi.processFrame(data);   // call on every LeapReader 'frame' event
midi.close();              // release all held notes
```

### LeapMidiInterpreter (`leap-midi-interpreter.js`)

Built-in hardcoded interpreter, used when no `--mapping` flag is provided.
