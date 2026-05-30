# (operational) Capturing the Shiny SockJS/WebSocket frames

The head-to-head Shiny adapter (`shiny_adapter.js`) drives the legacy app over
its live WebSocket reactive protocol. The exact frame bytes are version-specific
(Python Shiny ^1.4.0) and are **not** committed pre-filled — they must be
captured against the running legacy app and pasted into `frames.js`. This is an
operational prerequisite; it cannot be unit-tested. Do **not** guess the frames.

A guessed or fabricated handshake will silently fail the SockJS open. The
adapter will then report every action as a timeout, making Shiny appear "down"
when it is not — producing a false G3 win for Go that is inadmissible under
METHODOLOGY.md §1.

---

## (operational) Step-by-step capture procedure

### Prerequisites

- `legacy.tfbindingandperturbation.com` is deployed and serving traffic.
- Chrome or Firefox with DevTools available.
- A second terminal for optional k6 recording (alternative path B below).

---

### Path A: Browser DevTools (recommended for frame-by-frame detail)

1. **Open the legacy app in Chrome.**
   Navigate to `https://legacy.tfbindingandperturbation.com`.

2. **Open DevTools → Network tab.**
   Filter by "WS" (WebSocket) or type `ws` in the filter box.

3. **Hard-refresh the page** (`Cmd+Shift+R` / `Ctrl+Shift+F5`) to capture the
   initial connection from the start.

4. **Identify the WebSocket connection.**
   You will see a request whose URL ends in `/websocket/` (or similar). Click
   it. The URL path is `FRAMES.wsPath` — record it exactly.

5. **Click the "Messages" tab** in the WebSocket detail pane.
   You will see a chronological stream of frames. Client→server frames appear
   in one color (typically green or dark); server→client in another.

6. **Capture the init handshake (client→server).**
   The first few client→server frames after the socket opens, before any button
   click, are the Shiny init messages. Copy each payload string verbatim and
   paste it into `FRAMES.initSend` in order. These typically include:
   - A `{"method":"init","data":{...}}` frame that sends the initial input state.
   - Possibly a `{"method":"ACK"}` or similar acknowledgement frame.
   Record ALL client→server frames sent before you click anything.

7. **Capture the ready-frame marker (server→client).**
   After the init frames, the server sends a `values` frame containing the
   initial rendered output. Identify a short, unique substring of this frame
   (e.g. a key present only in this frame, not in action-response frames) and
   paste it into `FRAMES.readyMarker`.

8. **Capture the update-envelope template (client→server).**
   Click a button in the app (e.g. the "Execute Analysis" button on the Binding
   tab). A client→server frame will appear that sends the button's new counter
   value. Copy the full JSON payload of this frame — it will look something like:
   ```json
   {"method":"update","data":{"binding-execute_analysis":1}}
   ```
   Paste this object (not the string, parse it into a JS object) into
   `FRAMES.updateTemplate`. The `.data` map will be replaced at runtime by the
   adapter with each action's actual inputs, so the exact key/value in
   `updateTemplate.data` does not matter — only the envelope shape (`method`,
   `data`, any other top-level fields) must be preserved.

9. **Confirm SockJS framing (server→client).**
   Observe the raw server frames. If they are wrapped in `a["..."]` (SockJS
   array framing), the defaults in `FRAMES.sockjsFraming` are correct. If the
   connection is a bare WebSocket (no `a[...]` wrapper), set
   `sockjsFraming.messageArrayPrefix` to `''`.

10. **Set `FRAMES.__CAPTURED__ = true`** and commit `frames.js`.
    Do this in the same edit as pasting the frames, so the guard is never
    accidentally flipped without real frames present.

---

### Path B: k6 WebSocket recording (alternative)

k6 v0.43+ ships a `k6 record` subcommand. Run:

```bash
k6 record --target wss://legacy.tfbindingandperturbation.com/websocket/ \
           --output frames_raw.har
```

Open the resulting HAR file; locate the WebSocket connection; extract the
frames from the `_webSocketMessages` array. Map them to `FRAMES` fields as in
Path A. Path A is recommended because DevTools shows frame timing and direction
more clearly than a HAR.

---

### Verification

After pasting the frames and flipping `__CAPTURED__`, run the adapter against
the live legacy app with a single VU and `--duration 10s`:

```bash
k6 run -e BASE_URL=https://legacy.tfbindingandperturbation.com \
        -e SHINY_ACTION_TIMEOUT=30000 \
        --vus 1 --duration 10s \
        tests/loadtest/k6/headtohead/shiny_adapter.js
```

Expected: `shiny_action_ok` rate == 1.0, `shiny_action_ms` p95 < 5000 ms (any
reasonable latency is fine for verification; the SLO is only enforced during
the actual ladder run). If `shiny_action_ok` rate == 0 or the run errors with
"WebSocket dial", the frames are wrong — re-capture.

---

## What NOT to do

- Do **not** fabricate frames by guessing from the Shiny source code. The exact
  session token, CSRF field, and init data structure vary by runtime and must
  come from a live capture.
- Do **not** set `__CAPTURED__ = true` until ALL four slots are filled
  (`initSend`, `readyMarker`, `updateTemplate`, `wsPath` confirmed).
- Do **not** commit `frames.js` with `__CAPTURED__ = true` and empty slots —
  the unit test (`shiny_adapter.test.js`) will still pass (it checks the flag),
  but the adapter will silently produce wrong results at runtime.
