# Stoikov Bot - Single-Venue Risk-Averse Market Making

## 📖 개요

Stoikov Bot은 Avellaneda-Stoikov 모델을 기반으로 한 고급 단일 거래소 마켓메이킹 전략입니다. 수학적으로 최적화된 호가 제공과 정교한 리스크 관리를 통해 안정적인 수익을 추구합니다.

### 🎯 핵심 특징

- **수학적 최적화**: Stoikov 모델을 통한 과학적 호가 계산
- **실시간 적응**: 변동성과 거래 강도에 따른 동적 조정
- **정교한 리스크 관리**: 다층적 리스크 한도 및 자동 차단
- **고성능 실행**: 밀리초 단위 최적화된 주문 관리
- **포괄적 모니터링**: 15개+ KPI 실시간 추적

## 📊 전략 원리

### 1. Stoikov 수학적 모델

**최적 스프레드 계산:**
```
δ_t = γσ²/2k + ln(1 + γ/k)/γ
```

**예약 가격 (Reservation Price):**
```
r_t = mid_t - γσ²q_t
```

### 2. 핵심 파라미터

| 파라미터 | 설명 | 기본값 | 범위 |
|---------|------|--------|------|
| **γ (gamma)** | 위험 회피도 | 0.6 | 0.3-1.2 |
| **σ (sigma)** | 변동성 (EWMA) | 30s | 5s-5m |
| **k (lambda)** | 거래 강도 | 60s | 저/중/고 |
| **q_max** | 최대 인벤토리 | 5% NAV | 2-10% |

### 3. 실행 파라미터

| 파라미터 | 설명 | 기본값 | 범위 |
|---------|------|--------|------|
| **PostOnly 오프셋** | 틱 단위 오프셋 | ±1 | ±1-±3 |
| **TTL** | 주문 생명주기 | 800ms | 300-2000ms |
| **Repost 간격** | 재호가 간격 | 200ms | 100-300ms |
| **Ladder 레벨** | 계층 주문 수 | 2 | 1-3 |

## 🛠 설정 방법

### 1. 기본 설정

```json
{
  "id": "stoikov-mm-btc",
  "type": "StoikovBot",
  "name": "Stoikov Market Maker BTC",
  "enabled": false,
  "exchanges": ["binance"],
  "symbols": ["BTCUSDT"],
  "parameters": {
    "gamma": 0.6,
    "volatilityWindow": 30000,
    "maxInventoryPct": 5,
    "ttlMs": 800,
    "repostMs": 200,
    "ladderLevels": 2,
    "driftCutBps": 5,
    "sessionDDLimitPct": 0.5,
    "exchange": "binance",
    "symbol": "BTCUSDT"
  }
}
```

### 2. 파라미터 튜닝 가이드

#### 보수적 설정 (낮은 위험)
```json
{
  "gamma": 1.0,
  "maxInventoryPct": 2,
  "driftCutBps": 3,
  "sessionDDLimitPct": 0.3
}
```

#### 공격적 설정 (높은 수익 추구)
```json
{
  "gamma": 0.3,
  "maxInventoryPct": 10,
  "driftCutBps": 8,
  "sessionDDLimitPct": 1.0
}
```

#### 고빈도 설정 (빠른 회전)
```json
{
  "ttlMs": 300,
  "repostMs": 100,
  "ladderLevels": 3,
  "alphaSizeRatio": 0.6
}
```

## 🎛 상태머신 (State Machine)

```
MakerPlaced
├─ Fill (롱/숏 인벤토리 변화) -> 재계산 -> 양측 재호가
├─ PartialFill -> 잔량만 재게시
├─ TTL/OB변화/queue↑ -> cancelReplace
└─ Drift/DD 초과 -> Flat (시장가/IOC) -> 재시작 or 쿨다운
```

### 상태 전환 조건

1. **Fill**: 주문 체결 시 인벤토리 업데이트 후 재계산
2. **PartialFill**: 부분 체결 시 잔량만 재게시
3. **TTL 만료**: 주문 생명주기 만료 시 cancel-replace
4. **OB 변화**: 오더북 변화로 인한 재호가 필요
5. **Risk Limit**: 리스크 한도 초과 시 강제 청산

## 📈 모니터링 KPI

### 핵심 성능 지표 (스펙 요구사항)

| KPI | 설명 | 목표 |
|-----|------|------|
| **유효 스프레드** | 실제 제공 스프레드 (bp) | 2-10bp |
| **Fill Ratio** | 주문 체결률 (%) | >60% |
| **평균 대기시간** | 주문-체결 시간 (초) | <2초 |
| **Inventory Variance** | 인벤토리 변동성 | 최소화 |
| **세션 DD** | 세션 최대 손실 (%) | <0.5% |
| **재호가/초** | 초당 재호가 횟수 | <3회 |
| **거절률** | 주문 거절률 (%) | <5% |

### 확장 메트릭

- **Fill Latency**: 평균 체결 지연시간 (ms)
- **Market Share**: 거래량 점유율 (%)
- **Adverse Selection**: 역선택 비율
- **Inventory Turnover**: 인벤토리 회전율
- **Risk-Adjusted PnL**: 위험 조정 수익률

## ⚠️ 리스크 관리

### 1. 자동 보호 장치

| 리스크 타입 | 임계값 | 조치 |
|------------|--------|------|
| **인벤토리 초과** | NAV 5% | 포지션 청산 |
| **가격 드리프트** | 5bp | 포지션 청산 |
| **세션 DD** | NAV 0.5% | 포지션 청산 |
| **일일 DD** | NAV 1.0% | 봇 정지 |
| **연속 실패** | 10회 | 임시 중단 |
| **변동성 급증** | 200% | 스프레드 확대 |

### 2. 동적 조정

- **사이즈 조정**: 리스크 레벨에 따른 주문 크기 축소
- **스프레드 확대**: 고변동성 시 안전 마진 증가
- **쿨다운**: 리스크 이벤트 후 자동 휴식

### 3. 응급 상황 대응

```bash
# 긴급 정지
POST /api/bots/{botId}/emergency-stop

# 포지션 강제 청산
POST /api/bots/{botId}/flatten

# 리스크 한도 임시 변경
PUT /api/bots/{botId}/risk-limits
```

## 🖥 CLI 사용법

### 1. CLI에서 봇 추가

```bash
npm run dev:cli
# -> ➕ 새 봇 추가하기
# -> StoikovBot 선택
# -> 파라미터 설정
```

### 2. 실시간 모니터링

```bash
# 실시간 대시보드
# -> 🔄 실시간 대시보드

# 성능 보고서
# -> 📈 성능 보고서

# KPI 상세 보기
# -> 📊 봇 상태
```

### 3. 파라미터 실시간 조정

```bash
# -> ⚙️ 봇 설정 수정
# -> 파라미터 선택
# -> 값 변경 (즉시 적용)
```

## 🔧 고급 설정

### 1. 타임존 프로필

```json
{
  "timezoneProfile": "asia",    // 아시아 시간대 최적화
  "timezoneProfile": "eu",      // 유럽 시간대 최적화  
  "timezoneProfile": "us",      // 미국 시간대 최적화
  "timezoneProfile": "global"   // 글로벌 24시간
}
```

### 2. 변동성 체제별 조정

```json
{
  "volRegimeScaler": 0.3,  // 보수적 (낮은 변동성 시 스프레드 축소)
  "volRegimeScaler": 0.5,  // 균형적
  "volRegimeScaler": 0.8   // 공격적 (높은 변동성 시 스프레드 확대)
}
```

### 3. 오더북 가중치

```json
{
  "obiWeight": 0,    // OBI 미사용
  "obiWeight": 0.3,  // 중간 가중치
  "obiWeight": 0.5   // 높은 가중치 (불균형 반영)
}
```

## 📊 백테스팅 및 최적화

### 1. 파라미터 최적화 절차

1. **기본 설정으로 1주일 운영**
2. **KPI 분석 후 문제점 파악**
3. **파라미터 단계적 조정**
4. **A/B 테스트로 성능 비교**
5. **최적값 도출 후 적용**

### 2. 성과 벤치마킹

- **시장 대비 성과**: SPX/BTC 대비 위험조정수익률
- **경쟁 MM 대비**: 다른 마켓메이커 대비 spread/volume
- **내부 기준**: 목표 Sharpe ratio >1.5

## 🚨 주의사항

### 1. 시장 상황별 대응

- **뉴스 이벤트**: 자동 스프레드 확대 및 사이즈 축소
- **급변동**: 임시 중단 후 변동성 안정화 대기
- **저유동성**: 더 넓은 스프레드와 작은 사이즈로 조정

### 2. 정기 점검사항

- **일일**: 세션 성과 및 리스크 메트릭 확인
- **주간**: 파라미터 최적화 및 시장 체제 분석  
- **월간**: 전략 성과 평가 및 업그레이드 검토

### 3. 백업 및 복구

- **설정 백업**: 파라미터 세트별 버전 관리
- **로그 보관**: 최소 30일 거래 기록 유지
- **복구 절차**: 장애 시 자동 안전모드 전환

## 📚 참고 자료

- [Avellaneda-Stoikov 논문](https://www.math.nyu.edu/faculty/avellane/HighFrequencyTrading.pdf)
- [Market Making 이론](https://stanford.edu/~ashishg/msande444/lectures/lecture13.pdf)
- [Risk Management Best Practices](https://www.risk.net/cutting-edge/banking/2419087/optimal-execution-algorithmic-trading)