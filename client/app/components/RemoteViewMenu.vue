<template>
  <!-- What is done with the shown view and how it is shown, as one menu (docs/web.md, 「Remote screen」):
       the whole window and a window of its own first, then the view's own settings. On a touch screen
       the desktop's keyboard stands beside it as a button, since a menu would take focus from the
       desktop before the keyboard could be raised in it. -->
  <div class="flex shrink-0 items-center gap-1">
    <UTooltip v-if="props.view === 'desktop' && touch" :text="$t('remote.action.keyboard_show')">
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        square
        icon="i-material-symbols-keyboard-outline"
        :aria-label="$t('remote.action.keyboard_show')"
        :disabled="status !== 'connected'"
        @pointerdown.prevent
        @click="showKeyboard()"
      />
    </UTooltip>

    <UDropdownMenu :items="menu" :content="content">
      <UTooltip :text="$t('common.action.more')">
        <UButton color="neutral" variant="ghost" size="sm" square icon="i-material-symbols-more-vert" :aria-label="$t('common.action.more')" />
      </UTooltip>
    </UDropdownMenu>
  </div>
</template>

<script setup lang="ts">
import { DESKTOP_QUALITY_CHOICES, DESKTOP_SIZE_CHOICES, DESKTOP_TOUCH_CHOICES, useRemoteDesktop } from "../domain/remote/desktop-hub";
import {
  TERMINAL_FONT_SIZES,
  TERMINAL_PADDINGS,
  claimTerminalKeyboard,
  useTerminalExtraKeys,
  useTerminalFontSize,
  useTerminalPadding
} from "../domain/remote/terminal-hub";
import { TOUCH_QUERY } from "bmo-ui/app/domain/prompt";
import { useNarrow } from "bmo-ui/app/domain/screen";

import type { BarAction } from "bmo-ui/app/domain/tabs";
import type { DropdownMenuItem } from "@nuxt/ui";

interface Props {
  // Which kind of view is shown; its settings are the menu's lower part.
  view: "desktop" | "terminal";
  // What the screen offers to do with the view: the whole window, a window of its own.
  views?: readonly BarAction[];
}

const props = withDefaults(defineProps<Props>(), { views: () => [] });

const touch = useNarrow(TOUCH_QUERY);
const narrow = useNarrow();
const { t } = useI18n();
const { settings, setSettings, status, showKeyboard } = useRemoteDesktop();
const fontSize = useTerminalFontSize();
const padding = useTerminalPadding();
const extraKeys = useTerminalExtraKeys();

// A menu that has gone gives focus back to the button that opened it, and over a terminal that is
// the wrong place for it: the keyboard's home on that view is the terminal, and a key pressed next
// would otherwise reach the page instead of the shell. So the terminal is asked for it first, and
// only where it takes it is the return called off. Over the desktop no terminal is shown, nothing
// is taken, and the return stands.
function closeAutoFocus(event: Event): void {
  if (claimTerminalKeyboard()) event.preventDefault();
}

const content = { align: "end" as const, collisionPadding: 12, onCloseAutoFocus: closeAutoFocus };

const extraKeysShown = computed(() => extraKeys.choice.value ?? narrow.value);

onMounted(() => extraKeys.restore());

function choices<V>(list: readonly { value: V; label: string }[], current: V, pick: (value: V) => void): DropdownMenuItem[] {
  return list.map((one) => ({ label: t(one.label), type: "checkbox" as const, checked: current === one.value, onSelect: () => pick(one.value) }));
}

const desktopItems = computed<DropdownMenuItem[]>(() => [
  ...(touch.value
    ? [
        {
          label: t("remote.label.input_mode"),
          icon: settings.value.touchMode === "pointer" ? "i-material-symbols-arrow-selector-tool-outline" : "i-material-symbols-touch-app-outline",
          children: choices(DESKTOP_TOUCH_CHOICES, settings.value.touchMode, (touchMode) => setSettings({ touchMode }))
        }
      ]
    : []),
  {
    label: t("remote.label.resolution"),
    icon: "i-material-symbols-aspect-ratio-outline",
    children: choices(DESKTOP_SIZE_CHOICES, settings.value.size, (size) => setSettings({ size }))
  },
  {
    label: t("remote.label.quality"),
    icon: "i-material-symbols-high-quality-outline",
    children: choices(DESKTOP_QUALITY_CHOICES, settings.value.quality, (quality) => setSettings({ quality }))
  }
]);

const terminalItems = computed<DropdownMenuItem[]>(() => [
  {
    label: t("remote.label.extra_keys"),
    icon: "i-material-symbols-keyboard-outline",
    type: "checkbox",
    checked: extraKeysShown.value,
    onUpdateChecked: () => extraKeys.choose(!extraKeysShown.value)
  },
  {
    label: t("remote.label.font_size"),
    icon: "i-material-symbols-format-size",
    children: choices(
      TERMINAL_FONT_SIZES.map((size) => ({ value: size, label: `${size}px` })),
      fontSize.current.value,
      (size) => fontSize.select(size)
    )
  },
  {
    label: t("remote.label.padding"),
    icon: "i-material-symbols-padding",
    children: choices(
      TERMINAL_PADDINGS.map((size) => ({ value: size, label: `${size}px` })),
      padding.current.value,
      (size) => padding.select(size)
    )
  }
]);

const menu = computed<DropdownMenuItem[][]>(() => {
  const views = props.views.map((view) => ({ label: view.label, icon: view.icon, onSelect: () => view.onSelect() }));
  const own = props.view === "desktop" ? desktopItems.value : terminalItems.value;

  return views.length > 0 ? [views, own] : [own];
});
</script>
