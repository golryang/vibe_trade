# 💰 StoikovBot 자금 설정 가이드

## 1. 기본 자금 개념

### 📊 주요 자금 파라미터

| 파라미터 | 설명 | 권장값 | 예시 |
|---------|------|--------|------|
| **maxInventoryPct** | 최대 인벤토리 비율 (NAV 대비) | 2-10% | 5% |
| **maxPosition** | 최대 포지션 크기 (USDT) | 계좌 잔액의 10-20% | 1000 USDT |
| **dailyLossLimit** | 일일 손실 한도 (USDT) | 계좌 잔액의 1-5% | 500 USDT |
| **maxDrawdown** | 최대 손실률 | 3-10% | 5% |

## 2. 계좌 잔액별 권장 설정

### 💸 소액 계좌 (1,000 - 10,000 USDT)

```json
{
  "parameters": {
    "maxInventoryPct": 2,           // 2% 낮은 위험
    "alphaSizeRatio": 0.5          // 작은 사이즈 50%
  },
  "riskLimits": {
    "maxPosition": 200,            // 200 USDT
    "dailyLossLimit": 50,          // 50 USDT/일
    "maxDrawdown": 0.03            // 3%
  }
}
```

### 💰 중간 계좌 (10,000 - 100,000 USDT)

```json
{
  "parameters": {
    "maxInventoryPct": 5,           // 5% 권장값
    "alphaSizeRatio": 0.8          // 일반 사이즈 80%
  },
  "riskLimits": {
    "maxPosition": 2000,           // 2,000 USDT
    "dailyLossLimit": 500,         // 500 USDT/일
    "maxDrawdown": 0.05            // 5%
  }
}
```

### 🏦 대형 계좌 (100,000+ USDT)

```json
{
  "parameters": {
    "maxInventoryPct": 8,           // 8% 적극적
    "alphaSizeRatio": 1.0          // 풀 사이즈 100%
  },
  "riskLimits": {
    "maxPosition": 10000,          // 10,000 USDT
    "dailyLossLimit": 2000,        // 2,000 USDT/일
    "maxDrawdown": 0.08            // 8%
  }
}
```

## 3. 거래량 기반 사이즈 계산

### 📈 주문 사이즈 계산 공식

```
기본 주문 사이즈 = (계좌 잔액 × maxInventoryPct × alphaSizeRatio) / ladderLevels
```

#### 예시 계산 (10,000 USDT 계좌):
- 계좌 잔액: 10,000 USDT
- maxInventoryPct: 5% 
- alphaSizeRatio: 0.8
- ladderLevels: 2

```
주문 사이즈 = (10,000 × 0.05 × 0.8) / 2 = 200 USDT
```

## 4. 심볼별 권장 설정

### ⚡ 고변동성 심볼 (BTC, ETH)
```json
{
  "gamma": 0.8,              // 높은 위험 회피
  "maxInventoryPct": 3,      // 낮은 인벤토리
  "driftCutBps": 3          // 타이트한 드리프트 컷
}
```

### 📊 중변동성 심볼 (주요 알트코인)
```json
{
  "gamma": 0.6,              // 표준 위험 회피
  "maxInventoryPct": 5,      // 표준 인벤토리
  "driftCutBps": 5          // 표준 드리프트 컷
}
```

### 🔄 저변동성 심볼 (스테이블코인 페어)
```json
{
  "gamma": 0.4,              // 낮은 위험 회피
  "maxInventoryPct": 10,     // 높은 인벤토리
  "driftCutBps": 8          // 넓은 드리프트 컷
}
```

## 5. 실전 설정 예시

### 🎯 보수적 설정 (초보자용)
```json
{
  "parameters": {
    "gamma": 0.8,
    "maxInventoryPct": 2,
    "ttlMs": 1000,
    "repostMs": 300,
    "ladderLevels": 1,
    "alphaSizeRatio": 0.5,
    "driftCutBps": 3,
    "sessionDDLimitPct": 0.3
  },
  "riskLimits": {
    "maxPosition": 100,         // 작은 포지션
    "dailyLossLimit": 50,       // 작은 손실 한도
    "maxDrawdown": 0.02         // 2% 드로우다운
  }
}
```

### ⚡ 공격적 설정 (고수용)
```json
{
  "parameters": {
    "gamma": 0.4,
    "maxInventoryPct": 8,
    "ttlMs": 500,
    "repostMs": 100,
    "ladderLevels": 3,
    "alphaSizeRatio": 1.0,
    "driftCutBps": 8,
    "sessionDDLimitPct": 1.0
  },
  "riskLimits": {
    "maxPosition": 5000,        // 큰 포지션
    "dailyLossLimit": 1000,     // 큰 손실 한도
    "maxDrawdown": 0.08         // 8% 드로우다운
  }
}
```

## 6. 시작 권장사항

### 🚀 처음 시작할 때
1. **소액으로 시작**: 100-1000 USDT
2. **보수적 설정**: gamma 0.8, maxInventoryPct 2%
3. **테스트넷 먼저**: Binance 테스트넷에서 충분히 테스트
4. **점진적 증가**: 성능 확인 후 점차 자금 증가

### 📊 모니터링 포인트
- **일일 PnL**: 목표 손실 한도 내 유지
- **인벤토리 변동**: maxInventoryPct 초과 여부
- **Fill Ratio**: 40% 이상 유지
- **유효 스프레드**: 3-10bp 범위

## 7. 긴급 상황 대처

### 🚨 손실 확대 시
```json
{
  "sessionDDLimitPct": 0.2,     // 0.2% 도달 시 자동 정지
  "maxConsecutiveFails": 5,     // 5회 연속 실패 시 정지
  "enableEmergencyStop": true   // 긴급 정지 활성화
}
```

### 🔧 실시간 조정
- **변동성 증가**: gamma 값 증가 (0.6 → 0.8)
- **거래량 감소**: alphaSizeRatio 감소 (0.8 → 0.5)
- **스프레드 축소**: postOnlyOffset 감소

---

💡 **팁**: 테스트넷에서 충분히 테스트한 후 실제 자금으로 시작하세요!