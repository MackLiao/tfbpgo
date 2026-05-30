// frames.js — CAPTURED Shiny SockJS/WebSocket frames for the legacy app.
//
//   >>> OPERATIONAL PREREQUISITE <<<
// The exact init handshake + input/output envelope bytes are version-specific
// (Python Shiny ^1.4.0) and MUST be captured against the LIVE legacy app at
// legacy.tfbindingandperturbation.com before this adapter can run. See
// ./CAPTURE.md for exact step-by-step capture instructions. Do NOT fabricate
// these — a guessed handshake will silently fail the SockJS open and the run
// will report Shiny as "down" when it is not (a false G3 win for Go).
//
// Until captured, __CAPTURED__ stays false and the adapter refuses to run.
// Paste the real captured frames into the marked slots below, then flip
// __CAPTURED__ to true in the same edit.

export const FRAMES = {
  __CAPTURED__: false,

  // ----- 1. SockJS / WebSocket endpoint path (capture from devtools: the WS
  //          request URL; Python Shiny is typically `/websocket/` but confirm). -----
  wsPath: '/websocket/',

  // ----- 2. Client->server frames sent immediately AFTER the socket opens,
  //          in order, BEFORE any user action (the Shiny init handshake).
  //          Paste each frame's payload string exactly as captured. ----------------
  // <<< PASTE CAPTURED INIT FRAMES HERE >>>
  initSend: [
    // e.g. '{"method":"init","data":{ ...captured... }}'
  ],

  // ----- 3. The server->client frame whose arrival means "session ready"
  //          (the first `values`/config frame). Paste a substring that uniquely
  //          identifies it (used only to know init completed). --------------------
  // <<< PASTE READY-FRAME MARKER HERE >>>
  readyMarker: '',

  // ----- 4. The exact client->server "update" envelope template captured when a
  //          single input changes. The adapter clones this and replaces `.data`
  //          with the action's namespaced {id:value} map. Paste the captured
  //          envelope (with whatever method string Shiny uses, e.g. "update"). ----
  // <<< PASTE CAPTURED UPDATE-ENVELOPE TEMPLATE HERE >>>
  updateTemplate: { method: 'update', data: {} },

  // ----- 5. (optional) SockJS framing prefix/suffix if the transport wraps JSON
  //          arrays (e.g. SockJS sends `a[...]` for messages, `o` on open,
  //          `h` heartbeat, `c[...]` close). Capture and record so the adapter
  //          can unwrap server frames. ------------------------------------------
  sockjsFraming: {
    openChar: 'o',
    messageArrayPrefix: 'a', // server message frames look like: a["<json>"]
    heartbeatChar: 'h',
    closePrefix: 'c',
  },
};

export default FRAMES;

// CommonJS bridge so the Node unit test can require() this same file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FRAMES;
  module.exports.FRAMES = FRAMES;
}
