# API·모델·선택 기능 설정

## 기본 인증

계정·API 키·사설 서비스는 제공하지 않습니다. 실행 후 /login, /model로 본인 계정을 설정하세요. 요금·모델은 계정에 따라 다릅니다. 비밀값은 채팅·GitHub가 아닌 인증 화면에 입력하세요. 설정은 ~/.ruo/agent/에 저장됩니다. Windows의 ~는 사용자 프로필입니다.

커스텀 공급자는 models.json에서 구성하며 [기반 모델 문서](reference/models.md)를 참고하세요. 키는 가능하면 환경변수 참조를 사용하세요.

## 보조 모델

일부 도구는 기본 LMH 공급자의 Ruo-1.0 및 Ruo-1.0-review에 의존합니다. 해당 서비스는 포함하지 않습니다. 본인의 OpenAI 호환 공급자를 등록하고 환경변수를 설정하세요.

- RUO_PROVIDER: 등록한 공급자 이름. 기본 LMH.
- RUO_WEB_MODEL, RUO_APPLY_MODEL, RUO_STRONG_MODEL, RUO_RERANK_MODEL, RUO_TITLE_MODEL: 각각 웹·편집 적용·고성능·재정렬·제목용 실제 모델 ID. 기본 Ruo-1.0.
- RUO_REVIEW_MODEL: 관리자 명령 검토 모델. 기본 Ruo-1.0-review.

Linux/macOS는 export VAR=value, PowerShell은 $env:VAR = 값 형식으로 지정하세요. 공급자는 OpenAI 호환 채팅과 도구 출력 요구사항을 만족해야 합니다. 임의 모델로 동일 품질·안전성을 보장하지 않으며 관리자 명령은 직접 확인하세요. 기본 런타임만 테스트하려면 ruo --no-extensions 사용.

## MCP·웹 검색 선택 설치

```sh
ruo install npm:pi-mcp-adapter@2.34.0
ruo install npm:pi-web-access@0.44.0
```

재시작 후 각 패키지 안내에 따라 MCP 서버·검색 공급자·API 인증을 설정하세요. 모든 외부 서비스 호환성을 보장하지 않습니다.

## 설정 보존

초기화는 없는 확장·테마만 설치하고 기존 settings.json을 보존합니다. 개인 auth.json, models.json, models-store.json, mcp.json, web-search.json, 세션·백업·비밀번호는 포함하지 않습니다. 사용자 데이터 권한·백업은 별도로 관리하세요.
