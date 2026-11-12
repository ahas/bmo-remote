<template>
  <!-- The desktop's place (docs/remote.md, 「One desktop」). The connection belongs to the hub; this
       lends it a place, connects at once where the console keeps the password and asks for it
       otherwise. -->
  <div class="dark flex min-h-0 flex-col bg-black text-white">
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <div ref="hostRef" class="remote-desktop absolute inset-0" />

      <!-- What the connection is doing is laid over the desktop's top edge, so the place keeps its
           size whatever the connection is doing (docs/remote.md, 「One desktop」). -->
      <div
        v-if="lastError && keptPassword"
        role="alert"
        class="absolute inset-x-0 top-0 z-10 flex h-10 items-center gap-2 border-b border-white/10 bg-black/85 px-3 text-sm text-error"
      >
        <UIcon name="i-material-symbols-error-outline" class="size-4 shrink-0" />
        <span class="min-w-0 flex-1 truncate">{{ lastError }}</span>
        <UButton color="error" variant="ghost" size="sm" icon="i-material-symbols-refresh" :label="$t('remote.action.reconnect')" @click="connect()" />
      </div>
      <div
        v-else-if="notice"
        role="status"
        class="absolute inset-x-0 top-0 z-10 flex h-10 items-center gap-2 border-b border-white/10 bg-black/85 px-3 text-sm text-white/70"
      >
        <UIcon :name="notice.icon" class="size-4 shrink-0" />
        <span class="min-w-0 flex-1 truncate">{{ notice.text }}</span>
        <UButton v-if="notice.retry" color="neutral" variant="ghost" size="sm" icon="i-material-symbols-refresh" :label="notice.retry" @click="connect()" />
      </div>

      <div v-if="asking" class="absolute inset-0 flex items-center justify-center overflow-y-auto bg-default text-default">
        <RemoteDesktopLogin
          v-model:password="password"
          :username="username"
          :busy="busy"
          :error="lastError"
          :progress="wakingText"
          :ended="status === 'ended' || status === 'away'"
          @connect="connect()"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { holdHistoryButtons, attachDesktopTouch, createDesktopView } from "../domain/remote/desktop-input";
import { useRemoteDesktop } from "../domain/remote/desktop-hub";
import { remoteCall } from "../domain/remote/service";

import type { components } from "../../shared/openapi";
import type { DesktopView } from "../domain/remote/desktop-input";

type Wire = components["schemas"];

interface Props {
  // Whether the panel holding the desktop is the one shown.
  active?: boolean;
}

const props = withDefaults(defineProps<Props>(), { active: true });

const { t } = useI18n();
const desktop = useRemoteDesktop();
const { status, lastError, waking, password, settings, keyboardOpen } = desktop;
const hostRef = useTemplateRef<HTMLElement>("hostRef");
const username = ref("");
const keptPassword = ref(false);
const accountRead = ref(false);

const connected = computed(() => status.value === "connected");
const busy = computed(() => status.value === "loading" || status.value === "connecting" || status.value === "waking");

// What the line says while a desktop that does not answer is tried again (docs/remote.md, 「A desktop that does
// not answer」).
const wakingText = computed(() => (status.value === "waking" && waking.value ? t("remote.status.waking", { ...waking.value }) : null));

// The password is asked for only where the console does not keep one, once it is known which.
const asking = computed(() => accountRead.value && !keptPassword.value && !connected.value);

const notice = computed<{ text: string; icon: string; retry?: string } | null>(() => {
  if (!keptPassword.value && status.value !== "away") return null;

  switch (status.value) {
    case "loading":
    case "connecting":
      return { text: t("remote.status.connecting"), icon: "i-material-symbols-progress-activity" };
    case "waking":
      return { text: wakingText.value ?? t("remote.status.connecting"), icon: "i-material-symbols-progress-activity" };
    case "ended":
      return { text: t("remote.status.connection_ended"), icon: "i-material-symbols-stop-circle-outline", retry: t("remote.action.reconnect") };
    case "away":
      return { text: t("remote.status.open_elsewhere"), icon: "i-material-symbols-open-in-new", retry: t("remote.action.open_here") };
    case "idle":
      return { text: t("remote.status.not_connected"), icon: "i-material-symbols-link-off", retry: t("remote.action.connect") };
    default:
      return null;
  }
});

// The desktop moved and magnified while the phone's keyboard is laid over it.
let view: DesktopView | null = null;
let detachTouch: (() => void) | null = null;
let detachButtons: (() => void) | null = null;
let observer: ResizeObserver | null = null;

async function connect(): Promise<void> {
  if (!username.value) return;

  await desktop.connect({ t, username: username.value, keptPassword: keptPassword.value });
}

onMounted(async () => {
  const host = hostRef.value!;

  desktop.mount(host);
  view = createDesktopView(host);
  view.keyboard(keyboardOpen.value);
  detachTouch = attachDesktopTouch(host, desktop.canvas, () => settings.value.touchMode, view);
  detachButtons = holdHistoryButtons(host);
  observer = new ResizeObserver(() => {
    if (host.clientWidth > 0 && host.clientHeight > 0) desktop.placeResized(host.clientWidth, host.clientHeight);
  });
  observer.observe(host);

  try {
    const account = await remoteCall<Wire["Account"]>("/account");

    username.value = account.name;
    keptPassword.value = account.keptPassword;
  } catch {
    // The login form stays disabled without a user; the route answers only a signed-in console.
  }

  accountRead.value = true;

  // A desktop the relay authenticates for connects as soon as it is shown.
  if (keptPassword.value && props.active && status.value === "idle") void connect();
});

onBeforeUnmount(() => {
  detachTouch?.();
  view?.detach();
  detachButtons?.();
  observer?.disconnect();

  if (hostRef.value) desktop.unmount(hostRef.value);
});

watch(keyboardOpen, (up) => view?.keyboard(up));

watch(
  () => props.active,
  (active) => {
    if (!active) return;

    void nextTick(() => desktop.reveal());

    if (keptPassword.value && status.value === "idle") void connect();
  }
);
</script>

<style scoped>
/* The component fits its picture into the place and centres it. */
.remote-desktop :deep(iron-remote-desktop) {
  display: flex;
  width: 100%;
  height: 100%;
}
</style>
