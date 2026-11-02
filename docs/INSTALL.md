# 운영체제별 다운로드·설치 가이드

## 공통 준비와 설치

[ZIP 다운로드](https://github.com/sadw1q/ruo/archive/refs/heads/main.zip) · [Node.js 다운로드](https://nodejs.org/en/download) · [Git 다운로드](https://git-scm.com/downloads)

Node.js 22.19.0 이상(권장 24 LTS), npm·인터넷 필요. 독립 실행 바이너리는 없습니다.

```sh
git clone https://github.com/sadw1q/ruo.git
cd ruo
npm ci
npm link
ruo-setup
ruo --version
ruo
```

ZIP 사용자는 압축 해제한 package.json 폴더에서 npm ci부터 실행합니다. ZIP 방식은 Git이 필요 없습니다. 전역 등록 없이 사용하려면 npm ci → npm run setup → node dist/bundle/cli.js 순서로 실행하세요.

초기화는 ~/.ruo/agent/의 기존 설정·확장을 보존합니다. RUO_CODING_AGENT_DIR로 별도 경로를 지정할 수 있습니다. 실행 후 /login 및 /model로 설정하고 [API 안내](CONFIGURATION.md)를 확인하세요.

## Windows 10/11 직접 설치

PowerShell에서:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
```

winget이 없으면 공식 설치 파일 사용. 터미널을 다시 열어 node --version, npm --version, git --version 확인 후 공통 설치합니다. PowerShell이 ps1 실행을 막으면 정책을 완화하지 말고 npm.cmd, ruo-setup.cmd, ruo.cmd를 사용하거나 명령 프롬프트/Git Bash로 실행하세요. bash.exe를 찾지 못하면 Git Bash에서 실행하세요. Unix 관리자 명령은 직접 설치에서 제한되며 WSL2를 권장합니다. Windows ARM64는 미검증입니다.

## Windows WSL2 (권장)

관리자 PowerShell에서 `wsl --install -d Ubuntu` 실행 후 필요하면 재부팅하세요. Ubuntu 계정을 만들고 Ubuntu 터미널 내부에 Linux용 Node.js 24 LTS와 Git·빌드 도구를 설치합니다. Windows Node.js와 별개입니다. 아래 Ubuntu 및 공통 절차를 따르며 프로젝트는 WSL 홈에 두세요.

## macOS Intel / Apple Silicon

공식 macOS Node.js 설치 파일 또는 Homebrew 사용:

```sh
brew install node@24 git
```

Homebrew의 node@24 PATH 안내를 적용하고 새 터미널에서 버전 확인 후 공통 설치하세요. Intel은 x64, Apple Silicon은 ARM64 Node.js 권장. 빌드 도구가 필요하면 xcode-select --install 실행.

## Linux Ubuntu / Debian / Mint

패키지 관리자로 git, curl, ca-certificates, build-essential을 설치하세요. 공식 Node.js 다운로드 안내에서 Linux용 24 LTS를 설치한 뒤 공통 절차를 진행합니다. 배포판 기본 Node.js 버전이 낮을 수 있으니 최소 버전을 반드시 확인하세요.

## Linux Fedora / RHEL

dnf로 git, nodejs, npm, gcc-c++, make 설치. Node.js가 최소 버전보다 낮으면 공식 안내·버전 관리자로 24 LTS 설치 후 공통 절차를 따르세요.

## Linux Arch / Manjaro

pacman으로 시스템 갱신 및 git, nodejs, npm, base-devel 설치 후 공통 절차를 진행하세요.

## Linux openSUSE

zypper로 git, nodejs24, npm24, gcc-c++, make 설치. 저장소에 해당 버전이 없다면 공식 Node.js 설치 안내 사용 후 공통 절차를 진행하세요.

## Linux Alpine / musl

apk로 nodejs, npm, git, bash, build-base 설치 후 최소 버전 확인. musl 네이티브 의존성은 미검증이며 실패하면 Ubuntu/Debian 또는 원격 SSH를 권장합니다.

## Linux ARM64 / Raspberry Pi

64비트 OS와 ARM64 Node.js로 해당 배포판 절차를 따르세요. 32비트 ARM은 보장하지 않습니다. 이미지·클립보드 네이티브 모듈은 플랫폼에 따라 제한됩니다.

## ChromeOS

Linux 개발 환경(Crostini)을 활성화하고 Linux 터미널에서 Debian/Ubuntu 절차를 따르세요. 관리 기기는 차단될 수 있습니다.

## Android Termux (실험적)

Termux 배포는 https://termux.dev 에서 확인하세요.

```sh
pkg update
pkg install nodejs-lts git bash clang make python
node --version
npm --version
```

최소 버전을 만족하면 공통 설치를 시도하세요. Android 네이티브 npm 의존성 때문에 실패할 수 있으며 보장하지 않습니다. 실패하면 pkg install openssh 후 ssh user@your-server로 원격 서버에 접속하세요.

## iOS / iPadOS

직접 설치용 앱·파일은 없습니다. SSH 클라이언트로 Ruo가 설치된 PC/서버에 접속해 실행하세요. 인증·세션은 원격 서버에 저장됩니다. iSH 등 에뮬레이션 직접 설치는 지원하지 않습니다.

## FreeBSD / OpenBSD / NetBSD 및 기타 OS

미검증입니다. 최소 Node.js와 네이티브 의존성 지원이 필요합니다. 실패하면 Linux VM/서버에 SSH 접속하세요. 모든 OS에 직접 설치 가능하다는 의미는 아닙니다.

## 업데이트

Git 설치 폴더에서:

```sh
git pull --ff-only
npm ci
npm link
ruo-setup
```

공식 npm 배포와 다른 포크이므로 내장 ruo update --self/--all 대신 위 절차 사용. ZIP은 새 폴더에 설치하세요. 초기화는 기존 확장을 덮어쓰지 않습니다. 확장도 업데이트하려면 종료 후 사용자 extensions/와 themes/를 백업하고 교체할 항목만 이동한 뒤 초기화하세요. 인증·모델·세션 전체를 삭제하지 마세요.

## 제거

npm uninstall -g @sadw1q/ruo 로 전역 등록 제거. 다운로드 폴더는 별도 정리. ~/.ruo/agent/는 키·대화 기록을 포함하고 다른 설치와 공유할 수 있으므로 자동 삭제하지 않습니다. 백업 후 원할 때만 정리하세요.

## 문제 해결

- 명령 없음: 새 터미널에서 PATH와 npm link 결과 확인. node dist/bundle/cli.js 로 로컬 실행 가능.
- 기존 설치 충돌: which ruo 또는 Windows where.exe ruo 로 위치 확인 후 로컬 실행 테스트.
- 모델 없음: /login, /model, API 안내 확인.
- LMH 오류: 보조 공급자·모델을 본인 환경에 맞게 지정.
- MCP·검색 없음: 선택 패키지 및 사용자 서버·인증 설정 필요.
- 네이티브 모듈 실패: OS/CPU에 맞는 Node.js와 빌드 도구 사용. 다른 OS의 node_modules를 복사하지 마세요.
