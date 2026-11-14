# The remote screen

The console's remote screen, as the plugin bundle in `client/` draws it under `/remote`. What holds the
sessions, the wire and the access boundary are `docs/remote.md`; how the bundle is built and served is
`docs/api.md`, 「The console plugin bundle」. This document is the screen. Its words are the bundle's own
language pack, named here by key where a label matters.

## The title bar

- **Under the console's title bar.** The screen's route asks for the console's bar in its meta, so a console that
  offers its bar (bmo-ui's `docs/console-bundles.md`, 「How a bundle mounts」, the title bar) draws it over the screen
  under the manifest's title and icon, and the screen draws no bar of its own. Found without that offer it draws
  its own bar, named and marked the same and holding nothing else. A session's own window stands under no bar
  either way (「A page with no sidebar and no title bar」).

## Tabs

- **Two ways into the machine:** terminal sessions and the desktop, side by side as tabs on one screen.
- **The tab bar is bmo-ui's tab bar, and every running terminal session stands on it.**
  - A tab is a terminal session, named by its title or, without one, its id; or the one desktop, named by
    `remote.title.desktop`. There is never more than one desktop tab.
  - The screen reads the session list when it stands and whenever the page is looked at again: a running
    session without a tab gets one at the end, in the order the sessions began, and a terminal tab whose
    session has ended is dropped. There is no list of sessions apart from the tabs.
  - **The list is read again on the events that say the service is reached.** A terminal's connection
    answering `ready` after a read of the list failed reads it again, and so does a terminal's connection
    closed because the service holds no such session. A login the console renews brings the screen up again,
    which reads the list as it stands. Nothing reads the list on a clock.
  - A read that fails says what failed in one line over the tabs: the service's refusal in the pack's words
    for its code, the answer's status where the refusal names no code, or that the service was not reached
    at all. The next read that succeeds clears the line.
  - Which tabs are open, in what order, which are pinned and which stands is kept in the browser
    (`docs/api.md`, 「The console plugin bundle」). A kept value that cannot be read is dropped.
  - The shown tab stands in the address as `?tab=`, so a link opens that session's tab.
  - **Closing a terminal tab ends its session**, and closing the desktop tab ends the desktop connection
    (the desktop session itself stays on the machine). Either is asked once more before it is done, as
    bmo-ui's question asks before an action: the question names the session or the desktop, what ending a
    session also ends or that the desktop session stays stands under it, and the way through is
    `remote.action.end` or `remote.action.disconnect`. A close that fails says so in the line over the tabs,
    `remote.error.end_failed` or the service's refusal, and the tab stays. Switching tabs or leaving the
    screen ends nothing.
  - The tab's own menu renames a terminal session, beside the closings and the pin.
  - The right end of the tab bar holds a new terminal and open the desktop as two icon buttons, on a phone
    too, and beside them, one gap apart like the rest of the group, the shown view's menu (「The view's
    menu」).
  - **A new terminal is a tab of this bar, so it stands in the bar on every width** and never floats as a
    screen's create button: a phone keeps it beside the tabs it adds to, as a wide screen does.
  - With no tab open, the screen says so in one line, with a new terminal and the desktop to open.
- **A tab switch never ends a session.** Every open tab's panel stays mounted and is only hidden, so a
  program keeps running and printing while its tab is not shown, and the desktop connection stays up. A
  panel shown again is fitted and repainted at once. Leaving the screen keeps every terminal and the desktop
  connection too, and coming back shows them as they were.

## The view's menu

- **No toolbar stands under the tab bar:** the view fills everything below it. One vertical-dots menu
  (`remote.label.menu`), at the tab bar's right end, holds what is done with the shown view and how it is
  shown.
- Its first group is the whole-window view (`remote.action.fullscreen`), while the view stands in the page, and
  a window of its own (`remote.action.open_window`); under them, the shown view's own settings — a terminal's,
  or the desktop's connection settings.
- On a touch screen a keyboard button (raising the phone's keyboard) stands beside the menu as an icon
  button over a terminal and over the desktop alike, since a menu would take focus from the view before the
  keyboard could be raised in it.
- **The whole-window view** takes the shown view over the whole window, inside the page, under one dark row:
  at its left end the way back out of it, an icon button named `remote.action.exit_fullscreen` in its
  tooltip, then the session's name, and the same menu at its right end. The way back never gathers into the
  menu. The view never asks the browser for full screen, and nothing is reconnected.
- **A window of its own** opens the shown session in a browser window of its own, which attaches to the same
  session. The desktop follows the window that connected last; the window it left says so in a thin line
  with `remote.action.open_here`.
- That dark row keeps the same edges as the tab bar's actions, 4 pixels, wherever a button stands at its end;
  where its row opens on the session's mark, the mark stands 12 pixels in.
- **Every button in these rows is the component library's small button at its own size**, centred in its
  row: the tab bar's actions, the view's menu, the keyboard and the way back are its small square icon
  buttons, each with a tooltip. Hovered or pressed, a button colours only its own rounded shape, never its
  row.

## A terminal tab

- **The terminal, and on a phone the extra-keys row** above the keyboard (`docs/remote.md`, 「The terminal
  interface」). At a phone's width ten keys share a row, each key on the medium corner tier of 6 pixels with
  its legend at 12 pixels, set on the key itself, since bmo-ui draws its own step below 14 pixels at 14: the
  owner's size for this row, under the console's 14-pixel floor. A key drawn as a mark rather than a word — the arrows, Enter, Backspace and
  Shift — carries its Material Symbols mark, and every key carries a name a reader hears.
- Its settings in the view's menu are the extra-keys row (`remote.label.extra_keys`) as a check, and the font
  size (`remote.label.font_size`) and the padding (`remote.label.padding`) as submenus. The extra-keys choice
  is one for the browser, shared by every terminal; with none made, the row follows the screen's width.
- The shown terminal holds the keyboard: it takes focus as soon as it is the view on screen, so a key pressed
  without clicking into it first reaches the shell, and Escape reaches the shell rather than closing
  anything on the screen. On a touch screen it takes no focus, which would raise the keyboard over a
  terminal being looked at (`docs/remote.md`, 「Rules the interface keeps」).
- On a touch screen the keyboard button beside the view's menu raises the phone's keyboard into the shown
  terminal, as a tap on the terminal does. It holds no on or off state; the keyboard goes down by the phone's
  own key, and the terminal then lets go of focus so the next press anywhere does not raise it again.
- The terminal keeps its black Argonaut colours and its fonts in both screen modes.
- What the connection is doing stands over the terminal in one thin line with a bottom border, the mark
  turning while it connects; a lost connection is retried by itself, and a failure offers
  `remote.action.reconnect`. The line's button is the component library's small button at its own size,
  and the line is as tall as leaves it room above and below, 40 pixels.
- A session that ends by itself leaves the bar with its tab.

## The desktop tab

- **It connects as soon as it is shown** where the service keeps the desktop password, and otherwise asks for
  that password first. It opens on whatever the desktop shows — the login screen where no session is
  running, logged on at by hand (`docs/remote.md`, 「The login screen」).
- The desktop is drawn scaled to the panel, with no border and no focus ring of its own. What the connection
  is doing stands in a line like a terminal's, of the same height and with the same small button, laid over
  the top of the desktop so the panel keeps its size, with `remote.action.reconnect` where it has ended.
- **A desktop that does not answer is never a second press.** While the screen tries it again by itself,
  the line says the desktop is being woken (`remote.status.waking`), with the try it is on and the seconds
  passed since the first, counted each second, until the desktop answers or refuses (`docs/remote.md`,
  「A desktop that does not answer」); a refusal shows its reason and `remote.action.reconnect`. Where the
  password is typed, the login form shows the same sentence above its busy button while it waits.
- **Its settings in the view's menu** are, on a touch screen, the touch mode — `touch`, where a finger presses
  where it touches, or `pointer`, where it moves a pointer as on a touchpad (`docs/remote.md`, 「One
  desktop」) — and on every screen the resolution (`auto` or a fixed size) and the quality (`fast`,
  `balanced`, `sharp`; `fast` asks for three quarters of the resolution and stretches it, `docs/remote.md`,
  「Connection settings」), each a submenu. A changed resolution or quality reconnects at once; the choices
  are kept in the browser.
- On a touch screen a keyboard button stands beside the view's menu. It raises the phone's keyboard and
  holds no on or off state; the keyboard goes down by the phone's own key and stays down until the button is
  pressed again or a text field on the desktop takes focus (`docs/remote.md`, 「The on-screen keyboard」,
  「A text field taking focus」).
- The mouse crossing the desktop on its way into something floating over it leaves focus where it is
  (`docs/remote.md`, 「One desktop」), so a menu or popover over the desktop stays open under the mouse.
- Over the desktop the mouse pointer takes the desktop's own shape — an arrow, a text bar, a resize handle —
  as the remote programs set it (`docs/remote.md`, 「The pointer」).
- With `auto`, the desktop takes the panel's size, and once the panel has stood at a new size for a moment the
  desktop connects again at that size; a resize in progress asks nothing, and neither does the phone's
  keyboard coming up. On a phone the desktop takes the panel's shape, scaled up to a desktop's size, so it
  fills the panel (`docs/remote.md`, 「Connection settings」).
- What the phone's keyboard types — Hangul, symbols, Enter and Backspace included — is typed on the desktop as
  it is composed (`docs/remote.md`, 「The on-screen keyboard」).
- The mouse's back and forward buttons over the desktop are the desktop's; the page does not go back.

## Each session's own window

- **A page with no sidebar and no title bar:** a terminal at `/remote/terminal/<id>`, the desktop at
  `/remote/desktop`, each standing on bmo-ui's `ScreenFrame`.
- It fills the window with the view under the dark row the whole-window view has, the session's name at its
  left end and the view's settings in its menu. Nothing stands behind the window to go back to, so the row
  holds no way back.
- A terminal whose session has ended says so there.
