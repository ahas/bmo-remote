<template>
  <!-- The place a remote terminal is drawn (docs/remote.md). The terminal and its connection belong
       to the hub; this only lends them a place, and gives it back when it goes. -->
  <div ref="hostRef" class="remote-terminal" @wheel.stop />
</template>

<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";

import { claimTerminalKeyboard, showingTerminal, useRemoteTerminal } from "../domain/remote/terminal-hub";

import type { RemoteTerminalSession } from "../domain/remote/terminal-hub";

interface Props {
  id: string;
  // Whether the panel holding this terminal is the one shown. A panel shown again is repainted.
  active?: boolean;
}

const props = withDefaults(defineProps<Props>(), { active: true });

const hostRef = useTemplateRef<HTMLElement>("hostRef");
const session = shallowRef<RemoteTerminalSession | null>(null);
const baseURL = useRuntimeConfig().app.baseURL;
const { t } = useI18n();

// The terminal is a thing of the browser; the server draws only the empty place. The place is
// claimed before the terminal is made, so a terminal that opens here opens as the shown one.
onMounted(() => {
  showingTerminal(props.id, props.active);
  session.value = useRemoteTerminal(props.id, { baseURL, t });
  session.value.mount(hostRef.value!);
});

onBeforeUnmount(() => {
  showingTerminal(props.id, false);
  session.value?.unmount();
});

watch(
  () => props.active,
  (active) => {
    showingTerminal(props.id, active);

    if (!active) return;

    void nextTick(() => {
      session.value?.reveal();
      claimTerminalKeyboard(props.id);
    });
  }
);

defineExpose({ session });
</script>

<style scoped>
/* A flex child whose height the parent decides. The terminal stands absolutely inside it, so fitting
   the terminal can never grow the place it is measured in. */
.remote-terminal {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background: #000;
}

/* The host element is made by the hub and carries no scoped attribute. */
.remote-terminal :deep(.terminal-host) {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #000;
}

/* The padding goes on xterm's own element, which xterm subtracts when it counts rows and columns; the
   scrollbar keeps to the edge. The value is the owner's choice, carried on the host. */
.remote-terminal :deep(.xterm) {
  height: 100%;
  padding: var(--terminal-padding, 8px);
}
</style>
