<template>
  <!-- A terminal session's name. An empty name takes the name away. -->
  <SettingsDialog v-model:open="open" :title="$t('remote.title.rename')" :dirty="dirty">
    <UFormField :label="$t('common.label.name')" :error="error">
      <UInput v-model="name" class="w-full" autofocus :maxlength="NAME_MAX" @keydown.enter.prevent="submit()" />
    </UFormField>

    <template #footer="{ close }">
      <UButton color="neutral" variant="ghost" :label="$t('common.action.cancel')" @click="close()" />
      <UButton :label="$t('common.action.save')" :loading="saving" :disabled="saving || !dirty" @click="submit()" />
    </template>
  </SettingsDialog>
</template>

<script setup lang="ts">
import { failureText } from "../domain/remote/refusals";

import type { RemoteTerminalInfo } from "../../shared/remote";

interface Props {
  id: string;
  current: string;
}

// The longest name the server keeps.
const { t } = useI18n();
const NAME_MAX = 80;

const props = defineProps<Props>();
const emit = defineEmits<{ renamed: [terminal: RemoteTerminalInfo] }>();
const open = defineModel<boolean>("open", { default: false });

const name = ref("");
const saving = ref(false);
const error = ref<string | undefined>();
// Its Save button is on only while the name differs from the one it opened with (bmo-ui's docs/components.md, 「Forms」).
const dirty = computed(() => name.value !== props.current);

watch(open, (opened) => {
  if (!opened) return;

  name.value = props.current;
  error.value = undefined;
});

async function submit(): Promise<void> {
  if (saving.value || !dirty.value) return;

  saving.value = true;
  error.value = undefined;

  try {
    const { terminal } = await $fetch<{ terminal: RemoteTerminalInfo }>(
      `/api/remote/terminals/${encodeURIComponent(props.id)}`,
      { method: "PATCH", body: { label: name.value.trim() } }
    );

    emit("renamed", terminal);
    open.value = false;
  } catch (failure) {
    error.value = failureText(t, failure, t("remote.error.rename_failed"));
  } finally {
    saving.value = false;
  }
}
</script>
