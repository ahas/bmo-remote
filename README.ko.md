[English](README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# bmo-remote

콘솔의 원격 접속을 자체 API를 가진 하나의 서비스로 제공합니다. 서비스가 실행되는 머신의 터미널 세션은 전용
tmux 서버가 유지하고, 그 머신의 데스크톱은 GNOME 원격 로그인을 통해 RDP로 접속합니다. 이때 브라우저의 IronRDP
클라이언트는 릴레이에 RDCleanPath로 연결합니다. 서비스의 자체 명령인 `bmo-remote node
remote-desktop`은 릴레이가 연결할 포트를 조회하고 설정합니다. 이 서비스는 다른 유닛을 호출하지 않으며, 앞단의
콘솔이 원격 화면의 요청을 전달합니다. 자세한 내용은 `docs/api.md`에 있습니다.

## 테스트

테스트베드의 `personal-data` 검사는 추적되는 모든 파일에서 메일 주소, 홈 경로, 전화번호, 토큰, 사설 네트워크
주소를 찾습니다(`PERSONAL-DATA.md`). `tests/`의 테스트는 하나의 테스트 타깃 `tests/main.rs`로 묶이며, 각
테스트 파일은 그 모듈입니다. 구성은 다음과 같습니다. 이전 아카이브에 보관된 데스크톱 포트를 저장소로 가져오는
`tests/import.rs`, 터미널 세션에 붙여 넣은 그림이 세션 전용 파일로 보관되고 세션과 함께 사라지는지 확인하는
`tests/pastes.rs`, 그리고 콘솔 페이스를 다루는 `tests/console.rs`입니다. `tests/console.rs`는 서비스가 제공하는
매니페스트를 클라이언트가 vendoring한 릴리스에서 bmo-ui 자체의 읽기 방식으로 읽는지, 서비스의 선언과 자격 증명이
bmo-chat의 콘솔 페이스에 연결되는지, 화면에 필요한 곳에서 콘솔의 자격 증명과 읽는 사람의 역할을 요구하는지,
서비스 자체 토큰이 페이스에서는 거부되고 화면의 라우트에서는 받아들여지는지를 확인합니다. 페이스 자체의 규칙은
해당 크레이트의 테스트가 다룹니다. 테스트는 `cargo test`로 실행하며, 매니페스트 읽기는 vendoring된 릴리스 파일에
대해 bun으로 실행합니다.
파일을 쓰는 테스트는 시스템 임시 폴더 아래 자신만의 폴더에 쓰고, tmux 서버를 띄우는 테스트는 자신만의 소켓으로
띄웁니다. 둘 다 테스트가 통과하든 패닉하든 테스트가 끝나면 정리됩니다.
번들 자체의 테스트는 `client/tests/`에 있습니다. 응답하지 않는 데스크톱이 응답하거나, 거부하거나, 놓아줄 때까지
다시 시도되는지를 대역 데스크톱과 대역 시계로 확인하는 테스트(`docs/remote.md`, 「A
desktop that does not answer」)와 화면의 세션 목록, 보기 동작, 터미널 붙여 넣기 테스트가 포함되며, 번들 검사의
일부로 `client/` 안에서 `bun run test`로 실행합니다. 나머지 동작 테스트는 보류되어 있습니다. 최소 서비스들이 새
저장소 위에 자리 잡으면 여기서 작성하고 실행하며, 그 전까지는 모든 타깃을 컴파일해 크레이트를 포맷하고 린트하는
테스트베드 자체의 정적 검사와 번들 및 데스크톱 사이드카의 검사가 그 자리를 대신합니다.
`docs/inventory.md`에는 이전 동작을 검증하던 테스트 목록이 있습니다.

## 구조

| 폴더 | 내용 |
|---|---|
| `src/` | 서비스와 그 명령. 하나의 크레이트를 자체 모듈로 나눈 것 |
| `migrations/` | 저장소. 테이블을 순서대로 만드는 구문 |
| `client/` | 콘솔 플러그인 번들. 원격 화면을 담은 독립 프로젝트 |
| `desktop-sidecar/` | 데스크톱 사이드카. 데스크톱의 소켓에 응답하도록 서비스가 띄우는 bun 패키지이자 독립 프로젝트 |
| `deploy/` | 서비스의 사용자 유닛과 세션의 tmux 서버가 사용하는 tmux 설정 |
| `tests/` | 현재 유지되는 동작 테스트 |
| `docs/` | 서비스가 하는 일에 대한 정식 문서 |

루트에는 Cargo 매니페스트와 그 잠금 파일, MIT `LICENSE`, `testbed.toml`, `install.toml`, `rustfmt.toml`, `CLAUDE.md`,
`PERSONAL-DATA.md`, `korean-ledger.json`, `settings.toml`, 그리고 배포가 제공하는 로컬 설정의 예시인
`settings.local.toml.example`이 있습니다.

## 콘솔 플러그인 번들

`client/`는 콘솔의 원격 화면을 bmo-ui 콘솔 플러그인 규약에 따른 번들로 담고 있습니다. IronRDP 웹 클라이언트의 RDP
백엔드는 `client/vendor/`에, 그것을 빌드하는 스크립트는 `client/scripts/`에 vendoring되어 있으며,
`docs/openapi.json`에서 생성한 TypeScript 클라이언트를 `client/shared/openapi.ts`에 포함합니다. 번들은
bmo-chat의 `shared-versions.toml`이 고정한 bmo-ui 릴리스를 기반으로 하며, 이 릴리스는 `client/vendor/`에
vendoring되어 있습니다. `bun run bundle`은 bmo-ui의 번들 빌드로 페이지를 `client/dist/`에 빌드하고, 콘솔이
제공하지 않는 것은 `client/module/`에서 채워 넣습니다. 서비스는 bmo-chat의 콘솔 페이스를 통해 번들을 제공하며,
배포 시 릴리스 안에서 빌드됩니다(`docs/api.md`, 「The console face」, 「The console plugin bundle」).

화면은 거부를 코드에 따라 팩의 문구로 표시합니다. 번들 검사는 `client/` 안에서 실행하는 `bun run check`이며,
잠긴 패키지를 설치하고, 타입 검사를 하고, 테스트를 실행한 뒤 모듈을 빌드합니다. 테스트베드는 이를 독립
프로젝트의 검사로 실행합니다.

## 문서

| 문서 | 내용 |
|---|---|
| `docs/remote.md` | 터미널 세션과 데스크톱: 무엇이 이를 유지하는지, 무엇이 오가는지, 그리고 경계 |
| `docs/screen.md` | 콘솔의 원격 화면: 탭, 보기, 메뉴 |
| `docs/api.md` | 라우트, 소켓, 그 메시지와 거부, 명령, 저장소, 설정, 콘솔 페이스, 콘솔 플러그인 번들, 그리고 콘솔이 하는 일 |
| `docs/inventory.md` | 이 저장소가 이전 저장소에서 가져온 것과 각 묶음의 개수 및 출처 |
| `PERSONAL-DATA.md` | 이 저장소에 절대 들어가면 안 되는 것(개인의 이름, 주소, 경로, 기기나 네트워크 정보, 방 구성원이나 회사의 정보, 실제 대화의 한 줄)과 이를 지키는 검사 |

## 버전

버전은 세트의 버전이며, 빌드할 때 git 태그에서 읽습니다. 매니페스트의 버전 필드는 움직이지 않는 자리표시자이며,
규칙은 `docs/api.md`의 「Versions」에 있습니다.
