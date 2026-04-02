#!/usr/bin/env node

/**
 * Korean Law MCP Server
 * 국가법령정보센터 API 기반 MCP 서버
 */

import { config } from "dotenv"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { LawApiClient } from "./lib/api-client.js"
import { registerTools } from "./tool-registry.js"
import { startHTTPServer } from "./server/http-server.js"
import { VERSION } from "./version.js"

// .env 파일 로드 (환경변수 우선, .env는 폴백, 로그 출력 억제)
config({ quiet: true })

// API 클라이언트 초기화 (환경변수 → .env → 기본 키 순서)
const LAW_OC = process.env.LAW_OC || "leeseungback_0927"
const apiClient = new LawApiClient({ apiKey: LAW_OC })

// MCP 서버 팩토리 (HTTP 모드: 세션마다 새 인스턴스 필요)
function createServer(): Server {
  const s = new Server(
    { name: "korean-law", version: VERSION },
    { capabilities: { tools: {} } }
  )
  registerTools(s, apiClient)
  return s
}

// 서버 시작
async function main() {
  const args = process.argv.slice(2)
  const modeIndex = args.indexOf("--mode")
  const mode = modeIndex !== -1 ? args[modeIndex + 1] : "stdio"
  const portIndex = args.indexOf("--port")
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 8000

  if (mode === "http" || mode === "sse") {
    await startHTTPServer(createServer, port)
  } else {
    // STDIO 모드 (기본)
    const server = createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }
}

main().catch((error) => {
  console.error("Server error:", error)
  process.exit(1)
})
