<template>
  <!-- The keys a phone keyboard lacks, as trainer's terminal lays them out: two rows sharing the width.
       The last row of the terminal's column, so the terminal keeps the rest. -->
  <div class="extra-keys flex shrink-0 flex-col gap-1 border-t border-white/10 bg-[#212121] p-1" role="group" :aria-label="$t('remote.label.extra_keys')">
    <div v-for="(row, index) in KEY_ROWS" :key="index" class="flex gap-1">
      <button
        v-for="key in row"
        :key="key.name"
        class="key"
        type="button"
        :class="{ armed: isArmed(key) }"
        :aria-label="key.label === undefined ? key.name : $t(key.label)"
        :aria-pressed="key.modifier ? isArmed(key) : undefined"
        @contextmenu.prevent
        @pointerdown="onPointerDown(key, $event)"
        @pointerup="stopRepeat()"
        @pointercancel="stopRepeat()"
        @click="onClick(key)"
      >
        <UIcon v-if="key.icon" :name="key.icon" class="size-4" />
        <span v-else>{{ key.caption }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTerminalHaptics } from "../domain/remote/terminal-hub";

import type { TerminalModifier } from "../domain/remote/terminal-hub";

interface ExtraKeyBase {
  // The key's own name, which is what identifies it and what a reader hears unless it has words.
  name: string;
  // The pack key of the words a reader hears, for a key drawn as a mark rather than its name.
  label?: string;
  caption?: string;
  icon?: string;
}

// A key that sends bytes.
interface DataKey extends ExtraKeyBase {
  data: string;
  modifier?: never;
}

// A key that sends nothing and changes the next key's bytes.
interface ModifierKey extends ExtraKeyBase {
  modifier: TerminalModifier;
  data?: never;
}

type ExtraKey = DataKey | ModifierKey;

interface Props {
  armedModifiers: readonly TerminalModifier[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  press: [data: string];
  modifier: [modifier: TerminalModifier];
}>();

// Holding a key repeats it after this long, this often — about a physical keyboard's pace.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 55;

const KEY_ROWS: ExtraKey[][] = [
  [
    { name: "ESC", caption: "ESC", data: "\x1b" },
    { name: "SHIFT", caption: "SHIFT", modifier: "shift" },
    { name: "CTRL", caption: "CTRL", modifier: "ctrl" },
    { name: "ALT", caption: "ALT", modifier: "alt" },
    { name: "UP", label: "remote.aria.key_up", icon: "i-material-symbols-arrow-upward", data: "\x1b[A" },
    { name: "/", caption: "/", data: "/" },
    { name: "HOME", caption: "HOME", data: "\x1b[H" },
    { name: "PAGE UP", caption: "PGUP", data: "\x1b[5~" },
    { name: "INSERT", caption: "INS", data: "\x1b[2~" },
    { name: "BACKSPACE", label: "remote.aria.key_backspace", icon: "i-material-symbols-backspace-outline", data: "\x7f" }
  ],
  [
    { name: "TAB", caption: "TAB", data: "\t" },
    { name: "META", caption: "META", modifier: "meta" },
    { name: "-", caption: "-", data: "-" },
    { name: "LEFT", label: "remote.aria.key_left", icon: "i-material-symbols-arrow-back", data: "\x1b[D" },
    { name: "DOWN", label: "remote.aria.key_down", icon: "i-material-symbols-arrow-downward", data: "\x1b[B" },
    { name: "RIGHT", label: "remote.aria.key_right", icon: "i-material-symbols-arrow-forward", data: "\x1b[C" },
    { name: "END", caption: "END", data: "\x1b[F" },
    { name: "PAGE DOWN", caption: "PGDN", data: "\x1b[6~" },
    { name: "DELETE", caption: "DEL", data: "\x1b[3~" },
    { name: "ENTER", label: "remote.aria.key_enter", icon: "i-material-symbols-keyboard-return", data: "\r" }
  ]
];

const haptics = useTerminalHaptics();

function isArmed(key: ExtraKey): boolean {
  return key.modifier !== undefined && props.armedModifiers.includes(key.modifier);
}

function press(key: ExtraKey): void {
  if (key.modifier !== undefined) {
    emit("modifier", key.modifier);
    return;
  }

  emit("press", key.data);
}

let repeatTimer: ReturnType<typeof setTimeout> | undefined;
// A press by pointer has already been sent; the click that follows it is its echo.
let pressedByPointer = false;

function stopRepeat(): void {
  clearTimeout(repeatTimer);
  repeatTimer = undefined;
}

// Holding repeats, as a physical key does. A modifier does not repeat: it waits for one key.
function startRepeat(key: ExtraKey): void {
  if (key.modifier !== undefined) return;

  repeatTimer = setTimeout(() => {
    haptics.tap("hold");

    (function tick() {
      press(key);
      repeatTimer = setTimeout(tick, REPEAT_INTERVAL_MS);
    })();
  }, REPEAT_DELAY_MS);
}

function onPointerDown(key: ExtraKey, event: PointerEvent): void {
  // The terminal's input keeps focus; losing it would raise the phone's keyboard again on return.
  event.preventDefault();
  // The button keeps the pointer even when the finger slides off, so the repeat always hears its end.
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);

  pressedByPointer = true;
  haptics.tap("press");
  press(key);
  startRepeat(key);
}

// Only a key pressed from the keyboard (Enter, Space) is sent here.
function onClick(key: ExtraKey): void {
  if (pressedByPointer) {
    pressedByPointer = false;
    return;
  }

  press(key);
}

onBeforeUnmount(stopRepeat);
</script>

<style scoped>
/* The keys share the row's width; on a phone the share is also the height. */
.key {
  display: inline-flex;
  flex: 1 1 0;
  min-width: 0;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  max-height: 56px;
  border-radius: 4px;
  background: rgb(255 255 255 / 0.1);
  color: rgb(255 255 255 / 0.85);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  user-select: none;
  /* A long press is a repeat, announced by us; the device's own long-press buzz would double it. */
  -webkit-touch-callout: none;
  /* A touch the browser weighs as the start of a pan or zoom arrives uncancellable, and the
     preventDefault that keeps focus then does nothing; this takes that weighing away. */
  touch-action: manipulation;
}

.key:hover {
  background: rgb(255 255 255 / 0.18);
}

.key:active {
  background: rgb(255 255 255 / 0.25);
}

/* An armed modifier stands pressed until the next key. */
.key.armed {
  background: #fff;
  color: #000;
}
</style>
