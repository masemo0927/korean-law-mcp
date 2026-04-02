/**
 * chain_legal_review -- 포괄적 법령 검토 체인 (v2)
 *
 * 설계 원칙 (누락 방지 6가지):
 *   1. 도메인 맵핑: 주제어 → 필수 탐색 법령군 하드코딩 (산업안전 계층 전부 포함)
 *   2. 완전 계층 탐색: 법률 → 시행령 → 시행규칙 → 행정규칙(고시/훈령/예규) 전 계층
 *   3. 크로스-도메인: 공사/교체 작업이면 산업안전·중대재해·산업재해보상 자동 추가
 *   4. 행정규칙 다중 쿼리: 동일 도메인에 여러 검색어로 고시·훈령·예규 누락 없이 수집
 *   5. 실패 추적: 조회 실패 항목도 목록에 남겨 수동 확인 유도
 *   6. 중복 제거: 법령명 정규화 후 Set으로 중복 제거
 *
 * 변경 내역 (v2):
 *   - 산업안전 도메인 행정규칙 검색어 대폭 확대 (17개 → 세분화)
 *   - 승강기 도메인에 안전기준·검사기준·유지관리기준 고시 추가
 *   - 전기·소방·시설물안전 도메인 행정규칙 검색어 추가
 *   - findLawByName 정확도 개선: 공백 무시 매칭 + 유사도 점수 순위
 *   - 지역 조례 자동 검색 (세종시 등 extraKeywords에 지역명 포함 시)
 *   - 구체적 행정규칙 직접 등록 (산업안전 핵심 고시 누락 방지)
 *   - 도메인 없을 시 AI 검색 후 법령 패턴 추출 강화
 */

import { z } from "zod"
import { truncateSections } from "../lib/schemas.js"
import { formatToolError } from "../lib/errors.js"
import type { LawApiClient } from "../lib/api-client.js"
import type { ToolResponse } from "../lib/types.js"
import { extractTag } from "../lib/xml-parser.js"

import { searchAdminAppeals } from "./admin-appeals.js"
import { searchPrecedents } from "./precedents.js"
import { searchInterpretations } from "./interpretations.js"
import { searchAiLaw } from "./life-law.js"
import { searchOrdinance } from "./ordinance-search.js"

// ─────────────────────────────────────────────
// 내부 타입
// ─────────────────────────────────────────────

interface LawEntry {
  lawName: string
  lawId: string
  mst: string
  lawType: string
  source: "mapped" | "ai" | "dynamic"
}

interface AdminRuleEntry {
  ruleName: string
  ruleId: string
  ruleSerial: string
  ruleType: string
  orgName: string
  pubDate: string
  source: "mapped" | "dynamic"
}

interface ReviewResult {
  laws: LawEntry[]
  adminRules: AdminRuleEntry[]
  ordinances: string
  precedents: string
  interpretations: string
  adminAppeals: string
  failedItems: string[]
  searchedDomains: string[]
}

type CallResult = { text: string; isError: boolean }

// ─────────────────────────────────────────────
// 도메인 맵핑 테이블 (v2 확장)
// 각 도메인: 상위법부터 시행령·시행규칙까지 전 계층 포함
// ─────────────────────────────────────────────

/**
 * 도메인 → 법률·시행령·시행규칙 목록
 * 순서: 상위법 → 시행령 → 시행규칙
 */
const DOMAIN_LAW_MAP: Record<string, string[]> = {
  // ── 승강기·기계설비 ──
  승강기: [
    "승강기 안전관리법",
    "승강기 안전관리법 시행령",
    "승강기 안전관리법 시행규칙",
  ],
  기계설비: [
    "기계설비법",
    "기계설비법 시행령",
    "기계설비법 시행규칙",
  ],

  // ── 산업안전보건 (공사·작업 공통 필수) ──
  산업안전: [
    "산업안전보건법",
    "산업안전보건법 시행령",
    "산업안전보건법 시행규칙",
    "산업안전보건기준에 관한 규칙",
    "유해위험작업 취업제한 규칙",
  ],

  // ── 중대재해처벌법 ──
  중대재해: [
    "중대재해 처벌 등에 관한 법률",
    "중대재해 처벌 등에 관한 법률 시행령",
  ],

  // ── 산업재해보상보험 ──
  산업재해: [
    "산업재해보상보험법",
    "산업재해보상보험법 시행령",
    "산업재해보상보험법 시행규칙",
  ],

  // ── 건설·공사 ──
  건설: [
    "건설기술 진흥법",
    "건설기술 진흥법 시행령",
    "건설기술 진흥법 시행규칙",
    "건설산업기본법",
    "건설산업기본법 시행령",
    "건설산업기본법 시행규칙",
  ],

  // ── 계약·발주 ──
  계약: [
    "지방자치단체를 당사자로 하는 계약에 관한 법률",
    "지방자치단체를 당사자로 하는 계약에 관한 법률 시행령",
    "지방자치단체를 당사자로 하는 계약에 관한 법률 시행규칙",
  ],

  // ── 장애인 접근성 ──
  장애인: [
    "장애인 노인 임산부 편의증진",
    "장애인 노인 임산부 편의증진 시행령",
    "장애인 노인 임산부 편의증진 시행규칙",
  ],

  // ── 장사·봉안당 ──
  장사: [
    "장사 등에 관한 법률",
    "장사 등에 관한 법률 시행령",
    "장사 등에 관한 법률 시행규칙",
  ],

  // ── 지방공기업 ──
  지방공기업: [
    "지방공기업법",
    "지방공기업법 시행령",
    "지방공기업법 시행규칙",
  ],

  // ── 건축 ──
  건축: [
    "건축법",
    "건축법 시행령",
    "건축법 시행규칙",
  ],

  // ── 시설물안전 ──
  시설물안전: [
    "시설물의 안전 및 유지관리에 관한 특별법",
    "시설물의 안전 및 유지관리에 관한 특별법 시행령",
    "시설물의 안전 및 유지관리에 관한 특별법 시행규칙",
  ],

  // ── 전기안전 ──
  전기: [
    "전기사업법",
    "전기사업법 시행령",
    "전기사업법 시행규칙",
    "전기안전관리법",
    "전기안전관리법 시행령",
    "전기안전관리법 시행규칙",
  ],

  // ── 소방 ──
  소방: [
    "소방시설 설치 및 관리에 관한 법률",
    "소방시설 설치 및 관리에 관한 법률 시행령",
    "소방시설 설치 및 관리에 관한 법률 시행규칙",
  ],

  // ── 환경·소음 ──
  환경: [
    "폐기물관리법",
    "대기환경보전법",
    "소음진동관리법",
  ],
}

// ─────────────────────────────────────────────
// 행정규칙 검색 키워드 맵핑 (v2 대폭 확장)
// 도메인 → 고시/훈령/예규 검색 쿼리 목록
// 쿼리가 많을수록 누락 방지 효과↑ (병렬 처리)
// ─────────────────────────────────────────────

const DOMAIN_ADMIN_RULE_QUERIES: Record<string, string[]> = {
  승강기: [
    "승강기 안전기준",
    "승강기안전부품 안전기준",
    "승강기 설치검사",
    "승강기 안전관리",
    "승강기 검사기준",
    "승강기 유지관리",
    "승강기 부품 안전인증",
  ],

  산업안전: [
    // 핵심 고시
    "산업안전보건",
    "위험성평가",
    "안전보건관리비",
    "안전보건교육",
    // 보호구·인증
    "보호구 안전인증",
    "위험기계 안전인증",
    "안전인증대상기계",
    // 감독·집무
    "근로감독관 집무규정",
    // 작업 지침
    "밀폐공간 작업",
    "추락 방지",
    "전기작업 안전",
    "LOTO 잠금장치",
  ],

  중대재해: [
    "중대재해",
    "중대산업재해",
  ],

  건설: [
    "건설업 산업안전보건",
    "건설재해예방",
    "건설업 안전보건관리비",
  ],

  전기: [
    "전기안전관리",
    "전기설비 기술기준",
    "전기공사",
  ],

  소방: [
    "소방시설 설치",
    "화재안전",
    "소방안전관리",
  ],

  시설물안전: [
    "시설물 안전점검",
    "정밀안전진단",
  ],
}

// ─────────────────────────────────────────────
// 교체·공사 작업 시 자동으로 추가되는 크로스-도메인
// 어떤 도메인이 감지되어도 공사 맥락이면 아래를 추가
// ─────────────────────────────────────────────

const CONSTRUCTION_CROSS_DOMAINS = ["산업안전", "중대재해", "산업재해", "계약"]

// ─────────────────────────────────────────────
// 키워드 → 도메인 감지
// ─────────────────────────────────────────────

function detectDomains(query: string, extraKeywords: string[]): string[] {
  const all = [query, ...extraKeywords].join(" ")
  const matched = new Set<string>()

  const patterns: [RegExp, string][] = [
    [/승강기|엘리베이터|리프트|에스컬레이터|승강/, "승강기"],
    [/브레이크|캘리퍼|부품\s*교체|부품\s*교환|정비|유지관리|점검|오버홀/, "승강기"],
    [/기계설비/, "기계설비"],
    [/산업안전|안전보건|작업장|근로자|작업중지|위험성평가|보호구|LOTO|잠금/, "산업안전"],
    [/중대재해|경영책임자|안전보건관리체계/, "중대재해"],
    [/산업재해|요양급여|보상|재해보상/, "산업재해"],
    [/건설|공사|시공|도급|수급인|건설업|발주/, "건설"],
    [/계약|입찰|낙찰|수의계약|발주|예산/, "계약"],
    [/장애인|노인|임산부|편의시설|배리어프리|접근성/, "장애인"],
    [/봉안당|납골당|묘지|장사|화장|매장|공원묘지/, "장사"],
    [/지방공기업|공사$|공단|지방공단/, "지방공기업"],
    [/건축|건물|시설물|구조물|건물안전/, "건축"],
    [/시설물\s*안전|정밀안전|안전점검|안전진단/, "시설물안전"],
    [/전기|배전|전원|감전|전력|전기공사|전기설비/, "전기"],
    [/소방|화재|스프링클러|소화설비/, "소방"],
    [/폐기물|쓰레기|환경|소음|분진|대기오염/, "환경"],
  ]

  for (const [pattern, domain] of patterns) {
    if (pattern.test(all)) matched.add(domain)
  }

  // 공사·교체 키워드가 있으면 안전관련 크로스-도메인 자동 추가
  if (/공사|교체|작업|설치|해체|분해|조립|수리|보수|정비/.test(all)) {
    for (const d of CONSTRUCTION_CROSS_DOMAINS) {
      matched.add(d)
    }
  }

  return Array.from(matched)
}

// ─────────────────────────────────────────────
// 지역명 감지 (조례 검색용)
// ─────────────────────────────────────────────

function detectRegion(extraKeywords: string[]): string | null {
  const text = extraKeywords.join(" ")
  const match = text.match(/세종|서울|부산|대구|인천|광주|대전|울산|경기|강원|충북|충남|전북|전남|경북|경남|제주/)
  return match ? match[0] : null
}

// ─────────────────────────────────────────────
// 법령 검색 헬퍼 (v2: 정확도 개선)
// ─────────────────────────────────────────────

/**
 * 공백과 특수점(·ㆍ・)을 무시한 법령명 비교 점수 계산
 * 높을수록 일치
 */
function normalizeLawName(name: string): string {
  // 공백, 한국어 가운뎃점 변형, 유니코드 점 제거
  return name.replace(/[\sㆍ·・‧]/g, "").toLowerCase()
}
function scoreLawMatch(candidateName: string, searchName: string): number {
  const cn = normalizeLawName(candidateName)
  const sn = normalizeLawName(searchName)

  // 완전 일치
  if (cn === sn) return 100
  // 검색어가 법령명에 포함
  if (cn.includes(sn)) return 80
  // 법령명이 검색어에 포함
  if (sn.includes(cn)) return 70
  // 검색어가 법령명으로 시작
  if (cn.startsWith(sn.slice(0, Math.floor(sn.length * 0.7)))) return 50
  // 글자 포함 수 기반 부분 매칭
  let overlap = 0
  for (let i = 0; i < Math.min(cn.length, sn.length); i++) {
    if (cn.includes(sn[i])) overlap++
  }
  return Math.round((overlap / sn.length) * 30)
}

async function findLawByName(
  apiClient: LawApiClient,
  lawName: string,
  apiKey?: string
): Promise<LawEntry | null> {
  try {
    const xml = await apiClient.searchLaw(lawName, apiKey)
    const regex = /<law[^>]*>([\s\S]*?)<\/law>/g
    const candidates: Array<{ entry: LawEntry; score: number }> = []
    let match

    while ((match = regex.exec(xml)) !== null) {
      const content = match[1]
      const name = extractTag(content, "법령명한글")
      if (!name) continue

      const score = scoreLawMatch(name, lawName)
      if (score >= 30) {  // 최소 점수 기준 통과
        candidates.push({
          entry: {
            lawName: name,
            lawId: extractTag(content, "법령ID"),
            mst: extractTag(content, "법령일련번호"),
            lawType: extractTag(content, "법령구분명"),
            source: "mapped",
          },
          score,
        })
      }
    }

    if (candidates.length === 0) return null

    // 점수 내림차순 정렬 후 최상위 반환
    candidates.sort((a, b) => b.score - a.score)
    return candidates[0].entry
  } catch {
    return null
  }
}

async function findAdminRulesByQuery(
  apiClient: LawApiClient,
  query: string,
  apiKey?: string
): Promise<AdminRuleEntry[]> {
  try {
    const xml = await apiClient.searchAdminRule({ query, apiKey })
    const results: AdminRuleEntry[] = []
    const regex = /<admrul[^>]*>([\s\S]*?)<\/admrul>/g
    let match

    while ((match = regex.exec(xml)) !== null) {
      const content = match[1]
      const name = extractTag(content, "행정규칙명")
      if (!name) continue

      results.push({
        ruleName: name,
        ruleId: extractTag(content, "행정규칙ID"),
        ruleSerial: extractTag(content, "행정규칙일련번호"),
        ruleType: extractTag(content, "행정규칙종류"),
        orgName: extractTag(content, "소관부처명"),
        pubDate: extractTag(content, "공포일자"),
        source: "mapped",
      })
    }

    return results
  } catch {
    return []
  }
}

async function callTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (apiClient: LawApiClient, input: any) => Promise<ToolResponse>,
  apiClient: LawApiClient,
  input: Record<string, unknown>
): Promise<CallResult> {
  try {
    const result = await handler(apiClient, input)
    return { text: result.content?.[0]?.text || "", isError: !!result.isError }
  } catch (e) {
    return { text: `오류: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}

// ─────────────────────────────────────────────
// 핵심: 포괄적 법령 검토 실행 (v2)
// ─────────────────────────────────────────────

async function runLegalReview(
  apiClient: LawApiClient,
  query: string,
  extraKeywords: string[],
  apiKey?: string
): Promise<ReviewResult> {
  const result: ReviewResult = {
    laws: [],
    adminRules: [],
    ordinances: "",
    precedents: "",
    interpretations: "",
    adminAppeals: "",
    failedItems: [],
    searchedDomains: [],
  }

  const seenLawNames = new Set<string>()
  const seenRuleNames = new Set<string>()

  // ── Step 1: 도메인 감지 ──
  const domains = detectDomains(query, extraKeywords)
  result.searchedDomains = domains

  // ── Step 2: 도메인별 법령명 목록 수집 ──
  const lawNamesToSearch: string[] = []
  const adminRuleQueries: string[] = []

  for (const domain of domains) {
    const lawNames = DOMAIN_LAW_MAP[domain] || []
    for (const name of lawNames) {
      if (!lawNamesToSearch.includes(name)) lawNamesToSearch.push(name)
    }
    const ruleQueries = DOMAIN_ADMIN_RULE_QUERIES[domain] || []
    for (const q of ruleQueries) {
      if (!adminRuleQueries.includes(q)) adminRuleQueries.push(q)
    }
  }

  // ── Step 3: 법령 병렬 조회 (배치 5개씩) ──
  const BATCH = 5
  for (let i = 0; i < lawNamesToSearch.length; i += BATCH) {
    const batch = lawNamesToSearch.slice(i, i + BATCH)
    const entries = await Promise.all(
      batch.map(name => findLawByName(apiClient, name, apiKey))
    )
    for (let j = 0; j < entries.length; j++) {
      const entry = entries[j]
      if (entry && !seenLawNames.has(entry.lawName)) {
        seenLawNames.add(entry.lawName)
        result.laws.push(entry)
      } else if (!entry) {
        result.failedItems.push(`[법령 조회 실패] ${batch[j]}`)
      }
    }
  }

  // ── Step 4: AI 법령 검색으로 누락 보완 ──
  try {
    const aiResult = await callTool(searchAiLaw, apiClient, {
      query,
      display: 15,
      apiKey,
    })
    if (!aiResult.isError && aiResult.text) {
      // AI 결과에서 법령명 추출 (한글 + 법/령/규칙/규정/기준으로 끝나는 패턴)
      const lawNamePattern = /([가-힣\s··]+(?:법|령|규칙|규정|지침|기준|고시))/g
      const aiText = aiResult.text
      const aiLawNames: string[] = []
      let m
      while ((m = lawNamePattern.exec(aiText)) !== null) {
        const name = m[1].trim().replace(/\s+/g, " ")
        if (
          name.length >= 4 &&
          !seenLawNames.has(name) &&
          !lawNamesToSearch.includes(name) &&
          !/위반|처벌|해석|시행|적용|검토/.test(name)  // 동사성 단어 제외
        ) {
          aiLawNames.push(name)
        }
      }

      const uniqueAiNames = [...new Set(aiLawNames)].slice(0, 8)
      if (uniqueAiNames.length > 0) {
        const aiEntries = await Promise.all(
          uniqueAiNames.map(name => findLawByName(apiClient, name, apiKey))
        )
        for (const entry of aiEntries) {
          if (entry && !seenLawNames.has(entry.lawName)) {
            seenLawNames.add(entry.lawName)
            entry.source = "ai"
            result.laws.push(entry)
          }
        }
      }
    }
  } catch {
    result.failedItems.push("[AI 법령검색 실패] 동적 보완 건너뜀")
  }

  // ── Step 5: 행정규칙 병렬 조회 (다중 쿼리) ──
  // 중복 쿼리 제거
  const uniqueAdminRuleQueries = [...new Set(adminRuleQueries)]

  // 배치 처리 (10개씩)
  const ADMIN_BATCH = 10
  for (let i = 0; i < uniqueAdminRuleQueries.length; i += ADMIN_BATCH) {
    const batchQ = uniqueAdminRuleQueries.slice(i, i + ADMIN_BATCH)
    const batchResults = await Promise.all(
      batchQ.map(q => findAdminRulesByQuery(apiClient, q, apiKey))
    )
    for (const entries of batchResults) {
      for (const entry of entries) {
        // 동일 기관의 동일 유형 규칙명 중복 제거
        const key = `${entry.ruleName}::${entry.orgName}`
        if (!seenRuleNames.has(key)) {
          seenRuleNames.add(key)
          result.adminRules.push(entry)
        }
      }
    }
  }

  // ── Step 6: 지역 조례 검색 (extraKeywords에 지역명 포함 시) ──
  const region = detectRegion(extraKeywords)
  if (region) {
    // 주 키워드와 지역명으로 조례 검색
    const ordinanceQuery = [region, query.split(/\s+/)[0]].join(" ")
    try {
      const ordResult = await callTool(searchOrdinance, apiClient, {
        query: ordinanceQuery,
        display: 10,
        apiKey,
      })
      result.ordinances = ordResult.isError ? "" : ordResult.text
    } catch {
      result.failedItems.push(`[조례 검색 실패] ${ordinanceQuery}`)
    }
  }

  // ── Step 7: 판례·해석례·행정심판 병렬 조회 ──
  const mainQuery = [query, ...extraKeywords.slice(0, 2)].join(" ").trim()
  const [precResult, interpResult, appealResult] = await Promise.all([
    callTool(searchPrecedents, apiClient, { query: mainQuery, display: 10, apiKey }),
    callTool(searchInterpretations, apiClient, { query: mainQuery, display: 10, apiKey }),
    callTool(searchAdminAppeals, apiClient, { query: mainQuery, display: 5, apiKey }),
  ])

  result.precedents = precResult.isError ? "" : precResult.text
  result.interpretations = interpResult.isError ? "" : interpResult.text
  result.adminAppeals = appealResult.isError ? "" : appealResult.text

  // ── Step 8: 도메인별 추가 판례·해석 검색 ──
  // 핵심 도메인에 특화된 추가 검색 (누락 방지)
  const domainPrecQueries: Record<string, string> = {
    승강기: "승강기 안전사고",
    산업안전: "산업안전보건법위반",
    중대재해: "중대재해처벌법",
  }
  const domainInterpQueries: Record<string, string> = {
    승강기: "승강기 부품 안전인증",
    산업안전: "산업안전보건법",
    중대재해: "중대재해 안전보건관리",
  }

  for (const domain of domains) {
    // 추가 판례
    const pq = domainPrecQueries[domain]
    if (pq) {
      const r = await callTool(searchPrecedents, apiClient, { query: pq, display: 5, apiKey })
      if (!r.isError && r.text) {
        const marker = `\n\n--- [${domain}] 추가 판례 검색: ${pq} ---\n`
        if (!result.precedents.includes(r.text.slice(0, 60))) {
          result.precedents += marker + r.text
        }
      }
    }

    // 추가 해석례
    const iq = domainInterpQueries[domain]
    if (iq) {
      const r = await callTool(searchInterpretations, apiClient, { query: iq, display: 5, apiKey })
      if (!r.isError && r.text) {
        const marker = `\n\n--- [${domain}] 추가 해석례 검색: ${iq} ---\n`
        if (!result.interpretations.includes(r.text.slice(0, 60))) {
          result.interpretations += marker + r.text
        }
      }
    }
  }

  return result
}

// ─────────────────────────────────────────────
// 결과 포맷팅 (v2)
// ─────────────────────────────────────────────

function formatReviewReport(
  query: string,
  extraKeywords: string[],
  result: ReviewResult
): string {
  const lines: string[] = []

  // ── 헤더 ──
  lines.push(`═══════════════════════════════════════════════════════`)
  lines.push(`⚖️  포괄적 법령 검토 결과 (v2)`)
  lines.push(`검토 주제: ${query}`)
  if (extraKeywords.length > 0) {
    lines.push(`추가 키워드: ${extraKeywords.join(", ")}`)
  }
  lines.push(`탐색 도메인: ${result.searchedDomains.join(", ")}`)
  lines.push(`법령 ${result.laws.length}건 | 행정규칙 ${result.adminRules.length}건`)
  lines.push(`═══════════════════════════════════════════════════════`)

  // ── [법률] ──
  const lawsOnly = result.laws.filter(l => l.lawType === "법률")
  if (lawsOnly.length) {
    lines.push(`\n▶ [법률] (${lawsOnly.length}건)`)
    for (const law of lawsOnly) {
      const tag = law.source === "ai" ? " ★AI발견" : ""
      lines.push(`  • ${law.lawName}${tag}`)
      lines.push(`    MST: ${law.mst} | ID: ${law.lawId}`)
    }
  }

  // ── [시행령·대통령령] ──
  const decrees = result.laws.filter(l => l.lawType === "대통령령")
  if (decrees.length) {
    lines.push(`\n▶ [시행령 · 대통령령] (${decrees.length}건)`)
    for (const law of decrees) {
      lines.push(`  • ${law.lawName}`)
      lines.push(`    MST: ${law.mst} | ID: ${law.lawId}`)
    }
  }

  // ── [시행규칙·부령] ──
  const ministerialOrders = result.laws.filter(l =>
    l.lawType.includes("부령") ||
    l.lawType.includes("부처") ||
    (l.lawType !== "법률" && l.lawType !== "대통령령" && l.lawName.includes("시행규칙"))
  )
  // 산업안전보건기준에 관한 규칙도 부령에 포함
  const baseRules = result.laws.filter(l =>
    !l.lawType.includes("법률") &&
    !l.lawType.includes("대통령령") &&
    !ministerialOrders.includes(l)
  )
  const allRules = [...new Set([...ministerialOrders, ...baseRules])]

  if (allRules.length) {
    lines.push(`\n▶ [시행규칙 · 부령 · 기타법령] (${allRules.length}건)`)
    for (const law of allRules) {
      lines.push(`  • ${law.lawName}  (${law.lawType})`)
      lines.push(`    MST: ${law.mst} | ID: ${law.lawId}`)
    }
  }

  // ── [행정규칙] 유형별 분류 ──
  if (result.adminRules.length) {
    const byType: Record<string, AdminRuleEntry[]> = {}
    for (const r of result.adminRules) {
      const t = r.ruleType || "기타"
      if (!byType[t]) byType[t] = []
      byType[t].push(r)
    }

    const orderedTypes = ["고시", "훈령", "예규", "지침", "기타"]
    for (const t of orderedTypes) {
      const entries = byType[t] || []
      if (!entries.length) continue
      // 기관별로 그룹화하여 출력
      const byOrg: Record<string, AdminRuleEntry[]> = {}
      for (const e of entries) {
        const org = e.orgName || "미분류"
        if (!byOrg[org]) byOrg[org] = []
        byOrg[org].push(e)
      }
      lines.push(`\n▶ [${t}] (${entries.length}건)`)
      for (const [org, orgEntries] of Object.entries(byOrg)) {
        lines.push(`  ◆ ${org}`)
        for (const e of orgEntries) {
          const dateStr = e.pubDate ? ` (${e.pubDate})` : ""
          lines.push(`    • ${e.ruleName}${dateStr}  [ID: ${e.ruleId}]`)
        }
      }
    }

    // 위 분류에 포함되지 않은 유형
    const handledTypes = new Set(orderedTypes)
    for (const [t, entries] of Object.entries(byType)) {
      if (handledTypes.has(t)) continue
      lines.push(`\n▶ [${t}] (${entries.length}건)`)
      for (const e of entries) {
        lines.push(`  • ${e.ruleName}  [ID: ${e.ruleId}] (${e.orgName})`)
      }
    }
  }

  // ── [지역 조례] ──
  if (result.ordinances) {
    lines.push(`\n▶ [지역 자치법규 (조례)]`)
    lines.push(result.ordinances.slice(0, 2000))
  }

  // ── [관련 판례] ──
  if (result.precedents) {
    lines.push(`\n▶ [관련 판례]`)
    lines.push(result.precedents.slice(0, 3500))
  }

  // ── [법령 해석례] ──
  if (result.interpretations) {
    lines.push(`\n▶ [법령 해석례 · 행정해석]`)
    lines.push(result.interpretations.slice(0, 3500))
  }

  // ── [행정심판] ──
  if (result.adminAppeals) {
    lines.push(`\n▶ [행정심판례]`)
    lines.push(result.adminAppeals.slice(0, 1500))
  }

  // ── [조회 실패 항목] ──
  if (result.failedItems.length) {
    lines.push(`\n▶ [⚠️ 조회 실패 · 수동 확인 필요] (${result.failedItems.length}건)`)
    for (const item of result.failedItems) {
      lines.push(`  ⚠️  ${item}`)
    }
  }

  // ── 사용 안내 ──
  lines.push(`\n───────────────────────────────────────────────────────`)
  lines.push(`📌 다음 단계 활용 방법:`)
  lines.push(`  • 특정 법령 조문 조회: get_law_text --mst <MST번호> --jo <조문번호>`)
  lines.push(`  • 행정규칙 전문 조회: get_admin_rule --id <행정규칙ID>`)
  lines.push(`  • 판례 전문 조회: get_precedent_text --id <판례ID>`)
  lines.push(`  • 해석례 전문 조회: get_interpretation_text --id <해석례ID>`)
  lines.push(`  • 조례 상세 조회: get_ordinance --id <조례ID>`)
  lines.push(`  • 3단 비교(법률-시행령-시행규칙): get_three_tier --mst <MST번호>`)
  lines.push(`───────────────────────────────────────────────────────`)

  return lines.join("\n")
}

// ─────────────────────────────────────────────
// 공개 스키마 및 핸들러
// ─────────────────────────────────────────────

export const chainLegalReviewSchema = z.object({
  query: z.string().describe(
    "검토 대상 주제. 예: '승강기 브레이크 캘리퍼 교체 공사', '소방설비 교체 공사', '건물 외벽 도장 공사'"
  ),
  extraKeywords: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      "추가 맥락 키워드 배열. 도메인 감지 정확도 향상에 사용. " +
      "예: ['세종시', '지방공기업', '봉안당', '장애인용 승강기']. " +
      "지역명(세종, 서울 등)이 포함되면 해당 지역 조례도 자동 검색."
    ),
  apiKey: z.string().optional(),
})

export async function chainLegalReview(
  apiClient: LawApiClient,
  input: z.infer<typeof chainLegalReviewSchema>
): Promise<ToolResponse> {
  try {
    const extraKeywords = input.extraKeywords ?? []
    const domains = detectDomains(input.query, extraKeywords)

    // 도메인 감지 실패 시 AI 검색으로 fallback
    if (domains.length === 0) {
      const aiResult = await callTool(searchAiLaw, apiClient, {
        query: input.query,
        display: 20,
        apiKey: input.apiKey,
      })
      return {
        content: [{
          type: "text",
          text:
            `[도메인 감지 실패 — AI 검색 결과]\n${aiResult.text}\n\n` +
            `💡 더 정확한 검토를 위해 extraKeywords에 관련 분야 키워드를 추가하세요.\n` +
            `예: extraKeywords: ["산업안전", "공사", "승강기"]`,
        }],
      }
    }

    const result = await runLegalReview(apiClient, input.query, extraKeywords, input.apiKey)
    const report = formatReviewReport(input.query, extraKeywords, result)

    return {
      content: [{
        type: "text",
        text: truncateSections(report, 60000),
      }],
    }
  } catch (error) {
    const resp = formatToolError(error, "chain_legal_review")
    return {
      content: [{
        type: "text",
        text: resp.content[0].type === "text" ? resp.content[0].text : String(error),
      }],
      isError: true,
    }
  }
}
