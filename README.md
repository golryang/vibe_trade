# VibeTrade - Advanced Multi-Bot Trading System

VibeTrade는 여러 거래소에서 동시에 실행되는 다중 봇 트레이딩 시스템입니다. DDIA (Designing Data-Intensive Applications) 원칙을 적용하여 확장 가능하고 견고한 아키텍처로 설계되었습니다.

## 🚀 주요 기능

### 멀티봇 지원
- 여러 트레이딩 봇을 동시에 실행
- 봇별 독립적인 설정 및 리스크 관리
- 실시간 성능 모니터링

### Cross-Venue Hedge Market Making
- 여러 거래소 간 가격 차이를 이용한 차익거래
- 자동 포지션 헤징 및 리밸런싱
- 실시간 스프레드 모니터링

### Single-Venue Stoikov Market Making ⭐ NEW
- Avellaneda-Stoikov 모델 기반 고급 마켓메이킹
- 수학적 최적화된 호가 계산 (γ, σ, k 파라미터)
- 정교한 리스크 관리 및 실시간 KPI 추적
- 상태머신 기반 고성능 주문 실행 엔진

### 견고한 시스템 아키텍처
- Event-driven 아키텍처
- 포괄적인 로깅 및 모니터링
- 자동 장애 복구 메커니즘
- 구조화된 설정 관리

## 📁 프로젝트 구조

```
src/
├── core/           # 핵심 시스템 컴포넌트
│   ├── BaseBot.ts         # 봇 베이스 클래스
│   ├── BotOrchestrator.ts # 봇 오케스트레이터
│   ├── EventEmitter.ts    # 이벤트 버스
│   └── Logger.ts          # 로깅 시스템
├── bots/           # 트레이딩 봇 구현체
│   ├── CrossVenueHedgeBot.ts # 크로스 베뉴 헤지 봇
│   └── StoikovBot.ts         # Stoikov 마켓메이킹 봇 ⭐
├── engines/        # 수학적 엔진 ⭐
│   └── StoikovEngine.ts      # Stoikov 최적화 엔진
├── execution/      # 주문 실행 시스템 ⭐
│   └── ExecutionEngine.ts    # 상태머신 기반 실행 엔진
├── risk/           # 리스크 관리 ⭐
│   └── RiskManager.ts        # 다층 리스크 모니터링
├── data/           # 마켓 데이터 처리 ⭐
│   └── MarketDataProcessor.ts # L2/L3 오더북 처리
├── monitoring/     # KPI 모니터링 ⭐
│   └── StoikovMonitor.ts     # 15+ KPI 실시간 추적
├── cli/            # CLI 인터페이스 ⭐
│   ├── CLIManager.ts         # 인터랙티브 봇 관리
│   └── BotFactory.ts         # 봇 생성 팩토리
├── exchanges/      # 거래소 추상화 레이어
│   └── BaseExchange.ts
├── services/       # 시스템 서비스
│   ├── ConfigManager.ts   # 설정 관리
│   ├── MetricsCollector.ts # 메트릭 수집
│   └── HealthMonitor.ts   # 헬스 모니터링
├── types/          # 타입 정의
│   └── index.ts
└── utils/          # 유틸리티 함수
```

## 🛠 설치 및 설정

### 1. 의존성 설치
```bash
  install
```

### 2. 환경 설정
```bash
cp .env.example .env
# .env 파일을 편집하여 거래소 API 키 설정
```

### 3. 설정 파일 수정
`config.json` 파일에서 봇 설정을 수정합니다:

```json
{
  "bots": [
    {
      "id": "cross-venue-hedge-1",
      "enabled": true,
      "parameters": {
        "minSpreadPercent": 0.1,
        "maxPositionSize": 100
      }
    }
  ]
}
```

### 4. 빌드 및 실행
```bash
# 개발 모드
npm run dev

# 프로덕션 빌드
npm run build
npm start
```

## 🤖 Cross-Venue Hedge MM 봇

### 동작 원리
1. **스프레드 모니터링**: 여러 거래소 간 가격 차이 실시간 감지
2. **차익거래 실행**: 스프레드가 임계값을 초과할 때 양방향 주문 실행
3. **포지션 헤징**: 불균형한 포지션을 자동으로 헤지
4. **리스크 관리**: 포지션 크기 및 손실 한도 관리

### 주요 파라미터
- `minSpreadPercent`: 최소 스프레드 비율 (%)
- `maxPositionSize`: 최대 포지션 크기
- `hedgeThreshold`: 헤징 임계값
- `rebalanceInterval`: 리밸런싱 간격 (ms)

## 📊 모니터링 및 메트릭

### 성능 지표
- 총 손익 (PnL)
- 승률 (Win Rate)
- 거래 횟수
- 활성 포지션 수
- 시스템 가동률

### 헬스 체크
- 메모리 사용량 모니터링
- CPU 사용량 추적
- 봇 상태 확인
- 거래소 연결 상태
- 리스크 한도 검증

## 🔧 확장하기

### 새로운 봇 추가
1. `BaseBot`을 상속받는 새로운 클래스 생성
2. 필수 메소드 구현 (`initialize`, `cleanup`, 이벤트 핸들러)
3. 설정에 봇 추가
4. 오케스트레이터에서 봇 등록

### 새로운 거래소 추가
1. `BaseExchange`를 상속받는 새로운 클래스 생성
2. API 연동 및 WebSocket 구현
3. 설정에 거래소 추가

## 🚨 리스크 관리

### 자동 보호 기능
- 일일 손실 한도 초과 시 자동 정지
- 포지션 크기 제한
- 메모리/CPU 사용량 모니터링
- 자동 장애 복구

### 수동 제어
- 실시간 봇 시작/정지
- 설정 동적 업데이트
- 긴급 정지 기능

## 📝 로깅

모든 중요한 이벤트가 구조화된 로그로 기록됩니다:
- `logs/error.log`: 에러 로그
- `logs/combined.log`: 모든 로그
- 콘솔: 실시간 로그 출력

## 🔐 보안 고려사항

- API 키는 환경 변수로 관리
- 민감한 정보는 설정 파일에 저장하지 않음
- 레이트 리미팅 구현
- 연결 타임아웃 및 재시도 로직

## 📈 성능 최적화

- 이벤트 기반 아키텍처로 낮은 지연시간
- 메모리 효율적인 데이터 구조
- 연결 풀링 및 재사용
- 비동기 처리로 높은 처리량

## 🧠 Stoikov Bot - 고급 마켓메이킹 ⭐ NEW

### 핵심 특징
- **수학적 최적화**: Avellaneda-Stoikov 모델로 과학적 호가 계산
- **실시간 적응**: 변동성(σ)과 거래강도(k)에 따른 동적 조정
- **상태머신**: 고성능 주문 생명주기 관리 (MakerPlaced → Fill/Cancel/Replace)
- **정교한 리스크**: 다층 리스크 한도 (인벤토리/드리프트/DD/연속실패)

### 주요 파라미터
```json
{
  "gamma": 0.6,              // 위험 회피도 {0.3, 0.6, 1.0, 1.2}
  "volatilityWindow": 30000,  // EWMA 윈도우 {5s, 30s, 5m}
  "maxInventoryPct": 5,      // 최대 인벤토리 {2%, 5%, 10% NAV}
  "ttlMs": 800,              // 주문 TTL {300-2000ms}
  "ladderLevels": 2,         // 래더 레벨 {1, 2, 3}
  "driftCutBps": 5          // 드리프트 컷 {3, 5, 8bp}
}
```

### KPI 모니터링 (스펙 요구사항)
- ✅ **유효 스프레드(bp)**: 실제 제공 스프레드 추적
- ✅ **Fill Ratio**: 주문 체결률 모니터링  
- ✅ **평균 대기시간**: 주문-체결 지연시간 측정
- ✅ **Inventory Variance**: 인벤토리 변동성 최적화
- ✅ **재호가/초**: 초당 재호가 빈도 제한
- ✅ **거절률**: 주문 거절률 최소화

### CLI에서 사용하기
```bash
npm run dev:cli
# -> ➕ 새 봇 추가하기  
# -> StoikovBot 선택
# -> 파라미터 조정 (gamma, TTL, 리스크 한도 등)
# -> 실시간 KPI 대시보드로 성능 모니터링
```

📖 **자세한 가이드**: [docs/STOIKOV_BOT.md](docs/STOIKOV_BOT.md)

## 🛡 테스팅

```bash
# 유닛 테스트
npm test

# 타입 체크
npm run typecheck

# 린팅
npm run lint
```

## 📚 참고자료

- [DDIA](https://dataintensive.net/) - 시스템 설계 원칙
- 거래소 API 문서
- TypeScript 공식 문서

## 📄 라이선스

MIT License