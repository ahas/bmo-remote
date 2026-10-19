<template>
  <!-- Asks for the desktop's password. The user is this machine's account; the password is kept for this
       visit only and never written anywhere. -->
  <form class="mx-auto flex w-full max-w-sm flex-col gap-4 p-4" autocomplete="off" @submit.prevent="emit('connect')">
    <div class="flex items-center gap-2 text-lg font-semibold">
      <UIcon name="i-material-symbols-desktop-windows-outline" class="size-6" />
      <span>{{ $t("remote.title.desktop") }}</span>
    </div>

    <UFormField :label="$t('remote.label.user')">
      <UInput :model-value="props.username" class="w-full" disabled />
    </UFormField>

    <UFormField :label="$t('remote.label.password')">
      <UInput
        v-model="password"
        class="w-full"
        type="password"
        autocomplete="off"
        name="remote-desktop-password"
        :disabled="props.busy"
      />
    </UFormField>

    <UAlert
      v-if="props.error"
      color="error"
      variant="subtle"
      icon="i-material-symbols-error-outline"
      :description="props.error"
    />

    <div class="flex justify-end">
      <UButton
        type="submit"
        icon="i-material-symbols-login"
        :label="props.ended ? $t('remote.action.reconnect') : $t('remote.action.connect')"
        :loading="props.busy"
        :disabled="props.busy || !props.username"
      />
    </div>
  </form>
</template>

<script setup lang="ts">
interface Props {
  username: string;
  busy: boolean;
  error: string | null;
  // A connection was open before and has ended.
  ended?: boolean;
}

const props = withDefaults(defineProps<Props>(), { ended: false });
const emit = defineEmits<{ connect: [] }>();
const password = defineModel<string>("password", { default: "" });
</script>
