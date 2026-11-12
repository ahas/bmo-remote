<template>
  <!-- One terminal in a window of its own: the whole window, under one row with the session's name and
       its menu. -->
  <ScreenFrame class="dark bg-black">
    <RemoteWindowBar v-if="valid" :label="label" view="terminal" />
    <RemoteTerminalPanel v-if="valid" :key="id" :id="id" class="min-h-0 flex-1" @ended="endedHere = true" />

    <div v-if="!valid || endedHere" class="flex flex-1 flex-col items-center justify-center gap-4 p-4 text-sm text-white/70">
      <p>{{ endedHere ? $t("remote.status.session_over") : $t("remote.error.no-terminal-session") }}</p>
    </div>
  </ScreenFrame>
</template>

<script setup lang="ts">
import { isRemoteTab, isTerminalTab } from "../../../domain/remote/sessions";
import { remoteCall } from "../../../domain/remote/service";
import { sessionName } from "../../../domain/remote/terminal-hub";

import type { components } from "../../../../shared/openapi";
import type { RemoteTerminalInfo } from "../../../../shared/remote";

type Wire = components["schemas"];

const { t } = useI18n();
definePageMeta({ layout: false });

const route = useRoute();
const id = computed(() => String(route.params.id ?? ""));
const valid = computed(() => isRemoteTab(id.value) && isTerminalTab(id.value));
const session = ref<RemoteTerminalInfo | null>(null);
const endedHere = ref(false);
const label = computed(() => (session.value ? sessionName(session.value) : id.value));

useHead({ title: () => t("remote.title.terminal_page", { name: label.value }) });

async function load(): Promise<void> {
  try {
    session.value = await remoteCall<Wire["Terminal"]>(`/terminals/${encodeURIComponent(id.value)}`);
  } catch {
    session.value = null;
  }
}

watch(id, () => {
  endedHere.value = false;
  void load();
});
onMounted(() => void load());
</script>
