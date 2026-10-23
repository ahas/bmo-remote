// The served module's entry (docs/api.md, "The console plugin bundle"): its default export holds the routes
// of the remote screen, each under the manifest's screen path, with the stylesheet the module's build emits
// beside it.
import "./style.css";

import RemoteDesktopPage from "../app/pages/remote/desktop.vue";
import RemotePage from "../app/pages/remote/index.vue";
import RemoteTerminalPage from "../app/pages/remote/terminal/[id].vue";

import type { ConsoleBundleModule } from "bmo-ui/shared/console-manifest";

const bundle: ConsoleBundleModule = {
  routes: [
    { path: "/remote", name: "remote", component: RemotePage },
    // A session's own window stands on no layout of the console's.
    { path: "/remote/desktop", name: "remote-desktop", component: RemoteDesktopPage, meta: { layout: false } },
    { path: "/remote/terminal/:id", name: "remote-terminal-id", component: RemoteTerminalPage, meta: { layout: false } }
  ]
};

export default bundle;
