# Remote access

## What it is

- **Two ways into the machine the service runs on, from the console:** a terminal and the desktop.
  - The terminal is a login shell of the service's account, shown in the browser by the screen's terminal
    interface (「The terminal interface」).
  - The desktop is the machine's wayland session, reached through GNOME's remote login
    (gnome-remote-desktop) and shown in the browser over RDP.
- **One target only.** The machine the service runs on is the only machine either one reaches. It is not a
  general remote-access system: no route, screen or setting names another host.
- **No agent.** Nothing is installed or run for it beyond tmux and this service; the service reaches both
  targets directly.
- **Where the rest is:** the screen's shape — tabs, the whole-window view, the windows of their own, the
  view's menu — is `docs/screen.md`. What the service serves, its settings and what the console does in
  front of it are `docs/api.md`. This document says what holds the sessions, what crosses the wire, and
  where the boundary stands.

## Terminal sessions

### tmux holds them

- **Every terminal session is a tmux session** on a socket of the service's own, never the socket a
  person's own tmux uses.
- **The socket's name** is the setting `terminal.socket`, `bmo-remote` where none is set. A development
  instance names a socket of its own in its local settings, so nothing done there reaches a deployed
  instance's sessions.
- **What a session runs:** the account's login shell, read from the machine's passwd database rather than
  from the environment and set as the server's default shell, which tmux starts as a login shell. A shell
  that is not an absolute path is replaced by `/bin/sh`. A session starts in the account's home directory.

### The server outlives the service

- **Started lazily.** When the service needs a session and the socket does not answer, it starts the tmux
  server as a transient systemd user unit:
  `systemd-run --user --collect --unit bmo-remote-<socket> tmux -L <socket> -f <conf> -D`.
- **Why a unit of its own:**
  - the service is stopped with its whole control group, so a tmux server started as its child would die
    on every deployment and take every shell with it;
  - a scope does not keep the server either; a transient service does;
  - the unit runs in the user manager's environment, not the service's, so the service's secrets never
    reach a shell.
- **So a deployment keeps every terminal.** Restarting the service only drops the browser connections; the
  sessions and what runs in them stand, and the page reattaches.
- **The configuration** is the file the setting `terminal.config` names, the deployed `tmux.conf`. The
  service applies it to a running server once each time it starts, so a changed configuration takes
  effect with the next deployment without restarting the server.

### What the configuration sets

- **tmux is invisible plumbing.**
  - The status line is off.
  - There is no prefix key; the default one is unbound, so every key reaches the program.
- **Terminal behaviour.**
  - Mouse support is on, so tmux turns mouse reporting on in the browser's terminal and hands mouse
    events to a program that asks for them.
  - The inner terminal type is `tmux-256color`, and the outer `xterm-256color` is marked as having true
    colour.
  - History keeps 50,000 lines.
  - The window takes the size of the client that spoke last.
  - The escape wait is 10 ms.
  - Focus events, extended keys, clipboard setting and passthrough are on.
- **The server never ends by itself:** it does not exit when its last session ends, and a session with no
  client attached is not destroyed.
- **The wheel.** A wheel step over a pane goes, in this order:
  1. to the program as a mouse event, when the pane is already in copy mode or the program asked for
     mouse reporting;
  2. to the program as three arrow-key presses, when the program is on the alternate screen;
  3. otherwise, upward, into copy mode, which scrolls tmux's own history and leaves it again at the
     bottom; downward there is nothing below the live screen, and the step does nothing.
- **No tmux menus.** A right press never opens tmux's own menu inside the terminal.

### Session identity

- **An id** is the tmux session name, `t-` followed by lower-case letters and digits. The service makes
  it; nothing else is accepted as an id.
- **A title** is the tmux user option `@title` on that session, at most 80 characters. Renaming sets it,
  and an empty title takes it away.
- **Nothing is kept in the store.** The list of sessions, their titles and their creation time are read from
  tmux each time.
- **A call to tmux** that stands longer than five seconds is taken as failed, and a server just started
  gets five seconds to open its socket.

### The terminal socket

- **One websocket per viewer,** at the terminal socket route for one session id (`docs/api.md`).
  - The first size, in columns and rows, comes in the query string, so the terminal starts at the size
    the browser shows; 80 by 24 where none is given.
  - Opening it starts one tmux attach client for that session in a pseudo-terminal of this machine, with
    terminal type `xterm-256color` and true colour declared.
  - Closing it ends that attach client only. The session goes on.
  - Several viewers may watch one session at once.
- **Frames from the service.**
  - Binary frames are what the terminal prints, gathered for at most 30 ms or 16 KiB before they are sent.
  - Text frames are JSON control messages.
- **Frames from the browser are all binary, and the first byte says what the rest is.**
  - `0` — the rest is what was typed, as bytes.
  - `1` — the rest is a JSON control message, in UTF-8.
  - Anything else is ignored.
  - A byte and not the frame kind says it, since a layer in front may hand text and binary frames over
    alike.
- **Control messages** carry a `type`:

    | Type | From | Meaning |
    |---|---|---|
    | `resize` | browser | the terminal's new columns and rows |
    | `ready` | service | the attach client stands; carries the id and the size |
    | `exit` | service | the session has ended |
    | `error` | service | what went wrong, as a code and an English sentence |

- **Replay is tmux's.** An attach client is repainted whole by tmux: the visible screen and the terminal
  modes the session is in — alternate screen, mouse reporting, focus events, bracketed paste. A page
  reloaded or opened in a second tab therefore starts in the same state as the program believes the
  terminal is in. History beyond the screen is read through the wheel, in copy mode.
- **Reconnecting.** A dropped socket is reopened by the page with growing waits, sending the current size,
  and tmux repaints again.

### Managing sessions

- **Plain HTTP routes** list, read, create (with an optional title), rename and end sessions.
- **An id** is checked against its pattern and against tmux's own list before anything is done with it;
  one that does not match is refused.
- **Ending a session** kills the tmux session and every program in it. The remote screen ends one when its
  tab is closed, after asking.

## The desktop

### How it is reached

- **In the browser:** IronRDP's web client — the `@devolutions/iron-remote-desktop` web component with the
  `@devolutions/iron-remote-desktop-rdp` backend, a WebAssembly build of an RDP client. The component is
  pinned to an exact published version; the backend is a build of this repository's own, kept under
  `client/vendor/`.
  - **The backend carries the RDP graphics pipeline** (RDPEGFX), which no published release of it has.
    gnome-remote-desktop draws through nothing else, so the build always offers it.
  - **H.264 is decoded by the browser.** Where the browser's WebCodecs decodes H.264 at the size the
    connection asks for, the pipeline offers AVC420 (capability set 8.1) beside the plain set 8;
    elsewhere it offers set 8 alone, and the server draws with its other codecs.
    - Each AVC420 picture goes from the WebAssembly to the browser's decoder, on the graphics card where
      the browser has one, and the regions the picture updates are read back as RGBA into the surface
      it draws on.
    - The pipeline holds every command behind a picture until its pixels are back, so the surfaces take
      the commands in the server's order and the next frame is read only once the picture is drawn.
    - The picture covers its whole surface; the regions it names are surface coordinates, widened to
      even ones for the 4:2:0 read-out.
    - Pictures are read as full-range BT.709, as MS-RDPEGFX prescribes, whatever the stream signals: a
      decoder tags a stream that signals nothing with a default of its own, so a region of a picture
      tagged otherwise is copied out in its own planes and read again under BT.709.
    - A decoder that holds pictures back for reordering, which RDP never needs, would leave the last
      change undrawn while the desktop stands still. It is caught on a stream's first picture, which
      a flush then brings out, and every stream goes on with the browser's software decoder.
    - A decode that fails ends the connection, and the page offers no H.264 again until it is reloaded.
    - AVC444 is not offered: the browser's decoder gives no 4:4:4 picture to combine the two streams
      into, and gnome-remote-desktop encodes 4:2:0 alone.
  - **The build is reproducible.** `bun client/scripts/build-ironrdp.ts` checks IronRDP out at the commit it
    pins, applies the patch kept beside the build, copies in the browser's half of the H.264 decoding
    (`avc420.js`, beside the patch), compiles the WebAssembly and writes the package into
    `client/vendor/`. It needs git, npm, rustup and wasm-pack, and keeps its checkout outside the
    repository.
  - Its backend's initialisation takes a non-empty log level.
  - The component's readiness event can fire before any asynchronous step that follows it, so the page
    listens for it before awaiting anything.
- **On the server:** a relay speaking RDCleanPath, the handshake IronRDP expects from a websocket
  gateway. It is a transparent pipe: it never runs an RDP connection of its own, and the browser's client
  negotiates everything past the handshake with the desktop itself. Past the handshake it carries bytes,
  and reads RDP only to rewrite the logon packet as 「Credentials」 and 「Connection settings」 say, to read
  the pointer's shapes as 「The pointer」 says, to notice a redirection as 「Redirection」 says, and to type
  what 「The on-screen keyboard」 sends. Where the desktop asks for network-level authentication the relay
  is what answers it, as 「Credentials」 says.
  - **The relay runs in the desktop sidecar,** a bun process of this repository's own under
    `desktop-sidecar/`, which the service starts beside itself and hands the desktop's three sockets on to
    over the loopback address (`docs/api.md`, 「The desktop sidecar」). The relay, the pointer's reader, the
    typist, the input method's reader and the focus watcher are all the sidecar's; the service takes the
    upgrades behind its token and carries their frames.
- **The split is Guacamole's:** a server-side relay, a browser-side display, and an input layer that turns
  pointer and keys into protocol events. Guacamole's daemon and its protocol are not used; the RDP stack
  runs in the browser.

### Where the desktop is

- **The desktop is always on this machine.** The relay dials the setting `desktop.host`, `127.0.0.1`, and
  nothing else, whatever destination the browser's request names.
- **Which port it dials is a value in this repository's store.** With none, or one that is not a port, it
  dials the setting `desktop.port`, 3389, the usual RDP port. `bmo node remote-desktop` shows it and sets
  it (`docs/api.md`, 「The command」).
- **The desktop is gnome-remote-desktop's remote login**, which listens on 3389, so no value is stored and
  the default names it.
- **The relay reads the store on every connection**, so moving the desktop to another RDP server is a
  change to the value and the next connection, with no deploy and no restart.
- **Only this machine and the LAN reach the desktop.** The host firewall admits the RDP port from the LAN
  alone, and the relay dials it over loopback. Open to the internet, the port draws scanners trying
  passwords, and gnome-remote-desktop's system daemon, tearing down a burst of their connections,
  deadlocks: it accepts nothing more until it is restarted, and the relay reports every connection after
  that as refused once its eight seconds have passed (「The relay」).

### The relay

1. **The first binary frame** from the browser is the RDCleanPath request. The relay takes the X.224
   connection request it carries. The destination it names is ignored. A request that cannot be read is
   answered with an RDCleanPath error and the socket closes.
2. **The relay dials the desktop** (「Where the desktop is」) and sends the browser's own connection
   request, with only the security protocols and the routing token rewritten as 「Credentials」 and
   「Redirection」 say.
3. **It reads the server's X.224 confirm,** one TPKT frame, and with it which security protocol the
   server chose.
4. **It turns the same connection into TLS,** without checking the server's certificate: the peer is this
   machine, and its certificate is its own self-signed one.
5. **It authenticates** where the server chose network-level authentication and the relay holds the
   password (「Credentials」). The browser hears nothing of this.
6. **It answers the browser** with the RDCleanPath response: the confirm, the server's certificate chain
   and the server address.
7. **From then on it relays bytes both ways.** Closing either side closes the other.

- **Frames before the answer.** Only the first frame is read as a request; anything the browser sends
  before the answer is dropped.
- **Failures before the answer** are sent as an RDCleanPath error, then the socket closes:
  - a request that cannot be read — general error, HTTP status 400;
  - the desktop refusing the credentials — general error, HTTP status 401, which the page shows as a
    refused connection;
  - the server not accepting the connection — general error, WSA 10061;
  - a step standing longer than eight seconds — general error, WSA 10060;
  - no confirm, a malformed one, or a TLS handshake that fails or shows no certificate — negotiation
    error.
- **Every such failure is written to the service's log**, one line naming the address dialled and which of
  those it was, so a refusal the page showed can be found afterwards in the service's journal.
- **The certificate chain** is the server's leaf certificate alone.

### One desktop

- **The remote login keeps one session per user.** Every new connection opens on the login screen, and
  logging on there hands it the account's wayland session where one is running, or starts one where none
  is (「The login screen」). The session outlives its connection, and a new connection takes the desktop
  over from the one before.
  - So every new connection — a reload, a window of its own, a new size or quality — passes the login
    screen again. The remote login routes a connection straight to a running session only with the
    one-time account it names in its latest redirection, which the relay holds for the next connection
    alone (「Redirection」).
- **So a page holds at most one desktop connection.** The desktop tab and the whole-window view show that
  one connection; moving between them moves its element and never reconnects.
- **A window of its own takes the desktop over.** A desktop window opened from the screen connects anew,
  and logging on at its login screen hands it the session. Every window of the console tells the others
  when it has connected, and the others let their connection go and say that the desktop is open in
  another window.
- **The component never leaves the document.** It destroys itself, and its connection, a moment after it
  is taken out. Between views it waits in a hidden place kept in the page, and it is only ever moved from
  one place in the document to another.
- **Size.** The connection asks for the size 「Connection settings」 says. The picture is scaled to fit its
  place, and fitted again whenever the place is shown or resized.
- **The place keeps its size whatever the connection is doing.** What the connection is doing is a thin
  line laid over the top of the desktop, never a line that pushes it down, so connecting, ending or
  reconnecting never resizes the place and never asks the desktop for another size.
- **No border.** The component draws a line around itself while it takes the keys, and the browser draws a
  focus ring on the canvas it focuses; the screen removes both with a style sheet adopted into the
  component's shadow root, never an element there. The component takes a key only while its own markup is
  the first element of its shadow root, so an element put in before it would stop every key.
- **The mouse coming over the desktop takes focus, except from what floats.** The component focuses its
  canvas the moment the mouse enters it, so it can take the keys. A pointer on its way into a popover, a
  menu or a dialog standing over the desktop crosses the canvas, and focus taken there closes that thing
  as focus leaving it. So while focus stands in something floating, the mouse entering the canvas is
  stopped in the component's shadow root before the component hears it; a press on the desktop still
  reaches it. The mouse entering an element never leaves the shadow root it happens in, so the hold stands
  there.
- **Touch.** The component reads a mouse from its canvas, and a finger makes none, so gestures are turned
  into mouse events there, in one of two modes.
  - **The touch mode** (`touch`) — the finger presses where it touches:
    - a tap is a left click where it touched; a movement within 8 pixels is still a tap;
    - a drag holds the left button from where it started;
    - holding still for half a second is a right click.
  - **The pointer mode** (`pointer`) — the finger moves a pointer, as on a laptop's touchpad:
    - the pointer starts in the middle of the desktop and moves 1.5 pixels for each pixel the finger moves,
      kept inside the desktop;
    - a tap is a left click where the pointer stands, and holding still is a right click there;
    - a tap and a second touch within 300 ms and 24 pixels of it hold the left button while the finger
      moves.
  - In both, two fingers moving up or down turn the wheel, one step per 20 pixels, and the browser is told
    not to pan or zoom over the desktop.
  - **While the phone's keyboard is up** the desktop can be moved and magnified, so what the keyboard
    covers can be seen:
    - two fingers pinch it between its fitted size and four times that, and move it as they move, in
      place of the wheel;
    - in the touch mode a finger dragging moves it, in place of holding the button; a tap and a hold still
      click where the desktop is shown under the finger;
    - in the pointer mode a finger still moves the pointer;
    - it moves up by as much as the keyboard covers of its place, and further where it is magnified, and
      never shows past its own edges;
    - the keyboard going down puts it back as it was.
- **The mouse's back and forward buttons** over the desktop are kept from moving the page through its
  history; the component still reads their presses and sends them, and they reach the desktop's programs
  as buttons 8 and 9.
- **The on-screen keyboard** is a text box standing inside the component's shadow root, raised on touch
  screens by a button and by a text field on the desktop taking focus, and laid over the desktop rather
  than shrinking it; 「The on-screen keyboard」 below says how it comes and goes and where what is typed
  goes. A physical key is the component's own.
- **The RDP server itself is left as it stands.** Its configuration, its credentials and its listening
  address are not this service's; the service only ever dials the loopback address.

### The on-screen keyboard

- **The phone's keyboard is laid over the page.** While the box has focus the page asks the browser,
  through the VirtualKeyboard API's `overlaysContent`, to lay the keyboard over the page instead of
  shrinking it, and reads how much of the desktop's place it covers from the keyboard's geometry. So
  neither the place nor the desktop's size changes, and the desktop can be moved and magnified to see
  what is covered (「One desktop」). The console's other screens keep the keyboard taken off the page.
  - A browser without that API still shrinks the page, and the desktop keeps the size it has while the
    keyboard is up.
- **The keyboard button raises the keyboard and holds no state.** On a touch screen it stands beside the
  view's menu while the desktop is shown, and a press puts focus in the box, which brings up the phone's
  keyboard. It shows no pressed or chosen state and never lowers the keyboard: the phone's own key or the
  back gesture does that. A press while the box still has focus but the keyboard is down gives the focus
  again, so the keyboard comes up.
- **The keyboard going down takes focus out of the box.** A phone that lowers its keyboard by its own key
  leaves focus where it was, and a box still holding it would raise the keyboard again with the next
  touch. So once the keyboard has come up for the box and then gone down, the box lets go of focus, and
  the keyboard comes up again only by the button or by a text field taking focus.
  - Where the VirtualKeyboard API is, its geometry says the keyboard went down: no height once it had
    some.
  - Elsewhere the visual viewport says it: back to the height it had when the box took focus, after
    shrinking by more than a keyboard's least height.
- **What is typed goes into the connection's own stream.** The page opens the keys socket beside each
  connection, naming the same channel as its pointer socket (「The pointer」). The relay of the connection
  on that channel types each message into the client's stream as fast-path input PDUs, only while that
  stream stands between two of the client's own PDUs. The relay counts where each of them ends — TPKT
  framing, or the fast-path length — and a stream it cannot count is typed into no more. Messages are typed
  one at a time in the order they came, a moment apart for each key, so the session reads them in that
  order with the component's own input.
  - The socket answers `ready` once it has joined a channel, and one naming no valid channel is closed.
    It then carries the session's focus to the page (「A text field taking focus」).
    Until it is ready the page sends through the component, in its Unicode mode, what the component can
    carry: a character as a key press carrying it, and a key by its physical code.
  - Messages from the page are JSON: `text` with the characters to type, at most 4,096, and `key` with one
    key or chord and how many times to press it, from 1 to 500. A key is named by its physical code as the
    browser names it (`Enter`, `Backspace`, `ArrowLeft`, `KeyC`, `Digit1` and their kin), with `ctrl`,
    `alt`, `shift` or `meta` joined in front by `+`. Anything else is ignored.
- **A character other than Hangul goes as a Unicode keyboard event.** gnome-remote-desktop turns one into a
  key only where the session's keymap has the character and drops the rest, naming each one it drops in
  its journal as a keyval with no keycode in the current group. The session's keymap is the US layout, so
  ASCII arrives.
- **Hangul goes through the desktop's input method**, as a physical keyboard's does. The session's fcitx5
  composes syllables from 두벌식 keys, so the relay types a syllable as the keys that compose it: its
  initial, its vowel and its final, a doubled consonant as its shifted key, a compound vowel or final as
  its two keys. A lone compatibility jamo is typed the same way.
  - **Before each message the relay asks fcitx5 what state it is in**, on the account's session bus. Where
    no input context has focus, or fcitx5 does not answer, or its Hangul engine is set to a layout other
    than 두벌식, the whole message goes as Unicode events and its Hangul is dropped.
  - **The mode is changed by fcitx5's own trigger key**, the first of the trigger keys its configuration
    names that the relay can type — right Alt, or Ctrl with Space — typed in the same stream as the text,
    so the change lands in order with the keys around it. The Hangul key is not one: gnome-remote-desktop
    turns its scancode into no key the session reads as Hangul. Hangul is typed with the mode on, and
    everything else with it off: a letter's key in Hangul mode is a jamo.
  - **Every message ends with the mode off**, which commits the syllable being composed, and then turns it
    back on where the message found it on. So the Backspace a correction sends next takes back a whole
    character, and the desktop is left in the mode it was in.
  - **A lone jamo never joins its neighbour.** The mode is turned off and on again between it and the
    Hangul beside it, so ㄱ followed by ㅅ stays two letters rather than becoming ㄳ, and 오 followed by ㅏ
    does not become 와.
  - After a message that changed the mode, the next one waits a moment before it asks fcitx5 its state,
    so the answer is not read while the keys before it are still on their way.
- **A physical keyboard's Hangul is the desktop's own.** The keys go as scancodes, and the session's input
  method (fcitx5, toggled by the Hangul key or the right Alt) composes the syllables.
- **The box mirrors the line being written.** What the box holds is what was typed on the desktop since the
  box was last emptied. On every change of the box — a composing syllable included — the part that no
  longer matches is taken back with Backspace and the rest is typed, so a syllable shows on the desktop
  while it is being composed and a correction by the keyboard is carried over.
- **What a 12-key keyboard spells a syllable with on its way is left out of that line.** 천지인 writes a
  vowel it has not finished as dots — ㆍ, ᆢ, `·`, `‥` — beside the letters before it (`ㄷㆍ` on its way to
  `더`), and may write an unfinished syllable in old conjoining jamo. No key of the desktop types those, so
  the desktop drops them; were they counted in the line, the next change would take back one character
  more than the desktop holds and eat the one before it.
- **Keys of their own.** Enter types Return and ends the line. Backspace and Delete on an empty box are sent
  as those keys; on a box with text the change of the box sends them. Tab, Escape, the arrows, Home, End,
  Page Up and Page Down, and a chord with Ctrl, Alt or Meta are sent as keys and end the line. None of the
  box's own key events reaches the component, so nothing is typed twice.
- **The line ends** on Enter, on a key that moves the caret, on a press on the desktop, and when the box
  loses focus. The box is emptied then, but never while a composition may still be alive: a keyboard that
  has its text changed under it loses the place its composition started.

### A text field taking focus

- **RDP says nothing of focus**, so the session itself is asked. The sidecar runs a focus watcher in the
  account's desktop session while at least one keys socket is open, and stops it when the last one closes.
  - It is an AT-SPI client on the account's session bus, the bus fcitx5 is asked on: a Python script beside
    the sidecar, `remote/desktop-focus.py` in its folder, run as the sidecar's child with `python3 -I` and
    writing each answer it settles on as a line of JSON. It needs GObject introspection's AT-SPI binding.
  - It listens for `object:state-changed:focused`. The object holding focus counts as a text field where
    it is editable and not read-only, or is a terminal.
  - It settles on a new answer a moment after the last change, so focus passing from one field to the
    next is no change at all.
  - A watcher that ends or never starts leaves the page without focus messages; it is started again with
    the next keys socket.
- **The sidecar sends each change to every keys socket** as `{"type": "focus", "editable": …}`. It sends
  changes only, never the state a socket finds on joining, so connecting never raises the keyboard by
  itself.
- **On a touch screen the page follows it.** A text field taking focus puts focus in the box, as the button
  does; focus leaving every text field takes it out, and the keyboard goes down. A screen with no touch
  keeps the component's own keys, and the messages change nothing there.
  - A browser may decline to raise its keyboard for focus the page gives without a touch of its own; the
    button stays for that.
- **What the watcher sees** is what the session's programs tell AT-SPI: GTK programs and the shell always;
  Qt programs, which the session's environment asks for it; Chrome, Electron and Firefox only while the
  desktop's accessibility is switched on, which it is not.
- **The login screen is not watched.** GDM's greeter runs as its own account, on a session bus and an
  accessibility bus of its own made afresh for each connection, which the service's account cannot reach.
  The keyboard there is the button's.

### The pointer

- **The client drops the server's pointer.** The release in use turns it off in its own configuration and
  offers no way to turn it on, so the browser would show its own arrow over the whole desktop.
- **So the relay reads the shapes and the page sets them.** Each connection names a pointer channel: the
  page makes up a name, opens the pointer socket with it, and gives the same name to the desktop socket.
  The relay reads every fast-path pointer update it passes on — hidden, default, cached, and new ones in 1,
  24 or 32 bits, large ones included — and sends it to the pointer sockets of that channel as a JSON text
  message, a new shape with its pixels as RGBA in base64.
- **On the page** a new shape is drawn on a canvas, made a PNG and set as the desktop canvas's CSS cursor
  with its hot spot, and kept under its cache index for the cached updates that name it again. A shape
  larger than 32 pixels is scaled down to 32, hot spot with it; a hidden pointer is no cursor, and the
  default is the browser's arrow.
- **What a cursor cannot do is drawn black:** a pixel that inverts the screen under it.
- **A shape that cannot be drawn is not sent,** and the page keeps the cursor it had: a side of none or
  above 384 pixels, the largest a browser takes as a cursor; a colour depth other than 1, 24 or 32 bits; or
  masks that are not whole scanlines, each padded to two bytes.
- **The desktop works without it.** The page waits for its pointer socket at most a moment before
  connecting, and a pointer socket naming no valid channel is closed at once.

### Credentials

- **The service keeps the desktop password** as the setting `desktop.password`, in the deployment's local
  settings file or its environment, beside its token. It is never in the repository, a log, a document or
  a page.
- **The service tells the page only whether it keeps one,** with the account name the desktop is reached
  as.
- **Where it keeps one, the relay answers the desktop's authentication for the page** (「Network-level
  authentication」) and uses it for nothing else: it logs no session on.
  - The page sends a fixed placeholder as the password, since the client builds no connection without one.
  - The relay, which holds the clear-text stream, finds the client's logon packet (TS_INFO_PACKET) among
    the client's first frames after its core data, and where the password there is the placeholder empties
    it and clears the automatic-logon flag, so the packet asks no server to log a session on.
  - The packet is rebuilt whole, so the lengths around it — TPKT, the MCS user data — are written again.
  - A password typed by hand is left as it is.
- **Where it keeps none, the password is typed when connecting.** It is held only in the page's memory, so
  switching tabs and opening a window of its own do not ask again, and a reload does. It passes inside the
  bytes the relay carries.
- **A wrong password** is refused at network-level authentication by gnome-remote-desktop, which the page
  shows as a refused connection.

#### Network-level authentication

Some RDP servers take no connection at all until the credentials have been proved — gnome-remote-desktop
is one, and it offers nothing but NLA. The browser's client can speak CredSSP itself, but only with a
password the page holds, and the service's own password never reaches a page. So the relay is what answers
NLA, and the browser is kept out of it.

- **The browser's client is told to leave CredSSP off** where the service keeps the password, and to run it
  where the password was typed into the page. So exactly one of the two authenticates.
- **The relay adds NLA to what the connection asks for** where it holds the password and the browser asked
  for none. The server still chooses: one that chooses plain TLS is spoken to as before.
- **CredSSP runs over the TLS connection before the browser is answered**: NTLMv2 against the server's
  challenge, the server's public key bound into the exchange with a nonce of the relay's own, the server's
  answer checked to bind the same key, and the credentials delegated last. This exchange is all the relay
  authenticates; nothing of the RDP connection sequence after it is the relay's.
- **The browser is told TLS was chosen**, since it did not authenticate. The client writes what it was told
  into its core data, and a server reads a core data that disagrees with its own choice as a downgrade
  attack, so the relay writes the server's real choice back into that block as it passes.
- **A refused logon is a refused connection**, reported to the page as such rather than as a broken
  handshake.

#### What gnome-remote-desktop needs

Its remote login is a wayland session, reached over RDP, and two things about it are fixed by the server
rather than by this service.

- **It authenticates with the credentials stored for its own RDP server**, not with the account's login
  password. They are set on the machine with `grdctl`, and a value stored with quotation marks around it is
  a different password from the same value without them. `desktop.password` holds that stored password.
- **It draws only through the RDP graphics pipeline**, and closes at the capability exchange a connection
  that offers none. The screen's build of the client offers it (「How it is reached」), so the server runs as
  it is installed, with no debugging switch.
- **It encodes H.264 only with an NVIDIA card, through NVENC.** Each of its daemons looks for a CUDA device
  when it starts, and one that finds none draws with its other codecs whatever the client offers. The login
  screen's daemon finds none; the daemon of the account's session usually does. Its journal names the
  client's offer at each connection, as `Client cap flags: H264 (AVC444): …, H264 (AVC420): …`.

### Redirection

A server may answer a connection by sending it somewhere else — gnome-remote-desktop hands one to the login
screen this way, and the login screen hands it on to the session. The browser's client does not follow a
redirection, so the relay does.

- **The relay reads the server's slow-path PDUs** for a server redirection packet, and passes it to nobody.
  It only reads them; every other PDU goes on as it came.
- **It keeps the routing token** the redirection carries, for the next connection the page makes, and drops
  it once that connection has taken it or half a minute has passed, whichever comes first.
- **It keeps the one-time account** the redirection names. gnome-remote-desktop gives each hop a user and a
  password of its own, and the daemon it hands the connection to knows no other, so the next connection
  runs network-level authentication with that account instead of the kept one.
  - It flags that password as encrypted for every client that is not a phone and still sends it in clear,
    so the flag is not read; a password that really was encrypted fails the next authentication as a wrong
    one.
- **It tells the page to connect again** over the pointer channel, and closes the connection it was on.
- **The page connects again at once** with the settings it last used. A connection begun before another
  cannot settle the newer one's state, so the older one's failure never shows as the newer one's.
- **The word and the end travel apart.** The redirection is told over the pointer socket and the connection
  is closed over the desktop socket, two sockets the console carries each on its own, so the page may see
  the connection end before the word arrives. That connection then fails as one the desktop did not answer,
  and the page's next try, a moment later, carries the token the relay still holds (「A desktop that does
  not answer」).

### The login screen

A connection to gnome-remote-desktop's remote login takes three hops: the system daemon redirects it to the
login screen, GDM's greeter on a display of its own, and the login screen, once the account has logged on
there, redirects it to the account's wayland session.

- **The login screen is shown as it stands and logged on at by hand**, as at the machine itself: the service
  controls the screen it is shown and never logs the account on by itself.
- **The relay authenticates each hop** as 「Credentials」 and 「Redirection」 say, with the RDP server's own
  password and the one-time accounts it names — never the account's login password.
- **What reaches the login screen is what the page sends**: the component's keys and pointer, and what the
  on-screen keyboard types (「The on-screen keyboard」).
- **Logging on there moves the page to the session**: the login screen redirects the connection, and the page
  follows it (「Redirection」).

### A desktop that does not answer

A connection the desktop does not answer is tried again by the page itself, so one press, or the desktop tab
being shown, is all it takes to reach the desktop, whatever state its daemons are in.

- **What wakes it is the next connection.** The desktop is this machine, so whenever the service answers, the
  machine is awake: no Wake-on-LAN is sent and no other unit is asked. What does not answer is the desktop's
  own side — gnome-remote-desktop's system daemon handing a connection to a login screen GDM has just
  started, a handover still in progress, a redirection whose word did not reach the page
  (「Redirection」). Each try is a connection of its own: the system daemon starts a login screen for it
  afresh, and it carries the routing token the relay still holds.
- **What is tried again:** a connection that fails before it stands for any reason but the two below — the
  relay's step standing longer than eight seconds, the desktop not accepting the connection, a failed
  negotiation or TLS handshake, the relay's socket not opening, the connection ending before it stood.
- **What is not tried again,** and shows at once: the desktop refusing the credentials (a wrong password, a
  refused logon, access denied, the relay's HTTP status 401), a request the relay cannot read (HTTP status
  400), and the screen's RDP client failing to load.
- **How often.** The first try again comes one second after the failure, and each wait after it is twice the
  one before, at most eight seconds.
- **For how long.** The window is the setting `desktop.wake_seconds`, 90 by default, counted from the first
  try; `GET /account` tells it to the page (`docs/api.md`, 「The account」). No try is begun whose wait would
  end past the window, so the failure shows once the window is spent, at most one try's length after it. A
  window of 0 tries nothing again.
- **What the page shows meanwhile:** that the desktop is being woken, with the try it is on and the seconds
  passed of the window, counted each second (`docs/screen.md`, 「The desktop tab」).
- **When the window is spent** the failure shows with the last try's reason and the reconnect action, which
  begins a new window.
- **What a window belongs to.** One connection begun, by a press, by the tab being shown, by a new size or
  quality, or by a redirection followed, begins its own window. A connection that stood and then ended is
  not tried again; it shows as ended, with the reconnect action. Disconnecting, closing the tab or another
  window taking the desktop ends the waiting.

### Connection settings

- **The resolution** is the size the connection asks for: the place's own size (`auto`) or a fixed one
  (1280×720, 1600×900, 1920×1080, 2560×1440).
  - `auto` asks for the place's size. On a phone, whose screen's shorter side is under 800 pixels, the
    place's shape is kept and scaled up until its shorter side is 800 pixels, so the desktop fills the place
    and is still a desktop to work in.
  - Every size is scaled as a whole into at least 640×480 and at most 3840×2160, keeping its shape, and
    evened.
  - With `auto`, once the place has stood at a new size for 600 ms, the connection is made again at that
    size. A resize in progress asks nothing.
  - While the on-screen keyboard is up, a change of the place only fits the picture again: a phone's
    keyboard shrinks the page, and the desktop keeps the size it had.
  - **The desktop is never resized under a connection.** The client release in use keeps drawing into a
    picture of the size it connected at when the server's desktop changes size under it, and panics on the
    first frame beyond it; the connection is then dead, taking no keys and drawing nothing. So no connection
    carries the display-control channel, and a new size is a new connection.
- **The quality** is two things: the share of the resolution the connection asks for, and the RDP
  performance flags the relay puts into the logon packet in place of the client's own, named by the desktop
  socket's `quality` query.

    | Quality | Resolution | Flags |
    |---|---|---|
    | `fast` | three quarters, evened, at least 640×480 | no wallpaper, no full-window drag, no menu animations, no themes, no cursor shadow, no cursor settings |
    | `balanced` | whole | no wallpaper, no menu animations, no cursor shadow |
    | `sharp` | whole | font smoothing and desktop composition |

  - The resolution is what makes a difference on this machine. The GNOME session ignores the flags, which
    only a Windows server reads; a smaller desktop is fewer bytes and fewer pixels to paint for the same
    change on the screen.
  - A `quality` that is none of the three leaves the client's own flags as they are.
- **The colour depth is not a choice.** gnome-remote-desktop draws through the graphics pipeline in a format
  of its own, and the colour depth the client asks for is left as it asks.
- **A changed resolution or quality reconnects at once.** The choices, with the touch mode, are kept in the
  browser.

## How the service answers its sockets

- **Each socket is a route of the service's own router,** beside the HTTP routes, and says which path is its
  own: the terminal socket, the desktop socket, and the desktop's pointer and keys sockets.
- **The desktop's three sockets are handed on.** Each takes its upgrade behind the token, opens the same path
  with the same query on the desktop sidecar, and carries frames both ways until either side closes
  (`docs/api.md`, 「The desktop sidecar」). In the sidecar each socket says which path is its own, and a
  path none claims is refused.
- **An upgrade to a path no socket claims** is refused with 404 before anything else.
- **A development instance** is the same binary on settings of its own, answering the same routes; there is
  no development server in front of it.

## The boundary

- **The console stands in front.** A browser never reaches this service. It reaches the console, which asks
  for its sign-in on every remote route, HTTP and websocket alike, and refuses a websocket upgrade whose
  `Origin` is not the host it was sent to — or the forwarded host behind the proxy — so another site cannot
  open a shell with a signed-in user's cookie. The console then hands the request on to this service, the
  upgrade included (`docs/api.md`, 「What the console does」).
- **This service answers the console alone.** It listens on a loopback address and takes every route,
  health included, with the bearer token of its settings.
- **The administrator's alone.** The console sets the signed-in reader's role on everything it hands on, and
  this service refuses every route the screen uses, sockets included, to a role that is not the
  administrator's (`docs/api.md`, 「Conventions」), whatever the console offers in its menu.
- **Nothing to aim.** No route takes a host, a port, a command or a socket name. The terminal target is the
  socket the settings name and the desktop target is the loopback RDP port.

## The terminal interface

### What it carries

- **The terminal's look and handling:** the Argonaut colours; the CaskaydiaCove Nerd Font Mono faces with the
  Noto Sans Symbols 2 subset and a fallback list; the Korean IME handling; the copy and paste handling (OSC
  52 included); the mobile extra-keys row with its key repeat and haptics; and the font-size and padding
  choices.
- **The screen's words** are its bundle's own language pack, which the console merges into its own; the words
  every screen shares are the console's.
- **The terminal's faces are fetched only on the remote screen.** They are a family of their own beside the
  console's small monospace cut, and a browser loads a face only when text asks for it.
- **The user's choices stay in the browser:** font size, padding and whether the extra keys show (without a
  choice they show on a narrow screen). The keys buzz on a phone.
- **The terminal outlives its page.** A session's terminal, its element and its socket are held apart from
  any page, so a tab switch, the whole-window view or leaving the remote screen keeps them and only moves
  the element.

### Rules the interface keeps

- **A swipe always reaches the program as wheel events.**
  - The terminal area takes the whole gesture for itself: the browser is told not to pan or zoom there, so
    it never cancels the touch as a page scroll.
  - Each step is sent to the terminal's own screen when the finger has left the terminal's area, instead of
    to whatever lies under the finger.
  - Because tmux keeps the browser's terminal on the alternate screen with mouse reporting on, the wheel then
    goes where 「What the configuration sets」 says.
- **The IME buffer never outlives a line.**
  - It is emptied on Enter; on any Ctrl or Alt chord; and on every press of the extra-keys row, whose keys
    reach the shell without passing the IME.
  - An Enter the IME reports as its own key empties it at once when nothing is composed or held, and
    otherwise as soon as that commit is through. A line break the IME inserts is sent as the terminal's own
    Enter, after the text before it.
  - It is never emptied while a composition may still be alive. The buffer is the keyboard's: a keyboard
    that has its text changed under it loses the place its composition started, and adds the syllable it
    meant to reopen beside it instead (`있긴한데` written as `있긴긴한데`).
- **A rewrite in the middle of the buffer sends nothing.** Sent bytes cannot be recalled, and a program's
  line cannot be edited from here. When the keyboard changes text with an already-sent tail still after the
  change — an autocorrection, say — the buffer is taken as the new truth and nothing is sent for it. Only
  text that grows past what was sent goes out.
- **Every reveal repaints.** Whenever a terminal becomes visible — mounted, its tab shown, its whole-window
  view entered, the document shown again, the fonts loaded — it is fitted to its area and then repainted
  whole, unconditionally. A terminal is opened only once its area has a size.
- **The shown terminal holds the keyboard.** Whenever a terminal becomes the view on screen — mounted, its
  tab shown, the whole-window view entered or left, a menu over it gone — it takes focus, so that a key
  pressed without clicking into it first still reaches the shell. A menu closing over it is told not to
  hand focus back to the button that opened it, because on that view the keyboard's home is the terminal;
  over the desktop, where no terminal is shown, the hand-back stands. A screen a finger drives is the
  exception: focus there raises the soft keyboard over a terminal somebody may only be looking at, so a
  finger asks for the keyboard by tapping the terminal, and the extra-keys row types without moving focus
  at all.
- **Escape is the shell's.** It is sent from the IME layer as one byte and stopped there, so it reaches
  neither xterm nor the page: while the terminal holds the keyboard, nothing on the screen closes or is left
  on Escape, and the whole-window view is left by its own menu item or by the back gesture instead. A Korean
  keyboard hides the key behind key code 229 and reports it as `Process`, so the physical code is read
  first. The extra-keys row's ESC sends the same byte through the same input.
- **An attach restores the terminal modes.** tmux's repaint on attach gives a new terminal the mode the
  program is in, so a click after a reload reaches a program that turned mouse reporting on before it.
