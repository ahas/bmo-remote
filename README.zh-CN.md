[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

# bmo-remote

本服务以一个拥有自己 API 的独立服务，承担控制台的远程访问:服务所在机器上的终端会话由专属的 tmux 服务器保持;
该机器的桌面则通过 GNOME 远程登录以 RDP 访问，浏览器中的 IronRDP 客户端通过 RDCleanPath 连接中继。服务自带的命令
`bmo-remote node
remote-desktop` 用于查看和设置中继所连接的端口。本服务不调用任何其他单元，由前端的控制台转发远程界面的请求，
详见 `docs/api.md`。

## 测试

测试平台的 `personal-data` 检查会扫描所有被跟踪的文件，查找邮件地址、主目录路径、电话号码、令牌和私有网络地址
(`PERSONAL-DATA.md`)。`tests/` 中的测试组成一个测试目标 `tests/main.rs`，每个测试文件都是它的一个模块，包括:
将旧归档中保留的桌面端口导入存储的 `tests/import.rs`;验证粘贴到终端会话中的图片作为会话专属文件保存、并随会话
一同删除的 `tests/pastes.rs`;以及针对控制台接口的 `tests/console.rs`。`tests/console.rs` 验证:服务提供的清单能在
客户端 vendoring 的发行版上以 bmo-ui 自身的方式读取;服务的声明和凭据接入 bmo-chat 的控制台接口;界面需要时会要求
控制台凭据和读者角色;服务自身的令牌在控制台接口上被拒绝，而在界面的路由上被接受。控制台接口本身的规则由其
crate 的测试负责。测试通过 `cargo test` 运行，清单读取则用 bun 在 vendoring 的发行版文件上运行。
写文件的测试会写入系统临时目录下自己的文件夹，启动 tmux 服务器的测试会使用自己的套接字;无论测试通过还是
panic，测试结束时两者都会被清理。
打包产物自身的测试位于 `client/tests/`，其中包括:用替身桌面和替身时钟验证对无响应的桌面持续重试，直到它响应、
拒绝或被放弃(`docs/remote.md`,「A
desktop that does not answer」);以及界面的会话列表、视图操作和终端粘贴的测试。它们作为打包检查的一部分，在
`client/` 内通过 `bun run test` 运行。其余行为测试暂缓:待最小服务在新仓库上运行起来后，再在此编写和运行;在此
之前，由测试平台自身的静态检查(编译所有目标并对 crate 进行格式化和 lint)以及打包产物和桌面边车的检查来替代。
`docs/inventory.md` 列出了旧行为所依据的测试。

## 目录结构

| 文件夹 | 内容 |
|---|---|
| `src/` | 服务及其命令，一个 crate 拆分为若干模块 |
| `migrations/` | 存储，按顺序创建其数据表的语句 |
| `client/` | 控制台插件包，即远程界面，是一个独立项目 |
| `desktop-sidecar/` | 桌面边车:服务为响应桌面套接字而启动的 bun 包，是一个独立项目 |
| `deploy/` | 服务的用户单元，以及会话所用 tmux 服务器的 tmux 配置 |
| `tests/` | 现行的行为测试 |
| `docs/` | 描述服务行为的权威文档 |

根目录下有 Cargo 清单及其锁文件、MIT `LICENSE`、`VERSION`、`testbed.toml`、`install.toml`、`rustfmt.toml`、`CLAUDE.md`、
`PERSONAL-DATA.md`、`korean-ledger.json`、`settings.toml`，以及部署时提供的本地设置示例
`settings.local.toml.example`。

## 控制台插件包

`client/` 按照 bmo-ui 的控制台插件约定，将控制台的远程界面打包成一个插件包。IronRDP Web 客户端的 RDP 后端
vendoring 在 `client/vendor/` 下，构建它的脚本位于 `client/scripts/`;由 `docs/openapi.json` 生成的 TypeScript
客户端位于 `client/shared/openapi.ts`。插件包基于 bmo-chat 的 `shared-versions.toml` 所固定的 bmo-ui 发行版构建，
该发行版 vendoring 在 `client/vendor/` 下。`bun run bundle` 使用 bmo-ui 的打包构建将页面构建到 `client/dist/`，
控制台未提供的部分由 `client/module/` 补足。服务通过 bmo-chat 的控制台接口提供该插件包，部署时在发行版中构建
(`docs/api.md`,「The console face」、「The console plugin bundle」)。

界面会按拒绝的代码，用语言包中的文案显示。插件包的检查是在 `client/` 内运行 `bun run check`:安装锁定的依赖、
进行类型检查、运行测试，然后构建模块;测试平台将其作为一个独立项目的检查来运行。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/remote.md` | 终端会话与桌面:由什么保持、线上传输什么，以及边界 |
| `docs/screen.md` | 控制台的远程界面:标签页、视图和菜单 |
| `docs/api.md` | 路由、套接字及其消息和拒绝、命令、存储、设置、控制台接口、控制台插件包，以及控制台所做的事 |
| `docs/inventory.md` | 本仓库从旧仓库继承的内容，以及每组的数量和来源 |
| `PERSONAL-DATA.md` | 本仓库中绝不允许出现的内容(个人的姓名、地址、路径、设备或网络信息，房间成员或公司的信息，真实对话中的任何一行)，以及保障这一点的检查 |

## 版本

`VERSION` 保存仓库的版本，由 crate 和控制台插件包共用。首次发布之前，版本为 `0.1.0` 加修订后缀，规则见
`docs/api.md` 的「Versions」。
