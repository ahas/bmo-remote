<template>
  <!-- This machine's terminals and desktop as tabs (docs/screen.md). Every running terminal
       session stands as a tab, and every open tab stays mounted, so switching never ends or
       reconnects a session. Closing a terminal tab ends its session, once confirmed. -->
  <UDashboardPanel id="remote" :ui="{ body: 'p-0 sm:p-0 gap-0 sm:gap-0 overflow-y-hidden [&>*]:max-w-none' }">
    <template #header>
      <UDashboardNavbar :title="$t('screens.label.remote')" icon="i-material-symbols-devices-outline">
        <template #right>
          <DeployMark />
          <TodoOpenButton />
          <UsageMeters />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex min-h-0 flex-1 flex-col">
        <TabBar
          v-if="state.tabs.length > 0"
          :label="$t('remote.label.open_sessions')"
          :tabs="barTabs"
          :active="state.active"
          :actions="actions"
          :actions-narrow-fold="false"
          :menu="tabMenu"
          @update:active="show"
          @close="askClose"
          @move="(from: number, to: number) => update(moveTabs(state, from, to))"
          @pin="(id: string, on: boolean) => update(pinRemoteTab(state, id, on))"
        >
          <template #actions>
            <RemoteViewMenu v-if="shownView !== null && !fullView" :view="shownView" :views="views" />
          </template>
        </TabBar>
        <div v-else class="flex h-9 shrink-0 items-center justify-end border-b border-default px-1 pointer-coarse:h-10">
          <ActionGroup :actions="actions" :label="$t('remote.label.menu')" :narrow-fold="false" />
        </div>

        <p v-if="failure" role="alert" class="shrink-0 border-b border-default px-4 py-2 text-sm text-error">{{ failure }}</p>

        <div v-if="state.tabs.length === 0" class="flex flex-1 flex-col items-center justify-center gap-4 p-4 text-muted">
          <p class="text-sm">{{ $t("remote.status.no_sessions") }}</p>
          <div class="flex flex-wrap justify-center gap-2">
            <UButton icon="i-material-symbols-terminal" :label="$t('remote.action.new_terminal')" :loading="creating" @click="createTerminal()" />
            <UButton color="neutral" variant="outline" icon="i-material-symbols-desktop-windows-outline" :label="$t('remote.title.desktop')" @click="update(openTab(state, DESKTOP_TAB))" />
          </div>
        </div>

        <!-- The view taken to the whole window stands over the page, in the same place in the
             document, so nothing it holds is moved or reconnected; the tab bar stays behind, and a row
             of the view's own name and menu stands over it instead. -->
        <div v-else class="flex min-h-0 flex-1 flex-col" :class="fullView ? 'fixed inset-0 z-50 bg-black' : ''">
          <RemoteWindowBar v-if="fullView && shownView !== null" :label="labelOf(state.active!)" :view="shownView" :views="views" />
          <template v-for="id in state.tabs" :key="id">
            <RemoteDesktop v-if="id === DESKTOP_TAB" v-show="state.active === id" :active="state.active === id" class="min-h-0 flex-1" />
            <RemoteTerminalPanel v-else v-show="state.active === id" :id="id" :active="state.active === id" class="min-h-0 flex-1" @ended="ended(id)" />
          </template>
        </div>
      </div>

      <RemoteRenameModal v-if="renaming !== null" v-model:open="renameOpen" :id="renaming" :current="sessions.get(renaming)?.label ?? ''" @renamed="remember($event)" />

      <SettingsDialog v-model:open="closeOpen" :title="closeTitle">
        <p>{{ closeText }}</p>
        <p v-if="closeError" class="text-error">{{ closeError }}</p>

        <template #footer>
          <UButton color="neutral" variant="ghost" :label="$t('common.action.cancel')" @click="closeOpen = false" />
          <UButton color="error" :label="closeAction" :loading="closing" :disabled="closing" @click="confirmClose()" />
        </template>
      </SettingsDialog>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { useRemoteDesktop } from "../../domain/remote/desktop-hub";
import {
  DESKTOP_TAB,
  NO_TABS,
  closeTabs,
  isRemoteTab,
  isTerminalTab,
  matchLiveSessions,
  moveTabs,
  openTab,
  pinRemoteTab,
  showTab,
  tidyTabs
} from "../../domain/remote/sessions";
import { claimTerminalKeyboard, releaseRemoteTerminal, sessionName } from "../../domain/remote/terminal-hub";
import { useBackClose } from "bmo-ui/app/domain/layers";
import { failureText } from "../../domain/remote/refusals";

import type { RemoteTerminalInfo } from "../../../shared/remote";
import type { BarAction, BarMenuItem, BarTab } from "bmo-ui/app/domain/tabs";
import type { RemoteTabs } from "../../domain/remote/sessions";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const desktop = useRemoteDesktop();

// The tabs are the account's, kept on the server; the server draws the screen with none and the
// page takes them over.
const state = ref<RemoteTabs>(NO_TABS);
const sessions = ref(new Map<string, RemoteTerminalInfo>());
const creating = ref(false);
const failure = ref("");
const fullView = ref(false);
const renaming = ref<string | null>(null);
const renameOpen = ref(false);
const closeIds = ref<string[]>([]);
const closeOpen = ref(false);

// The view taken to the whole window stands over the page like anything floating, so the back
// gesture hands the page back rather than leaving it.
useBackClose(fullView);
const closing = ref(false);
const closeError = ref<string | null>(null);
const sessionsRead = ref(false);

// Entering or leaving that view is a view being shown, so the shown terminal takes the keyboard
// with it. The switch comes from the view's menu, which hands focus back to the button that opened
// it; without this a key pressed straight afterwards would reach the page rather than the shell.
watch(fullView, () => void nextTick(() => claimTerminalKeyboard()));

function labelOf(id: string): string {
  if (id === DESKTOP_TAB) return t("remote.title.desktop");

  const session = sessions.value.get(id);

  return session ? sessionName(session) : id;
}

// Which kind of view the shown tab is, whose menu stands at the bar's right end.
const shownView = computed(() => (state.value.active === null ? null : state.value.active === DESKTOP_TAB ? "desktop" : "terminal"));

const barTabs = computed<BarTab[]>(() =>
  state.value.tabs.map((id) => {
    const pinned = state.value.pinned.includes(id);

    return id === DESKTOP_TAB
      ? { id, label: labelOf(id), icon: "i-material-symbols-desktop-windows-outline", pinned }
      : { id, label: labelOf(id), title: id, icon: "i-material-symbols-terminal", pinned };
  })
);

const actions = computed<BarAction[]>(() => [
  { id: "new", label: t("remote.action.new_terminal"), icon: "i-material-symbols-add", loading: creating.value, disabled: creating.value, onSelect: createTerminal },
  {
    id: "desktop",
    label: t("remote.action.open_desktop"),
    icon: "i-material-symbols-desktop-windows-outline",
    pressed: state.value.active === DESKTOP_TAB,
    onSelect: () => update(openTab(state.value, DESKTOP_TAB))
  }
]);

// What the shown view's menu offers first: the whole window, and a window of its own.
const views = computed<BarAction[]>(() => [
  {
    id: "full",
    label: fullView.value ? t("remote.action.exit_fullscreen") : t("remote.action.fullscreen"),
    icon: fullView.value ? "i-material-symbols-fullscreen-exit" : "i-material-symbols-fullscreen",
    pressed: fullView.value,
    onSelect: () => {
      fullView.value = !fullView.value;
    }
  },
  { id: "window", label: t("remote.action.open_window"), icon: "i-material-symbols-open-in-new", onSelect: openWindow }
]);

function tabMenu(id: string): BarMenuItem[] {
  return isTerminalTab(id)
    ? [
        {
          label: t("remote.title.rename"),
          icon: "i-material-symbols-edit-outline",
          onSelect: () => {
            renaming.value = id;
            renameOpen.value = true;
          }
        }
      ]
    : [];
}

// What closing asks: a terminal's session ends with it; the desktop's connection closes and its
// session stays.
const closingTerminals = computed(() => closeIds.value.filter(isTerminalTab));
const closeTitle = computed(() => (closingTerminals.value.length > 0 ? t("remote.action.end_session") : t("remote.action.disconnect_desktop")));
const closeAction = computed(() => (closingTerminals.value.length > 0 ? t("remote.action.end") : t("remote.action.disconnect")));
const closeText = computed(() => {
  const count = closingTerminals.value.length;

  if (count === 0) return t("remote.message.disconnect_desktop");

  return count === 1
    ? t("remote.message.end_one", { name: labelOf(closingTerminals.value[0]!) })
    : t("remote.message.end_many", { n: count.toLocaleString() });
});

useKeptTabs<RemoteTabs>("remote", {
  read: () => state.value,
  restore: (value) => {
    const kept = tidyTabs(value);
    // Tabs opened before the kept ones arrived stay open, and a tab the address names is shown.
    const opened = state.value.tabs.filter((id) => !kept.tabs.includes(id));
    const asked = route.query.tab;
    let next: RemoteTabs = { ...kept, tabs: [...kept.tabs, ...opened] };

    next = isRemoteTab(asked) ? openTab(next, asked) : { ...next, active: next.active ?? next.tabs[0] ?? null };
    update(sessionsRead.value ? matchLiveSessions(next, [...sessions.value.keys()]) : next);
  }
});

// The shown tab stands in the address, so a link opens the same session.
function update(next: RemoteTabs): void {
  state.value = next;

  if (route.query.tab !== (next.active ?? undefined)) {
    void router.replace({ query: { ...route.query, tab: next.active ?? undefined } });
  }
}

function show(id: string): void {
  update(showTab(state.value, id));
}

function askClose(ids: string[]): void {
  closeIds.value = ids;
  closeError.value = null;
  closeOpen.value = true;
}

async function confirmClose(): Promise<void> {
  if (closing.value) return;

  closing.value = true;
  closeError.value = null;

  const done: string[] = [];

  try {
    for (const id of closeIds.value) {
      if (isTerminalTab(id)) {
        await $fetch(`/api/remote/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
        releaseRemoteTerminal(id);
        forget(id);
      } else {
        desktop.disconnect();
      }

      done.push(id);
    }

    closeOpen.value = false;
  } catch (error) {
    closeError.value = failureText(t, error, t("remote.error.end_failed"));
  } finally {
    closing.value = false;

    if (done.length > 0) update(closeTabs(state.value, done));
    if (state.value.tabs.length === 0) fullView.value = false;
  }
}

function remember(session: RemoteTerminalInfo): void {
  const next = new Map(sessions.value);

  next.set(session.id, session);
  sessions.value = next;
}

function forget(id: string): void {
  const next = new Map(sessions.value);

  next.delete(id);
  sessions.value = next;
}

async function loadSessions(): Promise<void> {
  try {
    const { terminals } = await $fetch<{ terminals: RemoteTerminalInfo[] }>("/api/remote/terminals");
    const ordered = [...terminals].sort((one, other) => one.createdAt - other.createdAt);

    sessions.value = new Map(ordered.map((session) => [session.id, session]));
    sessionsRead.value = true;
    failure.value = "";

    for (const id of state.value.tabs) {
      if (isTerminalTab(id) && !sessions.value.has(id)) releaseRemoteTerminal(id);
    }

    update(matchLiveSessions(state.value, [...sessions.value.keys()]));
  } catch {
    failure.value = t("remote.error.terminals_failed");
  }
}

async function createTerminal(): Promise<void> {
  if (creating.value) return;

  creating.value = true;

  try {
    const { terminal } = await $fetch<{ terminal: RemoteTerminalInfo }>("/api/remote/terminals", { method: "POST", body: {} });

    remember(terminal);
    update(openTab(state.value, terminal.id));
    failure.value = "";
  } catch (error) {
    failure.value = failureText(t, error, t("remote.error.open_failed"));
  } finally {
    creating.value = false;
  }
}

// A session that ended by itself leaves the bar with its terminal.
function ended(id: string): void {
  releaseRemoteTerminal(id);
  forget(id);
  update(closeTabs(state.value, [id]));
}

// The shown session in a browser window of its own, which attaches to the same session. The desktop
// moves there: the one desktop follows the window that connected last.
function openWindow(): void {
  const active = state.value.active;

  if (active === null) return;

  const path = active === DESKTOP_TAB ? "/remote/desktop" : `/remote/terminal/${encodeURIComponent(active)}`;
  const opened = window.open(router.resolve(path).href, `bmo-remote-${active}`, "popup=yes,width=1280,height=800");

  if (opened !== null) fullView.value = false;
}

// Sessions start and end in other windows too; the list is read again whenever this one is looked at.
function onVisible(): void {
  if (document.visibilityState === "visible") void loadSessions();
}

onMounted(() => {
  const asked = route.query.tab;

  if (isRemoteTab(asked)) update(openTab(state.value, asked));

  document.addEventListener("visibilitychange", onVisible);
  void loadSessions();
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisible);
});
</script>
