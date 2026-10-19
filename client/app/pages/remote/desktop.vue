<template>
  <!-- The desktop in a window of its own: the whole window, under one row with its name and menu. -->
  <ScreenFrame class="dark bg-black">
    <RemoteWindowBar :label="$t('remote.title.desktop')" view="desktop" />
    <RemoteDesktop class="min-h-0 flex-1" />
  </ScreenFrame>
</template>

<script setup lang="ts">
const { t } = useI18n();
definePageMeta({ layout: false });

useHead({ title: t("remote.title.remote_desktop") });
</script>
