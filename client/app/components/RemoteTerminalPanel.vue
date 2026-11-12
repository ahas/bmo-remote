<template>
  <!-- One terminal: what the connection is doing, the terminal, and on a phone the
       extra keys. The remote screen's tab and a window of its own both stand on it. The terminal is
       dark in either screen mode, so its controls take the dark colours too. -->
  <div class="dark flex min-h-0 flex-col bg-black text-white">
    <div v-if="lastError" role="alert" class="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-sm text-error">
      <UIcon name="i-material-symbols-error-outline" class="size-4 shrink-0" />
      <span class="min-w-0 flex-1 truncate">{{ lastError }}</span>
      <UButton color="error" variant="ghost" size="sm" icon="i-material-symbols-refresh" :label="$t('remote.action.reconnect')" @click="reconnect()" />
    </div>
    <div v-else-if="statusLabel" role="status" class="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-sm text-white/70">
      <UIcon
        :name="status === 'closed' ? 'i-material-symbols-stop-circle-outline' : 'i-material-symbols-progress-activity'"
        class="size-4 shrink-0"
      />
      <span class="min-w-0 truncate">{{ statusLabel }}</span>
    </div>

    <RemoteTerminal ref="terminal" :id="props.id" :active="props.active" class="flex-1" />

    <RemoteExtraKeys v-if="showExtraKeys" :armed-modifiers="armedModifiers" @press="sendKey" @modifier="armModifier" />
  </div>
</template>

<script setup lang="ts">
import { useTerminalExtraKeys } from "../domain/remote/terminal-hub";
import { useNarrow } from "bmo-ui/app/domain/screen";

import type { RemoteTerminalSession, TerminalModifier } from "../domain/remote/terminal-hub";

interface Props {
  id: string;
  active?: boolean;
}

const { t } = useI18n();
const props = withDefaults(defineProps<Props>(), { active: true });
const emit = defineEmits<{ ended: [] }>();

const terminal = useTemplateRef<{ session: RemoteTerminalSession | null }>("terminal");
// A component instance unwraps the refs it exposes.
const session = computed(() => terminal.value?.session ?? null);
const status = computed(() => session.value?.status.value ?? "idle");
const lastError = computed(() => session.value?.lastError.value ?? null);
const armedModifiers = computed<readonly TerminalModifier[]>(() => session.value?.armedModifiers.value ?? []);

// A session that ends while it is watched goes with its tab.
watch(status, (now) => {
  if (now === "closed") emit("ended");
});

const statusLabel = computed(() => {
  switch (status.value) {
    case "opening":
      return t("remote.status.connecting");
    case "idle":
      return t("remote.status.reconnecting");
    case "closed":
      return t("remote.status.session_ended");
    default:
      return "";
  }
});

// The owner's choice of the extra keys, made in the view's menu; no choice follows the screen's width.
const narrow = useNarrow();
const extraKeys = useTerminalExtraKeys();
const showExtraKeys = computed(() => extraKeys.choice.value ?? narrow.value);

onMounted(() => extraKeys.restore());

// Focus is left where it is: the keys keep it from moving, and moving it back would raise the phone's
// keyboard over the keys the owner is using.
function sendKey(data: string): void {
  session.value?.resetInput();
  session.value?.input(data);
}

function armModifier(modifier: TerminalModifier): void {
  session.value?.resetInput();
  session.value?.toggleModifier(modifier);
}

function reconnect(): void {
  session.value?.reconnect();
}

// A phone keyboard going down leaves focus in the terminal, and the next press anywhere raises it
// again over the extra keys. Focus is let go when the keyboard goes.
let stopWatchingKeyboard: (() => void) | null = null;

function watchSoftKeyboard(): () => void {
  if (navigator.maxTouchPoints === 0) return () => {};

  let tallest = window.innerHeight;
  let wasOpen = false;

  const onResize = (): void => {
    tallest = Math.max(tallest, window.innerHeight);

    // Generous, to tell the keyboard from the address bar folding.
    const isOpen = tallest - window.innerHeight > 150;

    if (wasOpen && !isOpen && props.active) session.value?.blur();

    wasOpen = isOpen;
  };

  window.visualViewport?.addEventListener("resize", onResize);
  window.addEventListener("resize", onResize);

  return () => {
    window.visualViewport?.removeEventListener("resize", onResize);
    window.removeEventListener("resize", onResize);
  };
}

onMounted(() => {
  stopWatchingKeyboard = watchSoftKeyboard();
});

onBeforeUnmount(() => {
  stopWatchingKeyboard?.();
});
</script>
