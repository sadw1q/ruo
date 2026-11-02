# Ruo

터미널 AI 코딩 어시스턴트. Pi 기반 실행본과 Ruo 확장·서브에이전트·테마를 포함합니다.

- **[운영체제별 다운로드·설치 가이드](docs/INSTALL.md)**
- [API·모델 설정](docs/CONFIGURATION.md)
- [기반 문서](docs/reference/README.md) · [출처](NOTICE.md) · [MIT 라이선스](LICENSE)

## 다운로드

**[ZIP 다운로드](https://github.com/sadw1q/ruo/archive/refs/heads/main.zip)**

Node.js용 JavaScript 배포입니다. 독립 실행 exe/dmg/deb/AppImage·모바일 앱은 아직 없습니다. npm 레지스트리에도 게시하지 않았습니다.

## 빠른 시작

Node.js 22.19.0 이상(권장 24 LTS), npm, Git 설치 후:

```sh
git clone https://github.com/sadw1q/ruo.git
cd ruo
npm ci
npm link
ruo-setup
ruo --version
ruo
```

전역 등록 없이 실행: `npm ci`, `npm run setup`, `node dist/bundle/cli.js`. 기존 ruo 설치가 있다면 충돌 방지를 위해 로컬 실행을 먼저 사용하세요.

실행 후 `/login`, `/model`로 본인의 계정·모델을 설정하세요. API 요금은 별도입니다.

## 기능과 제한

파일 검색·읽기·편집, 명령 실행, 대화형 질문, 모델 추가, ULTRAMODE 서브에이전트, 토큰·속도 표시, 테마를 포함합니다. 보조 AI 도구는 기본 LMH 공급자의 Ruo-1.0/Ruo-1.0-review를 사용하며 해당 사설 서비스는 제공하지 않습니다. [보조 모델 설정](docs/CONFIGURATION.md)이 필요하며 일반 모델 로그인만으로 모든 기능이 작동하지 않습니다. MCP·웹 검색은 선택 패키지입니다.

Linux, macOS, Windows/WSL2, ChromeOS 설치 절차 및 Android 실험적 절차를 제공합니다. iOS/iPadOS는 SSH 원격 사용만 지원하며 BSD 등은 미검증입니다. 모든 OS·기능의 호환성을 보장하지 않습니다.

Linux x64에서 의존성 설치·설정 보존 테스트·버전 실행을 확인했습니다. CI 템플릿은 ci/platform-checks.yml에 있습니다. 현재 GitHub 인증에 workflow 권한이 없어 자동 실행은 비활성입니다. 활성화하려면 해당 파일을 .github/workflows/check.yml로 옮겨 workflow 권한이 있는 계정으로 푸시하세요. Ubuntu/macOS/Windows 및 Node.js 22/24의 기본 점검용입니다.

## 업데이트·개발

[Git 업데이트 절차](docs/INSTALL.md#업데이트)를 사용하세요. 공식 배포와 달라 내장 `ruo update --self`/`--all`은 권장하지 않습니다. 검증: `npm test`, `npm run check`. 초기화는 기존 확장을 덮어쓰지 않습니다.

`dist/`는 수정된 JavaScript 실행본이며 `extensions/`는 확장 TypeScript 소스입니다. 전체 상위 원본·빌드 체인은 없어 원본 재빌드는 제공하지 않습니다.

## 보안

에이전트·확장은 파일 수정·명령 실행 권한이 있습니다. 신뢰하는 프로젝트에서만 사용하세요. 개인 키·인증·모델·MCP 설정·대화·비밀번호는 제외했습니다.
