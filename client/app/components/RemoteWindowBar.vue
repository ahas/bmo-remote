<template>
  <!-- The one row over a view that stands without the remote screen's tab bar — a window of its own,
       or the whole-window view: the session's name, and the view's menu at the right end with the
       same edge the tab bar's actions keep (docs/web.md, 「Remote screen」). -->
  <header class="dark flex h-9 shrink-0 items-center gap-2 border-b border-white/10 bg-[#212121] ps-3 pe-1 text-sm text-white/70 pointer-coarse:h-10">
    <UIcon :name="props.view === 'desktop' ? 'i-material-symbols-desktop-windows-outline' : 'i-material-symbols-terminal'" class="size-4 shrink-0" />
    <span class="min-w-0 flex-1 truncate">{{ props.label }}</span>
    <RemoteViewMenu :view="props.view" :views="props.views" />
  </header>
</template>

<script setup lang="ts">
import type { BarAction } from "bmo-ui/app/domain/tabs";

interface Props {
  label: string;
  view: "desktop" | "terminal";
  views?: readonly BarAction[];
}

const props = withDefaults(defineProps<Props>(), { views: () => [] });
</script>
