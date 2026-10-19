"""The desktop session's focus, for the remote desktop's on-screen keyboard.

docs/remote.md, 「A text field taking focus」: an AT-SPI client on the session bus it is started on,
writing one JSON line each time whether a text field holds focus settles to a new answer. It
starts from no text field, and ends when its standard input closes, so it never outlives the
console that started it.
"""

import json
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402

# How long focus stands before its answer is written (ms), so focus passing from one field to the
# next is no change.
SETTLE_MS = 150

# Roles that take typing without saying they are editable.
TYPED_ROLES = {Atspi.Role.TERMINAL}

focused = None
editable = False
written = False
timer = 0


def is_text_field(accessible):
    try:
        if accessible.get_role() in TYPED_ROLES:
            return True

        states = accessible.get_state_set()

        return states.contains(Atspi.StateType.EDITABLE) and not states.contains(Atspi.StateType.READ_ONLY)
    except GLib.Error:
        return False


def write():
    global written, timer

    timer = 0

    if editable != written:
        written = editable
        print(json.dumps({"focus": editable}), flush=True)

    return GLib.SOURCE_REMOVE


def on_focus(event):
    global focused, editable, timer

    if event.detail1:
        focused = event.source
        editable = is_text_field(event.source)
    elif event.source is focused:
        # The object holding focus let it go with nothing taking it in the same moment.
        focused = None
        editable = False
    else:
        return

    if timer:
        GLib.source_remove(timer)

    timer = GLib.timeout_add(SETTLE_MS, write)


def on_input_closed(_source, _condition):
    loop.quit()

    return GLib.SOURCE_REMOVE


listener = Atspi.EventListener.new(on_focus)
listener.register("object:state-changed:focused")
loop = GLib.MainLoop()
GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_HUP | GLib.IO_ERR | GLib.IO_IN, on_input_closed)
loop.run()
