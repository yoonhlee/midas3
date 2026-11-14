/* 관리자 화면의 틀: 사이드바, 위 띠, 조회 전용 띠, 용어 안내, 암호 화면, 확인 창, 알림.
   여러 화면이 같이 쓰는 그리기 도우미(icon, verdictBadge, statusBadge, formatWhen 등)도 여기에 둔다.
   화면에 넣는 값은 모두 esc()를 거친다. */
import { esc } from "../common/site.js";
import { adminApi } from "./api.js";
import { STATUS_LABELS, errorText, verdictView } from "./labels.js";

/* ───── 아이콘 (시안의 SVG) ───── */

const ICONS = {
  sparkle: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  sparkleOne: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
  list: '<path d="M4 6.500h16"/><path d="M4 12h16"/><path d="M4 17.500h16"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/>',
  logout: '<path d="M15 12H4"/><path d="M8 8l-4 4 4 4"/><path d="M12 4h6a1 1 0 011 1v14a1 1 0 01-1 1h-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.500 0 114.2 2c-.9.7-1.800 1.200-1.800 2.400"/><path d="M12 17h.01"/>',
  book: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 21V5"/><path d="M9 8h6"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="M20 20l-4-4"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12l4.500 4.500L19 7"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.500"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8"/><path d="M16 7l2 2"/>'
};

// 아이콘 이름 → <svg> 글자. size(픽셀)와 style(추가 인라인 스타일)을 줄 수 있다. 모르는 이름이면 빈 글자
export function icon(name, { size, style = "" } = {}) {
  const body = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : "";
  if (!body) return "";
  const sizeStyle = size ? `width:${Number(size)}px;height:${Number(size)}px;` : "";
  const styleAttr = sizeStyle || style ? ` style="${esc(sizeStyle + style)}"` : "";
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"${styleAttr}>${body}</svg>`;
}

/* ───── 판정 · 상태 · 날짜 ───── */

// 검수 판정 → 표시 HTML. "의심"(doubt)은 크게 보이지 않게 테두리 없는 작은 회색 글로 쓴다
export function verdictBadge(verdict, warningCount) {
  const view = verdictView(verdict, warningCount);
  if (view.tone === "quiet") return `<span class="vquiet">${esc(view.text)}</span>`;
  const cls = view.tone === "ok" ? "badge ok" : view.tone === "danger" ? "badge danger" : view.tone === "warn" ? "badge warn" : "badge";
  return `<span class="${cls}">${esc(view.text)}</span>`;
}

const STATUS_CLASS = { running: "run", ready: "wait", added: "added", failed: "fail" };

// 실행의 상태 → 점 하나와 글(시안의 .st2). 중단됨과 모르는 값은 회색 점
export function statusBadge(status) {
  const key = typeof status === "string" ? status : "";
  const cls = Object.prototype.hasOwnProperty.call(STATUS_CLASS, key) ? ` ${STATUS_CLASS[key]}` : "";
  const label = Object.prototype.hasOwnProperty.call(STATUS_LABELS, key) ? STATUS_LABELS[key] : key || "–";
  return `<span class="st2${cls}"><i></i>${esc(label)}</span>`;
}

// ISO 시각 → "월 일 시:분" 글자(한국 시간). 읽을 수 없으면 빈 글자
export function formatWhen(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}월 ${get("day")}일 ${get("hour")}:${get("minute")}`;
}

/* ───── 한 줄 상태 (화면 안에서 쓰는 HTML 글자) ───── */

// 오류 객체 → 화면의 말. 서버에 닿지 못했으면 그렇다고 쓴다. failedRun은 errorText에 넘긴다
export function errorMessage(err, options) {
  if (err && err.status === 0 && err.code === "NETWORK_ERROR") return "서버에 연결하지 못했습니다.";
  return errorText(err?.code, options);
}

export function errorLine(message) {
  return `<div class="err-text" role="alert">${esc(message)}</div>`;
}

export function loadingLine(text = "불러오는 중입니다") {
  return `<div class="loading-line"><span class="spin"></span>${esc(text)}</div>`;
}

export function emptyLine(text) {
  return `<div class="empty-line">${esc(text)}</div>`;
}

/* ───── 틀 ───── */

const MENUS = [
  { label: "새 미션 만들기", hash: "#/new", icon: "sparkle" },
  { label: "생성 기록", hash: "#/runs", icon: "clock" },
  { label: "미션 카탈로그", hash: "#/catalog", icon: "list" }
];

const GLOSSARY = [
  ["하는 일 문장", "직업정보(KNOW)에 적힌, 그 직업이 하는 일 한 줄입니다."],
  ["능력단위", "국가직무능력표준(NCS)이 일을 나눈 단위입니다. 문장마다 맞는 능력단위를 미리 이어 두었습니다."],
  ["수행준거", "능력단위 안의 \"~할 수 있다\" 문장입니다. 미션의 과제가 여기서 나옵니다."],
  ["직접 · 분야 한정", "문장과 능력단위가 맞는 정도입니다. 직접은 일이 그대로 같고, 분야 한정은 같은 일을 한 업종 안에서 다룹니다."]
];

const GLOSS_CLOSED_KEY = "jobsim:admin_glossary_closed";

function glossClosed() {
  try {
    return sessionStorage.getItem(GLOSS_CLOSED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function rememberGloss(closed) {
  try {
    if (closed) sessionStorage.setItem(GLOSS_CLOSED_KEY, "1");
    else sessionStorage.removeItem(GLOSS_CLOSED_KEY);
  } catch (_) {
    /* 기억하지 못해도 이번 화면에서는 그대로다 */
  }
}

// 사이드바, 위 띠, (조회 전용이면) 띠, 용어 안내, 본문 자리(#admin-view)를 그린다.
// ctx.logout(), ctx.askPassword()는 main.js가 넣어 준다.
export function renderShell(root, ctx) {
  const closed = glossClosed();
  const bottomAction = ctx.readOnly
    ? `<button class="nav" type="button" data-shell="ask" title="암호 입력" aria-label="암호 입력">${icon("key")}<span>암호 입력</span></button>`
    : `<button class="nav" type="button" data-shell="logout" title="로그아웃" aria-label="로그아웃">${icon("logout")}<span>로그아웃</span></button>`;
  root.innerHTML = `<div class="app">
    <aside class="side">
      <div class="logo"><span class="nm">JOB<span>SIM</span></span><span class="mk" aria-hidden="true">J<span>S</span></span><span class="tag">Admin</span></div>
      <div class="navlbl">콘텐츠</div>
      ${MENUS.map((menu) => `<a class="nav" href="${esc(menu.hash)}" data-menu="${esc(menu.label)}" title="${esc(menu.label)}" aria-label="${esc(menu.label)}">${icon(menu.icon)}<span>${esc(menu.label)}</span></a>`).join("")}
      <div class="grow"></div>
      <div class="usage" id="adm-usage"></div>
      <a class="nav" href="/index.html" target="_blank" rel="noopener" title="사용자 화면" aria-label="사용자 화면 (새 창)">${icon("external")}<span>사용자 화면</span></a>
      ${bottomAction}
    </aside>
    <div class="main">
      <div class="top">
        <div class="crumb"><span id="crumb-root"></span> <span id="crumb-sep">/</span> <b id="crumb"></b></div>
        <div class="sp"></div>
        <button class="btn ghost" type="button" id="gloss-toggle" aria-controls="gloss" aria-expanded="${closed ? "false" : "true"}">${icon("help")}용어 안내</button>
        <div class="avatar" aria-hidden="true">관</div>
      </div>
      ${ctx.readOnly ? `<div class="roband" role="status">${icon("lock")}<span>조회만 열려 있습니다. 생성 · 추가 · 삭제는 관리자 암호가 필요합니다.</span><button class="btn" type="button" data-shell="ask">암호 입력</button></div>` : ""}
      <div class="content">
        <div class="gloss" id="gloss"${closed ? " hidden" : ""}>
          <div class="gh">${icon("book", { style: "color:var(--ac-h)" })}용어 안내<button class="x" type="button" id="gloss-close">닫기</button></div>
          <div class="ggrid">
            ${GLOSSARY.map(([term, text]) => `<div class="g"><b>${esc(term)}</b><span>${esc(text)}</span></div>`).join("")}
          </div>
        </div>
        <div id="admin-view"></div>
      </div>
    </div>
  </div>`;

  const gloss = root.querySelector("#gloss");
  const toggle = root.querySelector("#gloss-toggle");
  const setGloss = (open) => {
    gloss.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    rememberGloss(!open);
  };
  toggle.addEventListener("click", () => setGloss(gloss.hidden));
  root.querySelector("#gloss-close").addEventListener("click", () => setGloss(false));
  root.querySelectorAll('[data-shell="ask"]').forEach((node) => node.addEventListener("click", () => ctx.askPassword?.()));
  root.querySelector('[data-shell="logout"]')?.addEventListener("click", () => ctx.logout?.());

  paintUsage(ctx.status);
}

// 위 띠의 경로 글과 사이드바의 켜진 메뉴를 바꾼다. leaf가 비면 root만 보인다.
// 사이드바는 글이 root와 같은 메뉴를 켠다(없으면 모두 끈다).
export function setCrumb(rootLabel, leaf) {
  const rootNode = document.getElementById("crumb-root");
  const sep = document.getElementById("crumb-sep");
  const leafNode = document.getElementById("crumb");
  if (rootNode) rootNode.textContent = rootLabel ?? "";
  if (leafNode) leafNode.textContent = leaf ?? "";
  if (sep) sep.hidden = !leaf;
  document.querySelectorAll(".side .nav[data-menu]").forEach((node) => {
    const on = node.dataset.menu === rootLabel;
    node.classList.toggle("on", on);
    if (on) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
}

// API 상태 한 줄의 글과 점 색
function apiState(status) {
  if (status?.mode === "fake") return { text: "시험 모드(실제 생성 안 함)", dot: "dot warn" };
  if (status?.preflight?.ok) return { text: "Claude API 연결됨", dot: "dot" };
  const failed = Array.isArray(status?.preflight?.checks) ? status.preflight.checks.find((check) => check && !check.ok) : null;
  return { text: errorText(failed?.code), dot: "dot danger" };
}

function paintUsage(status) {
  const box = document.getElementById("adm-usage");
  if (!box) return;
  const started = Number(status?.today?.started) || 0;
  const limit = Number(status?.today?.limit) || 0;
  const percent = limit > 0 ? Math.min(100, Math.round((started / limit) * 100)) : 0;
  const api = apiState(status);
  box.innerHTML = `<div class="row1"><span>오늘 생성</span><span><b style="color:var(--tx)">${esc(started)}</b> / ${esc(limit)}</span></div>
    <div class="bar"><i style="width:${percent}%"></i></div>
    <div class="stat"><span class="${api.dot}"></span>${esc(api.text)}</div>`;
}

// /status를 다시 받아 ctx.status를 고치고 사이드바의 건수와 API 상태만 다시 그린다(화면은 그대로).
// 새 상태를 돌려준다. 실패하면 null을 돌려주고 원래 숫자를 둔다(401이면 api.js가 암호 화면으로 보낸다).
export async function refreshUsage(ctx) {
  try {
    const status = await adminApi.status();
    ctx.status = status;
    paintUsage(status);
    return status;
  } catch (_) {
    return null;
  }
}

/* ───── 시작 화면 · 암호 화면 ───── */

function logoHtml() {
  return `<div class="logo"><span class="nm">JOB<span>SIM</span></span><span class="mk" aria-hidden="true">J<span>S</span></span><span class="tag">Admin</span></div>`;
}

// 처음 상태를 묻는 동안 보이는 화면
export function renderLoading(root, text = "확인하는 중입니다") {
  root.innerHTML = `<div class="boot" role="status"><div class="row"><span class="spin"></span>${esc(text)}</div></div>`;
}

// 더 갈 수 없을 때(서버에 암호가 없음 등) 글만 보이고 멈춘다. retry를 주면 "다시 시도" 버튼을 둔다
export function renderStop(root, message, { retry } = {}) {
  root.innerHTML = `<div class="boot">${logoHtml()}<div class="msg" role="alert">${esc(message)}</div>
    ${retry ? `<button class="btn" type="button" data-retry>다시 시도</button>` : ""}</div>`;
  if (retry) root.querySelector("[data-retry]").addEventListener("click", () => retry());
}

// 암호 화면. onSubmit(암호)는 Promise를 돌려준다: 글자로 끝나면 그 글을 오류로 보이고 다시 입력받는다.
// 그 밖(성공)이면 부른 쪽이 다음 화면을 그린다. onCancel을 주면 "조회만 하기" 버튼을 둔다(조회 전용 열기일 때).
export function renderAuth(root, { error, onSubmit, onCancel } = {}) {
  root.innerHTML = `<div class="auth">
    <form class="card auth-card" novalidate>
      ${logoHtml()}
      <h1 class="h1">관리자 암호</h1>
      <p class="sub">미션 생성 관리자 화면입니다. 서버에 설정한 관리자 암호를 입력해 주세요.</p>
      <label class="flbl" for="adm-password">암호</label>
      <input class="input" id="adm-password" type="password" autocomplete="current-password">
      <p class="auth-error" data-testid="auth-error" role="alert"${error ? "" : " hidden"}>${esc(error || "")}</p>
      <button class="btn pri lg" type="submit">확인</button>
      ${onCancel ? `<button class="btn ghost" type="button" data-cancel>조회만 하기</button>` : ""}
    </form>
  </div>`;
  const form = root.querySelector("form");
  const input = root.querySelector("#adm-password");
  const errorNode = root.querySelector(".auth-error");
  const submit = form.querySelector('button[type="submit"]');
  const showError = (message) => {
    errorNode.textContent = message || "";
    errorNode.hidden = !message;
  };
  input.focus();
  root.querySelector("[data-cancel]")?.addEventListener("click", () => onCancel());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      showError("암호를 입력해 주세요.");
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "확인하는 중입니다";
    let result;
    try {
      result = await onSubmit?.(value);
    } catch (err) {
      result = errorMessage(err);
    }
    if (!form.isConnected) return;   // 다음 화면으로 넘어갔다
    submit.disabled = false;
    submit.textContent = "확인";
    if (typeof result === "string" && result) {
      showError(result);
      input.select();
    }
  });
}

/* ───── 확인 창 · 알림 ───── */

// 한 번 묻는 창. 누른 쪽에 따라 true/false로 끝난다. Esc와 바깥 누르기는 취소다.
// danger면 확인 버튼이 빨간색이고, 처음 초점은 취소 버튼에 둔다.
export function confirmDialog({ title, body, okLabel = "확인", danger = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dlg-back";
    back.innerHTML = `<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="adm-dlg-title" aria-describedby="adm-dlg-body">
      <h2 id="adm-dlg-title">${esc(title || "")}</h2>
      ${body ? `<p id="adm-dlg-body">${esc(body)}</p>` : ""}
      <div class="acts">
        <button class="btn" type="button" data-act="cancel">취소</button>
        <button class="btn ${danger ? "danger" : "pri"}" type="button" data-act="ok" data-testid="confirm-ok">${esc(okLabel)}</button>
      </div>
    </div>`;
    const before = document.activeElement;
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      if (before && typeof before.focus === "function" && before.isConnected) before.focus();
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    back.addEventListener("click", (event) => {
      if (event.target === back) finish(false);
    });
    back.querySelector('[data-act="cancel"]').addEventListener("click", () => finish(false));
    back.querySelector('[data-act="ok"]').addEventListener("click", () => finish(true));
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    back.querySelector(danger ? '[data-act="cancel"]' : '[data-act="ok"]').focus();
  });
}

// 생성 결과를 지울 때 묻는 창. 서비스에 추가된 것이면 서비스에서도 빠진다고 알린다
export function confirmDeleteRun(run) {
  const added = run?.status === "added";
  return confirmDialog({
    title: "생성 결과 삭제",
    body: added
      ? "이 미션은 서비스에 추가돼 있습니다. 삭제하면 서비스에서도 빠지고, 생성 결과가 함께 지워집니다. 되돌릴 수 없습니다."
      : "이 생성 결과를 삭제할까요? 미션과 근거 기록이 함께 지워지고 되돌릴 수 없습니다.",
    okLabel: "삭제",
    danger: true
  });
}

// 화면 아래에 잠깐 뜨는 알림
export function toast(message, ms = 2600) {
  const node = document.createElement("div");
  node.className = "adm-toast";
  node.setAttribute("role", "status");
  node.textContent = String(message ?? "");
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ms);
}
