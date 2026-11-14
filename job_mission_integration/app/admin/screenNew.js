/* 새 미션 만들기: 직업 → 하는 일 문장 → 생성 설정(능력단위, 난이도, 검수)을 골라 생성을 시작한다.
   시안의 화면 1(고르기)을 옮긴 것이다. 화면에 넣는 값은 모두 esc()를 거친다. */
import { esc } from "../common/site.js";
import { adminApi } from "./api.js";
import {
  BLOCKED_REASON_TEXT,
  DIFFICULTY_HINTS,
  DIFFICULTY_LABELS,
  errorText,
  estimateText,
  materialTypesText
} from "./labels.js";
import { emptyLine, errorLine, errorMessage, icon, loadingLine } from "./shell.js";

const DIFFICULTIES = ["easy", "normal", "hard"];
const LINK_BADGE = { "직접": "badge ok", "분야 한정": "badge warn" };   // 서버가 주는 연결 표시(한국어 글자 그대로)

const own = (table, key) => (typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

export function mount(view, ctx) {
  ctx.setCrumb("새 미션 만들기", "고르기");

  const state = {
    jobs: null,              // GET /jobs의 jobs[]. null이면 받는 중
    jobsError: null,
    query: "",
    jobCode: null,           // 고른 직업
    sentences: null,         // 고른 직업의 sentences[]. null이면 받는 중
    sentencesError: null,
    execJobId: null,         // 고른 문장
    unitKey: null,           // 고른 능력단위
    difficulty: "normal",
    review: true,
    reasonOpen: false,       // "연결 근거"를 펼쳤나
    material: { state: "none", text: "" },   // none | loading | ok | error
    statusReady: false,      // 화면을 붙인 뒤 /status를 한 번 새로 받았나
    starting: false,         // POST /runs 응답을 기다리는 중
    startError: null         // { message, runId }
  };
  let sentenceSeq = 0;       // 늦게 온 응답을 버리려고 요청마다 번호를 올린다
  let materialSeq = 0;
  let pollTimer = null;      // 도는 실행이 있는 동안 상태를 다시 묻는 타이머(하나만)
  let disposed = false;      // 정리 함수가 불렸나

  view.innerHTML = `<div class="pagehead"><div><h1 class="h1">새 미션 만들기</h1><p class="sub">직업의 하는 일 한 줄을 골라 체험 미션을 만듭니다.</p></div></div>
    <div class="stepper" data-stepper></div>
    <div class="g3">
      <div class="card">
        <div class="chead"><span class="t">직업</span><span class="c" data-job-count></span></div>
        <div class="cbody" style="padding:12px 10px 10px">
          <label class="search" style="margin:0 4px 8px">${icon("search")}<input type="search" placeholder="직업 검색" aria-label="직업 검색" data-search></label>
          <div class="jlist" data-job-list></div>
        </div>
      </div>
      <div class="card" data-sentence-card></div>
      <div class="card sticky">
        <div class="chead"><span class="t">생성 설정</span></div>
        <div class="cbody" data-settings></div>
      </div>
    </div>`;

  const $ = (selector) => view.querySelector(selector);

  /* ───── 찾기 ───── */

  const currentJob = () => (state.jobs || []).find((job) => job.jobCode === state.jobCode) || null;
  const currentSentence = () => (state.sentences || []).find((s) => s.execJobId === state.execJobId) || null;
  const selectableUnits = (sentence) => (Array.isArray(sentence?.units) ? sentence.units.filter((unit) => unit && unit.selectable) : []);
  const currentUnit = () => selectableUnits(currentSentence()).find((unit) => unit.unitKey === state.unitKey) || null;
  const inService = (job) => Number(job?.catalog?.missionCount) > 0;

  /* ───── 단계 표시 ───── */

  function renderStepper() {
    const reached = state.execJobId ? 3 : state.jobCode ? 2 : 1;
    const steps = ["직업", "문장", "설정"];
    $("[data-stepper]").innerHTML = steps
      .map((label, index) => {
        const n = index + 1;
        const cls = n < reached ? "step done" : n === reached ? "step cur" : "step";
        const mark = n < reached ? "✓" : String(n);
        return `<div class="${cls}"${n === reached ? ' aria-current="step"' : ""}><span class="n">${esc(mark)}</span>${esc(label)}</div>`;
      })
      .join('<div class="sline"></div>');
  }

  /* ───── 직업 목록 ───── */

  function renderJobs() {
    const list = $("[data-job-list]");
    const count = $("[data-job-count]");
    if (state.jobsError) {
      count.textContent = "";
      list.innerHTML = `<div style="padding:8px 4px">${errorLine(state.jobsError)}</div>`;
      return;
    }
    if (!state.jobs) {
      count.textContent = "";
      list.innerHTML = `<div style="padding:0 4px">${loadingLine()}</div>`;
      return;
    }
    count.textContent = String(state.jobs.length);
    const query = state.query.trim().toLowerCase();
    const shown = query ? state.jobs.filter((job) => String(job.jobName ?? "").toLowerCase().includes(query)) : state.jobs;
    if (!shown.length) {
      list.innerHTML = emptyLine(query ? "맞는 직업이 없습니다." : "고를 수 있는 직업이 없습니다.");
      return;
    }
    list.innerHTML = shown
      .map((job) => {
        const on = job.jobCode === state.jobCode;
        const dot = inService(job)
          ? `<span class="dot" title="서비스에 있음" role="img" aria-label="서비스에 있음" style="box-shadow:none;width:6px;height:6px"></span>`
          : "";
        return `<div class="jrow${on ? " on" : ""}" data-testid="job-item" data-job="${esc(job.jobCode)}" role="button" tabindex="0" aria-pressed="${on ? "true" : "false"}">
          <span class="nm" title="${esc(job.jobName)}">${esc(job.jobName)}</span>${dot}<span class="ct">${esc(job.selectableSentenceCount ?? 0)}</span></div>`;
      })
      .join("");
  }

  function markJobRows() {
    view.querySelectorAll("[data-job]").forEach((row) => {
      const on = row.dataset.job === state.jobCode;
      row.classList.toggle("on", on);
      row.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  async function loadJobs() {
    try {
      const data = await adminApi.jobs();
      if (!view.isConnected) return;
      state.jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      state.jobsError = null;
    } catch (err) {
      if (!view.isConnected) return;
      state.jobsError = errorMessage(err);
    }
    renderJobs();
  }

  /* ───── 문장 목록 ───── */

  function linkBadges(sentence) {
    const kinds = [];
    for (const unit of selectableUnits(sentence)) {
      if (unit.linkKind && !kinds.includes(unit.linkKind)) kinds.push(unit.linkKind);
    }
    return kinds.map((kind) => `<span class="${own(LINK_BADGE, kind) || "badge"}">${esc(kind)}</span>`).join("");
  }

  function existingBadges(sentence) {
    const have = Array.isArray(sentence?.existingDifficulties) ? sentence.existingDifficulties : [];
    return DIFFICULTIES.filter((key) => have.includes(key))
      .map((key) => `<span class="badge">${esc(DIFFICULTY_LABELS[key])} 있음</span>`)
      .join("");
  }

  function renderSentences() {
    const card = $("[data-sentence-card]");
    const job = currentJob();
    if (!state.jobCode) {
      card.innerHTML = `<div class="chead"><span class="t">하는 일 문장</span></div>${emptyLine("직업을 고르면 하는 일 문장이 나옵니다.")}`;
      return;
    }
    const jobName = job?.jobName ?? "";
    const serviceBadge = inService(job)
      ? `<span class="sp"></span><span class="badge ok"><span class="dot" style="box-shadow:none;width:6px;height:6px"></span>서비스에 있음</span>`
      : "";
    if (state.sentencesError) {
      card.innerHTML = `<div class="chead"><span class="t">하는 일 문장</span><span class="c">${esc(jobName)}</span>${serviceBadge}</div>
        <div class="cbody">${errorLine(state.sentencesError)}</div>`;
      return;
    }
    if (!state.sentences) {
      card.innerHTML = `<div class="chead"><span class="t">하는 일 문장</span><span class="c">${esc(jobName)}</span>${serviceBadge}</div>
        <div class="cbody">${loadingLine()}</div>`;
      return;
    }
    const open = state.sentences.filter((s) => s && s.selectable);
    const blocked = state.sentences.filter((s) => s && !s.selectable);
    const rows = open.length
      ? open
          .map((s) => {
            const on = s.execJobId === state.execJobId;
            return `<div class="srow${on ? " on" : ""}" data-testid="sentence-item" data-sentence="${esc(s.execJobId)}" role="radio" tabindex="0" aria-checked="${on ? "true" : "false"}">
              <span class="radio"></span><div><div class="tx">${esc(s.text)}</div><div class="mt">${linkBadges(s)}${existingBadges(s)}</div></div></div>`;
          })
          .join("")
      : emptyLine("고를 수 있는 문장이 없습니다.");
    const blockedRows = blocked
      .map((s) => `<div class="srow off"><div><div class="tx">${esc(s.text)}</div><div class="hint">${esc(own(BLOCKED_REASON_TEXT, s.blockedReason) ?? "")}</div></div></div>`)
      .join("");
    const foot = blocked.length
      ? `<details><summary class="cfoot"><span class="link">고를 수 없는 문장 ${esc(blocked.length)}개 <span class="chev">${icon("chevronRight", { size: 13 })}</span></span></summary>${blockedRows}</details>`
      : "";
    card.innerHTML = `<div class="chead"><span class="t">하는 일 문장</span><span class="c">${esc(jobName)} · ${esc(open.length)}개</span>${serviceBadge}</div>
      <div role="radiogroup" aria-label="하는 일 문장">${rows}</div>${foot}`;
  }

  function markSentenceRows() {
    view.querySelectorAll("[data-sentence]").forEach((row) => {
      const on = row.dataset.sentence === state.execJobId;
      row.classList.toggle("on", on);
      row.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  async function chooseJob(jobCode) {
    if (!jobCode) return;
    if (jobCode === state.jobCode && !state.sentencesError) return;   // 같은 직업을 다시 누르면 그대로(오류였으면 다시 받는다)
    state.jobCode = jobCode;
    state.sentences = null;
    state.sentencesError = null;
    state.execJobId = null;
    state.unitKey = null;
    state.reasonOpen = false;
    state.startError = null;
    materialSeq += 1;   // 앞 문장의 자료 형태 응답은 버린다
    state.material = { state: "none", text: "" };
    markJobRows();
    renderStepper();
    renderSentences();
    renderSettings();
    const seq = ++sentenceSeq;
    try {
      const data = await adminApi.sentences(jobCode);
      if (!view.isConnected || seq !== sentenceSeq) return;
      state.sentences = Array.isArray(data?.sentences) ? data.sentences : [];
    } catch (err) {
      if (!view.isConnected || seq !== sentenceSeq) return;
      state.sentencesError = errorMessage(err);
    }
    renderSentences();
  }

  function chooseSentence(execJobId) {
    if (!execJobId || execJobId === state.execJobId) return;
    const sentence = (state.sentences || []).find((s) => s.execJobId === execJobId && s.selectable);
    if (!sentence) return;
    const units = selectableUnits(sentence);
    state.execJobId = execJobId;
    state.unitKey = (units.find((unit) => unit.isDefault) || units[0])?.unitKey ?? null;
    state.reasonOpen = false;
    state.startError = null;
    markSentenceRows();
    renderStepper();
    renderSettings();
    loadMaterialTypes();
  }

  /* ───── 생성 설정 ───── */

  function renderSettings() {
    const box = $("[data-settings]");
    const job = currentJob();
    const sentence = currentSentence();
    const units = selectableUnits(sentence);
    const dash = `<div class="muted">—</div>`;

    let unitField = dash;
    if (units.length === 1) {
      unitField = `<div class="fval">${esc(units[0].unitName)}</div>`;
    } else if (units.length > 1) {
      unitField = `<select class="select" data-unit aria-label="능력단위">${units
        .map((unit) => `<option value="${esc(unit.unitKey)}"${unit.unitKey === state.unitKey ? " selected" : ""}>${esc(unit.unitName)}</option>`)
        .join("")}</select>`;
    }

    box.innerHTML = `<div class="field"><div class="flbl">직업</div>${job ? `<div class="fval">${esc(job.jobName)}</div>` : dash}</div>
      <div class="field"><div class="flbl">문장</div>${sentence ? `<div class="clamp" title="${esc(sentence.text)}">${esc(sentence.text)}</div>` : dash}</div>
      <div class="field"><div class="flbl">능력단위</div>${unitField}<div data-unit-info></div></div>
      <div class="field"><div class="flbl">난이도</div>
        <div class="seg" role="group" aria-label="난이도">${DIFFICULTIES.map((key) => `<button type="button" data-diff="${esc(key)}">${esc(DIFFICULTY_LABELS[key])}</button>`).join("")}</div>
        <div class="hint" data-diff-hint></div></div>
      <div class="field"><div class="flbl">자료 형태 <span style="color:var(--tx4)">· 자동</span></div><div data-material></div></div>
      <div class="field toggle"><button type="button" class="sw" data-review aria-label="내용 검수 포함"></button><span>내용 검수 포함</span></div>
      <div class="hr"></div>
      <div class="est"><span>예상 소요</span><b data-est-time></b></div>
      <div class="est"><span>예상 비용</span><b data-est-cost></b></div>
      <div data-action></div>`;

    renderUnitInfo();
    renderDifficulty();
    renderReview();
    renderMaterial();
    renderAction();
  }

  // 능력단위 아래: 수행준거 · 서류 · 고려사항 수와 "연결 근거"
  function renderUnitInfo() {
    const box = $("[data-unit-info]");
    if (!box) return;
    const unit = currentUnit();
    if (!unit) {
      box.innerHTML = "";
      return;
    }
    const counts = unit.counts || {};
    const countText = `수행준거 ${counts.criteria ?? 0} · 서류 ${counts.documents ?? 0} · 고려사항 ${counts.considerations ?? 0}`;
    const reason = unit.reason
      ? ` <button type="button" class="link" data-reason-toggle aria-expanded="${state.reasonOpen ? "true" : "false"}">연결 근거</button>`
      : "";
    box.innerHTML = `<div class="hint">${esc(countText)}${reason}</div>
      ${unit.reason ? `<div class="hint" data-reason${state.reasonOpen ? "" : " hidden"}>${esc(unit.reason)}</div>` : ""}`;
  }

  function renderDifficulty() {
    view.querySelectorAll("[data-diff]").forEach((button) => {
      const on = button.dataset.diff === state.difficulty;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const hint = $("[data-diff-hint]");
    if (hint) hint.textContent = own(DIFFICULTY_HINTS, state.difficulty) ?? "";
    renderEstimate();
  }

  function renderReview() {
    const sw = $("[data-review]");
    if (!sw) return;
    sw.classList.toggle("off", !state.review);
    sw.setAttribute("aria-pressed", state.review ? "true" : "false");
    renderEstimate();
  }

  function renderEstimate() {
    const { time, cost } = estimateText(ctx.status?.estimates, state.difficulty, state.review);
    const timeNode = $("[data-est-time]");
    const costNode = $("[data-est-cost]");
    if (timeNode) timeNode.textContent = time;
    if (costNode) costNode.textContent = cost;
  }

  function renderMaterial() {
    const box = $("[data-material]");
    if (!box) return;
    const { state: phase, text } = state.material;
    if (phase === "loading") box.innerHTML = `<span class="muted">확인 중</span>`;
    else if (phase === "ok") box.innerHTML = esc(text);
    else if (phase === "error") box.innerHTML = errorLine(text);
    else box.innerHTML = `<span class="muted">—</span>`;
  }

  // 자료 형태는 문장, 능력단위, 난이도가 바뀔 때마다 다시 받는다. 늦게 온 앞 요청의 응답은 버린다
  async function loadMaterialTypes() {
    const seq = ++materialSeq;
    if (!state.jobCode || !state.execJobId || !state.unitKey) {
      state.material = { state: "none", text: "" };
      renderMaterial();
      return;
    }
    state.material = { state: "loading", text: "" };
    renderMaterial();
    const params = { jobCode: state.jobCode, execJobId: state.execJobId, unitKey: state.unitKey, difficulty: state.difficulty };
    try {
      const data = await adminApi.materialTypes(params);
      if (!view.isConnected || seq !== materialSeq) return;
      state.material = { state: "ok", text: materialTypesText(data?.allowedMaterialTypes) };
    } catch (err) {
      if (!view.isConnected || seq !== materialSeq) return;
      state.material = { state: "error", text: errorMessage(err) };   // 버튼은 막지 않는다
    }
    renderMaterial();
  }

  /* ───── 버튼 ───── */

  // 누를 수 없는 까닭. { text, error }(error면 빨간 글) 또는 null(누를 수 있다)
  function blockReason() {
    const status = ctx.status;
    if (ctx.readOnly) return { text: errorText("AUTH_REQUIRED"), error: false };
    if (status?.preflight && !status.preflight.ok) {
      const failed = Array.isArray(status.preflight.checks) ? status.preflight.checks.find((check) => check && !check.ok) : null;
      return { text: errorText(failed?.code), error: true };
    }
    const started = Number(status?.today?.started);
    const limit = Number(status?.today?.limit);
    if (Number.isFinite(started) && Number.isFinite(limit) && started >= limit) return { text: errorText("GENERATION_DAILY_LIMIT"), error: true };
    if (!state.execJobId || !state.unitKey) return { text: "하는 일 문장을 골라 주세요.", error: false };
    return null;
  }

  function renderAction() {
    const box = $("[data-action]");
    if (!box) return;
    const activeRunId = ctx.status?.activeRunId;
    let main;
    if (state.statusReady && activeRunId && !state.starting) {
      main = `<button type="button" class="btn pri lg" style="margin-top:12px" data-go-run="${esc(activeRunId)}">지금 만들고 있는 미션 보기</button>`;
    } else if (state.starting) {
      main = `<button type="button" class="btn pri lg" style="margin-top:12px" data-testid="start-run" disabled>시작하는 중…</button>`;
    } else {
      const reason = state.statusReady ? blockReason() : { text: "", error: false };   // 상태를 새로 받기 전에는 잠가 둔다
      main = `<button type="button" class="btn pri lg" style="margin-top:12px" data-testid="start-run" data-start${reason ? " disabled" : ""}>${icon("sparkleOne")}미션 생성</button>`;
      if (reason?.text) main += reason.error ? `<div class="err-text">${esc(reason.text)}</div>` : `<div class="hint">${esc(reason.text)}</div>`;
    }
    let failure = "";
    if (state.startError) {
      failure = errorLine(state.startError.message);
      // 409: 이미 도는 실행으로 가는 길. 위 버튼이 이미 같은 실행을 가리키면 겹쳐 두지 않는다
      if (state.startError.runId && !(state.statusReady && activeRunId === state.startError.runId)) {
        failure += `<div class="hint"><button type="button" class="link" data-go-run="${esc(state.startError.runId)}">지금 만들고 있는 미션 보기</button></div>`;
      }
    }
    box.innerHTML = main + failure;
    syncPoll();
  }

  // "지금 만들고 있는 미션 보기"가 보이는 동안 3초마다 상태를 다시 묻는다.
  // 도는 실행이 끝나면(activeRunId가 비면) 버튼 자리를 다시 그려 이 화면에서 바로 새로 시작할 수 있게 한다
  function syncPoll() {
    const want = !disposed && view.isConnected && state.statusReady && !state.starting && Boolean(ctx.status?.activeRunId);
    if (!want) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      return;
    }
    if (pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      const before = ctx.status?.activeRunId;
      await Promise.resolve(ctx.refreshUsage()).catch(() => null);
      if (disposed || !view.isConnected) return;   // 화면을 떠났으면 다시 걸지 않는다
      if (!state.starting && ctx.status?.activeRunId !== before) renderAction();   // renderAction이 syncPoll을 부른다
      else syncPoll();
    }, 3000);
  }

  async function startRun() {
    if (state.starting || !state.statusReady || blockReason() || ctx.status?.activeRunId) return;
    const body = {
      jobCode: state.jobCode,
      execJobId: state.execJobId,
      unitKey: state.unitKey,
      difficulty: state.difficulty,
      review: state.review
    };
    state.starting = true;
    state.startError = null;
    renderAction();
    let run = null;
    try {
      const data = await adminApi.startRun(body);
      run = data?.run ?? null;
    } catch (err) {
      const runId = err?.code === "GENERATION_ALREADY_RUNNING" ? err?.details?.runId : null;
      state.startError = { message: errorMessage(err), runId: typeof runId === "string" && runId ? runId : null };
    }
    await Promise.resolve(ctx.refreshUsage()).catch(() => null);   // 오늘 건수, 도는 실행 번호를 새로 받는다
    if (!view.isConnected) return;   // 그사이 다른 화면으로 갔으면 끌고 가지 않는다
    state.starting = false;
    if (run?.runId) {
      ctx.navigate("#/runs/" + encodeURIComponent(run.runId));
      return;
    }
    if (!state.startError) state.startError = { message: errorText(), runId: null };   // 202인데 실행 번호가 없는 경우
    renderAction();
  }

  /* ───── 이벤트 ───── */

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const goRun = target.closest("[data-go-run]");
    if (goRun) {
      ctx.navigate("#/runs/" + encodeURIComponent(goRun.dataset.goRun));
      return;
    }
    // 시작하는 중에는 고른 값을 바꾸지 않는다(보낸 요청의 값이 이미 정해졌다)
    const jobRow = target.closest("[data-job]");
    if (jobRow) {
      if (!state.starting) chooseJob(jobRow.dataset.job);
      return;
    }
    const sentenceRow = target.closest("[data-sentence]");
    if (sentenceRow) {
      if (!state.starting) chooseSentence(sentenceRow.dataset.sentence);
      return;
    }
    const diff = target.closest("[data-diff]");
    if (diff) {
      if (state.starting || diff.dataset.diff === state.difficulty) return;
      state.difficulty = diff.dataset.diff;
      state.startError = null;
      renderDifficulty();
      renderAction();
      loadMaterialTypes();
      return;
    }
    if (target.closest("[data-review]")) {
      if (state.starting) return;
      state.review = !state.review;
      state.startError = null;
      renderReview();
      renderAction();
      return;
    }
    const reasonToggle = target.closest("[data-reason-toggle]");
    if (reasonToggle) {
      state.reasonOpen = !state.reasonOpen;
      reasonToggle.setAttribute("aria-expanded", state.reasonOpen ? "true" : "false");
      const reason = $("[data-reason]");
      if (reason) reason.hidden = !state.reasonOpen;
      return;
    }
    if (target.closest("[data-start]")) startRun();
  }

  // 직업 줄과 문장 줄은 <div>라서 Enter · Space로도 고를 수 있게 한다
  function onKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.matches("[data-job],[data-sentence]") ? target : null;
    if (!row) return;
    event.preventDefault();
    if (state.starting) return;
    if (row.dataset.job) chooseJob(row.dataset.job);
    else chooseSentence(row.dataset.sentence);
  }

  function onChange(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.matches("[data-unit]")) return;
    if (state.starting) {
      target.value = state.unitKey ?? "";   // 시작하는 중에는 되돌린다
      return;
    }
    state.unitKey = target.value;
    state.reasonOpen = false;
    state.startError = null;
    renderUnitInfo();
    renderAction();
    loadMaterialTypes();
  }

  function onInput(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.matches("[data-search]")) return;
    state.query = target.value;
    renderJobs();
  }

  view.addEventListener("click", onClick);
  view.addEventListener("keydown", onKeydown);
  view.addEventListener("change", onChange);
  view.addEventListener("input", onInput);

  renderStepper();
  renderJobs();
  renderSentences();
  renderSettings();
  loadJobs();

  // 붙일 때 상태를 한 번 새로 받는다(도는 실행 번호와 오늘 건수). 받은 뒤에 버튼을 정한다(실패하면 가진 값으로)
  Promise.resolve(ctx.refreshUsage()).catch(() => null).then(() => {
    if (!view.isConnected) return;
    state.statusReady = true;
    renderEstimate();
    renderAction();
  });

  return () => {
    disposed = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    view.removeEventListener("click", onClick);
    view.removeEventListener("keydown", onKeydown);
    view.removeEventListener("change", onChange);
    view.removeEventListener("input", onInput);
    sentenceSeq += 1;   // 남은 응답은 버린다
    materialSeq += 1;
  };
}
