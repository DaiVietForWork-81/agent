# Orbit — Multi-Agent Development Workspace

> Tên cũ: Multi-Agent Workspace. Lệnh gọn: `orb`.

Ứng dụng workspace cho phép giao việc lập trình bằng ngôn ngữ tự nhiên cho AI, với **2 chế độ**:

- **Normal** — đúng 1 model suy luận, tool-loop (đọc/ghi file, chạy lệnh, git) trong workspace có kiểm soát quyền.
- **Turbo** — nhiều model (2+) thảo luận, phản biện, tổng hợp plan, phân task theo DAG, chạy song song, review chéo, verification.

> **Attribution:** Design tokens (bảng màu, font, typography) của web UI và CLI được lấy từ
> [opencode](https://github.com/anomalyco/opencode) (MIT license) — file
> `packages/console/app/src/style/token/{color,font}.css`. Dự án này **không** do team OpenCode
> xây dựng và không liên kết với họ.

> Cảnh báo trung thực: phiên bản 0.1. Các tính năng được ghi dưới đây là những tính năng **đã có implementation + test**. Những phần chưa làm được liệt kê ở mục *Known limitations* — không tuyên bố quá sức thực tế.

## Chạy

```powershell
orb          # mở CLI từ bất kỳ terminal nào (đã đăng ký qua npm link)
# hoặc:
cd D:\agent
npm run cli  # CLI trực tiếp
npm start    # web UI tại http://localhost:7333
```

UI mở tại `http://localhost:7333` — dark theme, sidebar (projects/sessions), chat, tab Turbo, quản lý providers/agents/engines/settings.

## Test

```powershell
npm test        # 26 tests: providers (mock server), store, state machine, DAG, Normal, Turbo, HTTP API
npm run typecheck
```

Test dùng **mock server + stub adapter**, không gọi API trả phí. Chưa có bộ live-test API thật (cần user cấu hình key và chủ động bật).

## Cấu hình provider & API key

Tab **Providers & Models**:

1. Chọn provider (12 preset: OpenAI, Anthropic, NVIDIA NIM, DeepSeek, Groq, Together, OpenRouter, Mistral, xAI, Ollama, LM Studio, Custom OpenAI-compatible).
2. Dán API key → ứng dụng gọi model discovery (`GET /models` hoặc `/api/tags` của Ollama). Kết quả verify hiển thị thật — không bịa danh sách model.
3. Nếu discovery bị chặn: nhập Model ID thủ công → bấm *Test & Save* → chạy 1 request inference thật để xác minh (`inferenceOk`).
4. Model nào chưa verify inference sẽ hiển thị ⚠ trong selector, không được coi là sẵn sàng.

API endpoints tương đương: `POST /api/credentials`, `POST /api/models`, `POST /api/models/:id/verify`.

**Bảo mật key:** key lưu trong SQLite cục bộ (`data/madw.db`), **không bao giờ** trả nguyên文 qua API (chỉ masked), redact trong log/event/error. Chưa tích hợp OS credential manager (DPAPI/keyring) — xem limitations.

## Chọn agent engine

Tab **Engines**: bật/tắt, xem discovery thật (executable có tồn tại không), capabilities.

- `builtin` — tool-loop agent trong process: read/write/list file, run_command (allowlist), git status/diff, finish. Model đến từ model config của agent profile.
- `opencode` — chạy `opencode run <prompt>` trong project dir (subprocess, stream stdout). Engine này tự dùng model/key của OpenCode (`uses_own_model=true`).

Engine không được báo available nếu CLI/SDK không có trên máy.

## Agent profiles

Tab **Agents**: tạo profile (tên + roles: planner/architect/backend/frontend/designer/tester/reviewer/researcher/coder + model + engine). Turbo phân task theo role match; không match thì fallback agent đầu tiên.

## Normal mode flow

1. Tạo project (đường dẫn tuyệt đối) + session.
2. Chọn mode **Normal**, chọn đúng 1 model.
3. Gửi prompt → 1 task `coder` chạy qua engine: model nhận context (repo tree + yêu cầu), gọi tools để làm việc thật, kết thúc bằng `finish`.
4. Kết quả + file đổi được ghi vào session; run status `completed/failed`.

## Turbo mode flow (A→G)

1. **A — Phân tích**: model đầu đọc repo thật (tree + git status) → JSON goal/constraints/risks.
2. **B — Thảo luận**: mỗi model đề xuất độc lập (round 1), sau đó critique chéo các peer (round 2..maxDebateRounds). Kinh phí vòng lặp có bề trên (`budget.maxDebateRounds`, mặc định 2).
3. **C — Tổng hợp**: model điều phối synthesize JSON plan (goal, acceptance, tasks + deps). Validate: parse JSON (retry 1 lần), phát hiện dependency cycle → fail rõ ràng, không chọn mù theo model tự tin.
4. **D — Phân công**: task rows được tạo, map plan-id → task-id thật, remap deps, gán agent theo role.
5. **E — Thực thi song song**: DAG scheduler với `maxConcurrency` (mặc định 3), file-lock chống ghi đè cùng file, retry có budget (`maxRetriesPerTask`), task phụ thuộc failed → failed (không merge kết quả failed như thành công).
6. **F — Review chéo**: reviewer đọc **git diff thật** + task summaries → verdict pass/fail + findings. Fail → tạo repair task, lặp tối đa `maxRepairRounds`.
7. **G — Integration & verification**: chạy `verifyCommands` (settings, ví dụ `npm test`) → test report lưu vào run. Chỉ `completed` khi review pass + verify pass.

Turbo yêu cầu **≥ 2 model configs** — từ chối ở cả UI layer lẫn orchestrator.

## Anti-loop & cancellation & resume

- Budget: debate rounds, repair rounds, concurrency, steps/task (engine builtin 64), request timeout 120s, retry/task.
- `POST /api/runs/:id/cancel` — abort signal lan tới mọi task + subprocess.
- Restart server: run đang active được đánh dấu `interrupted` (không tự rerun side-effect). `POST /api/runs/:id/resume` re-queue task chưa hoàn tất rồi chạy tiếp review/integrate.
- `requireApprovalForTurboPlan` (settings): plan chờ duyệt → run `awaiting_approval` → approve mới thực thi.

## Kiến trúc

```
src/
  core.ts          ids, redact (secret), logger, EventBus, extractJson, timeout helper
  store.ts         types domain + SQLite persistence (node:sqlite, schema migrate, events)
  providers.ts     ProviderAdapter contract + OpenAI-compat/Anthropic/Ollama adapters +
                   registry + 12 preset + chuẩn hóa lỗi (auth/not_found/rate_limit/...)
  tools.ts         PermissionManager (read/write/delete/shell allowlist/workspaceOnly) +
                   fs/shell/git helpers + TOOL_SPECS cho model
  engines.ts       EngineAdapter contract (discover/validate/start_task/cancel) +
                   BuiltinEngine (model tool-loop) + OpenCodeEngine (CLI subprocess) + registry
  orchestrator.ts  task state machine (13 trạng thái, transition hợp lệ) + DAG scheduler +
                   NormalRunner + TurboRunner (A→G) + budget + resume
  api.ts           REST + SSE (node:http thuần), static UI
  index.ts         wiring + boot (mark interrupted runs)
public/            web UI (vanilla, dark)
test/              26 vitest tests (mock OpenAI server, stub adapters, e2e HTTP)
```

Nguyên tắc: provider/engine-specific code **chỉ** nằm trong adapter; orchestrator không biết wire format; UI không chứa logic điều phối; không hardcode model id.

## REST API nhanh

```
GET  /api/health
GET  /api/providers
POST /api/credentials         {provider, key, baseUrl?, label?}  -> verify + save
GET  /api/credentials
POST /api/models              {credentialId, modelId}            -> test inference + save
POST /api/models/:id/verify
POST /api/agents              {name, roles[], modelConfigId, engineId}
GET  /api/engines             POST /api/engines/:id/toggle {enabled}
POST /api/projects            {path}
POST /api/sessions            {projectId, title, mode}
POST /api/sessions/:id/runs   {prompt, mode, modelConfigIds[], agentProfileIds[]}
GET  /api/runs/:id            GET /api/runs/:id/tasks
GET  /api/runs/:id/events     (SSE)
POST /api/runs/:id/cancel     POST /api/runs/:id/resume   POST /api/runs/:id/approve
GET  /api/settings            PUT /api/settings
```

## Known limitations (thật, chưa làm)

- **Sandbox thực sự chưa có**: shell allowlist + workspaceOnly là kiểm soát quyền, không phải isolation mạnh (không container). Task thực thi code không tin cậy cần container riêng.
- **Credential chưa mã hóa DPAPI/keyring** — lưu SQLite cục bộ, masked mọi output. Nên hoàn thiện trước khi dùng key production.
- **Streaming token thật cho UI**: SSE đẩy event-level (tool calls, messages, run status); chat render theo message, chưa render từng token.
- **Anthropic streaming** hiện là one-shot (capability khai báo `partial` — đúng như vậy).
- **File-lock dựa trên danh sách file khai báo trong plan** — task không khai báo file có thể va chạm (chỉ ghi đè, không corrupt).
- **OpenDesign/OpenHands/OpenClaw chưa tích hợp** — engine registry + adapter contract đã sẵn sàng, chỉ mới có builtin + OpenCode CLI thật.
- **Discord notification chưa có.**
- **Benchmark suite (13.5) chưa dựng** — hiện chỉ có test suite; "training agent" hiện tại nghĩa là cải tiến prompt/skill/test, không phải fine-tuning weights.

## Lộ trình gợi ý (tiếp nối Phase 3-8)

1. Live provider test command có opt-in chi phí.
2. DPAPI/credential vault + revocation UI.
3. OpenHands SDK adapter (engine `sdk`), OpenClaw gateway adapter.
4. Container sandbox cho shell (Docker/podman optional).
5. Diff viewer trong UI, token streaming, benchmark harness + regression set.
