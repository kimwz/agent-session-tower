# Agent Session Tower

[English](README.md)

**Claude Code와 Codex의 harness를 그대로 쓰면서, 웹 UI에서 여러 세션과 에이전트를 한눈에 관제하고 관리하세요.**

여러 세션에서 여러 에이전트를 동시에 돌리거나 리모트로 관리할 때 특히 유용합니다.

명령어 하나로 기존 로컬 세션을 프로젝트별 그래프에 모아 볼 수 있습니다.

```sh
npx --yes github:kimwz/agent-session-tower
```

리포지토리를 직접 clone해서 실행할 수도 있습니다.

```sh
git clone https://github.com/kimwz/agent-session-tower.git
cd agent-session-tower
npm ci
npm start
```

`npm ci`가 의존성 설치와 앱 빌드를 자동으로 처리합니다.

브라우저에서 **http://localhost:8000**이 열리고, 아래와 같은 노드형 캔버스로 바로 관제할 수 있습니다.

![Claude Code와 Codex 세션을 프로젝트별 노드로 보여주는 Agent Session Tower 그래프 캔버스](docs/images/session-graph.png)

**Node.js 22.13 이상**, **npm**, **Git**이 필요합니다. 설치하고 로그인해 둔 Claude Code 또는 Codex를 사용합니다. 처음 실행할 때 앱을 내려받아 빌드하며, 이후에는 npm 캐시를 활용합니다. macOS에서 검증했으며, 웹 UI는 **한국어와 영어**를 지원합니다.

## 지원하는 기능

- **기존 세션 자동 발견** — 터미널이나 앱에서 시작한 Claude Code·Codex의 로컬 세션 기록을 자동으로 모아 보여줍니다.
- **실시간 그래프 관제** — 프로젝트, 세션, 서브에이전트를 함께 보고 작업 중·입력 대기·완료·오류 상태를 확인합니다.
- **계정 사용량 확인** — 머신 노드 아래 도넛으로 Claude Code·Codex 사용량을 확인합니다. 마우스를 올리거나 선택하면 기간별 사용률과 초기화 시각을 보여줍니다.
- **새로운 세션 생성** — 웹에서 Claude Code 또는 Codex와 기존 작업 폴더를 선택하고 첫 요청을 보냅니다.
- **같은 대화에서 작업 계속하기** — 원본 대화를 읽고 같은 네이티브 세션에 다음 지시를 보냅니다. 파일 첨부와 이미지 붙여넣기도 지원합니다.
- **채팅에서 모델 선택** — 에이전트 기본 모델을 그대로 사용하거나, 다음 요청에 사용할 모델을 선택합니다.
- **내 방식으로 정리** — 세션·프로젝트 이름 변경, 프로젝트 고정, 노드 드래그, 검색·필터, 세션 숨기기·다시 열기를 지원합니다.
- **새 활동 확인** — 아직 읽지 않은 응답과 작업 결과를 표시합니다.
- **리모트 접근** — 같은 LAN이나 VPN의 다른 기기에서 비밀번호로 접속해 웹으로 관제합니다.

Tower용 계정, 별도 API 키, 데이터베이스, CLI 후크 설정이 필요하지 않습니다. 기존 CLI 계정과 모델 설정을 그대로 사용합니다.

## 리모트 접근

실행 중인 Tower를 `Ctrl+C`로 종료한 뒤 다음 명령으로 시작합니다.

```sh
npx --yes github:kimwz/agent-session-tower --host 0.0.0.0 --port 8000
```

다른 기기에서 터미널에 출력된 네트워크 주소를 여세요. 사용자 이름은 `monitor`이며, 비밀번호는 터미널에 안내된 파일에 저장됩니다. 에이전트가 있는 컴퓨터와 Tower는 계속 실행되어 있어야 합니다.

직접 접속은 HTTP를 사용하므로 신뢰할 수 있는 LAN이나 VPN에서 사용하세요. [리모트 접근 상세 안내](docs/usage.md#remote-access)를 참고하세요.

## 더 알아보기

- [사용법, CLI 옵션, 세션 동작 방식](docs/usage.md)
- [소스에서 실행하고 개발하기](docs/development.md)
- [MIT 라이선스](LICENSE)
