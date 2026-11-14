/* 관리자 화면 시작: 암호 확인 → 틀 → 주소(#)에 맞는 화면.
   주소: #/new(기본), #/runs, #/runs/<실행 번호>, #/catalog. 그 밖의 값과 빈 값은 #/new로 본다. */
import { adminApi, clearToken, getToken, setAuthLostHandler, setToken, verifyToken } from "./api.js";
import { errorText } from "./labels.js";
import { errorLine, errorMessage, refreshUsage, renderAuth, renderLoading, renderShell, renderStop, setCrumb } from "./shell.js";
import * as screenNew from "./screenNew.js";
import * as screenRun from "./screenRun.js";
import * as screenHistory from "./screenHistory.js";
import * as screenCatalog from "./screenCatalog.js";

const ROUTES = [
  { pattern: /^#\/new$/, screen: screenNew, crumb: ["새 미션 만들기", "고르기"] },
  { pattern: /^#\/runs\/([^/]+)$/, screen: screenRun, crumb: ["생성 기록", ""], params: (match) => ({ runId: decodeURIComponent(match[1]) }) },
  { pattern: /^#\/runs$/, screen: screenHistory, crumb: ["생성 기록", ""] },
  { pattern: /^#\/catalog$/, screen: screenCatalog, crumb: ["미션 카탈로그", ""] }
];
const DEFAULT_HASH = "#/new";

const root = document.getElementById("admin-app");
let session = null;      // 틀이 떠 있는 동안: { ctx, cleanup, onHash }
let lastStatus = null;   // 마지막으로 받은 /status(암호 화면에서 "조회만 하기"를 둘지 정한다)

// 요청이 401을 받으면 api.js가 암호를 지우고 이것을 부른다. 틀이 떠 있을 때만 암호 화면으로 간다
setAuthLostHandler(() => {
  if (session) showAuth({ error: errorText("AUTH_REQUIRED") });
});

function resolve(hash) {
  for (const route of ROUTES) {
    const match = route.pattern.exec(hash);
    if (!match) continue;
    try {
      return { route, params: route.params ? route.params(match) : {} };
    } catch (_) {
      return null;   // 잘못된 % 글자 등
    }
  }
  return null;
}

// 지금 화면을 정리하고(정리 함수 부르기) 주소에 맞는 화면을 새로 붙인다
function mountRoute() {
  if (!session) return;
  let found = resolve(location.hash);
  if (!found) {
    history.replaceState(null, "", DEFAULT_HASH);
    found = resolve(DEFAULT_HASH);
  }
  runCleanup();
  const host = document.getElementById("admin-view");
  if (!host) return;
  // 화면마다 새 칸을 준다. 앞 화면의 늦게 끝난 요청이 새 화면을 덮어쓰지 않는다(옛 칸은 문서에서 떨어져 있다)
  const view = document.createElement("div");
  host.replaceChildren(view);
  setCrumb(found.route.crumb[0], found.route.crumb[1]);
  window.scrollTo(0, 0);
  // 화면마다 ctx 껍데기를 준다. status · readOnly 등은 원래 ctx를 프로토타입으로 이어 늘 지금 값을 읽고,
  // setCrumb · navigate는 이 화면을 떠난 뒤(view가 문서에서 떨어진 뒤)에는 아무것도 하지 않는다(늦게 온 응답이 경로 글이나 주소를 바꾸지 않게)
  const screenCtx = Object.create(session.ctx, {
    setCrumb: { value: (rootLabel, leaf) => { if (view.isConnected) session?.ctx.setCrumb(rootLabel, leaf); } },
    navigate: { value: (hash) => { if (view.isConnected) session?.ctx.navigate(hash); } }
  });
  try {
    const cleanup = found.route.screen.mount(view, screenCtx, found.params);
    session.cleanup = typeof cleanup === "function" ? cleanup : null;
  } catch (err) {
    console.error(err);
    view.innerHTML = errorLine(errorMessage(err));
  }
}

function runCleanup() {
  if (!session?.cleanup) return;
  const cleanup = session.cleanup;
  session.cleanup = null;
  try {
    cleanup();
  } catch (err) {
    console.error(err);
  }
}

// 틀을 내린다(정리 함수, 주소 듣기 끄기)
function teardown() {
  if (!session) return;
  runCleanup();
  window.removeEventListener("hashchange", session.onHash);
  session = null;
}

function startShell(status) {
  teardown();
  lastStatus = status;
  const ctx = {
    status,
    readOnly: Boolean(status?.adminDemoUnlockEnabled) && !getToken(),
    navigate(hash) {
      if (location.hash === hash) mountRoute();
      else location.hash = hash;
    },
    refreshUsage: () => refreshUsage(ctx),
    onAuthLost() {
      clearToken();
      showAuth({ error: errorText("AUTH_REQUIRED") });
    },
    setCrumb: (rootLabel, leaf) => setCrumb(rootLabel, leaf),
    logout() {
      clearToken();
      showAuth();
    },
    askPassword: () => showAuth()
  };
  renderShell(root, ctx);
  const onHash = () => mountRoute();
  window.addEventListener("hashchange", onHash);
  session = { ctx, cleanup: null, onHash };
  mountRoute();
}

function showAuth({ error } = {}) {
  teardown();
  renderAuth(root, {
    error,
    onCancel: lastStatus?.adminDemoUnlockEnabled ? () => boot() : undefined,
    async onSubmit(value) {
      try {
        const result = await verifyToken(value);
        if (!result.ok) return "암호가 올바르지 않습니다.";
        setToken(value);
        startShell(result.status);
        return undefined;
      } catch (err) {
        return errorMessage(err);
      }
    }
  });
}

// 시작. 보관된 암호로 상태를 묻는다(실제 모드에서는 첫 호출이 2~3초 걸린다)
async function boot() {
  teardown();
  renderLoading(root);
  let status;
  try {
    status = await adminApi.status();
  } catch (err) {
    if (err?.status === 401) {
      clearToken();   // 보관된 암호가 있었다면 더는 맞지 않는 것이다
      showAuth();
      return;
    }
    if (err?.code === "ADMIN_PASSWORD_NOT_SET") {
      renderStop(root, errorText("ADMIN_PASSWORD_NOT_SET"));
      return;
    }
    renderStop(root, errorMessage(err), { retry: () => boot() });
    return;
  }
  lastStatus = status;
  // 조회 전용 열기에서는 GET이 늘 통과하므로, 보관된 암호가 아직 맞는지 따로 본다. 틀렸으면 지우고 조회 전용으로 연다
  const stored = getToken();
  if (status?.adminDemoUnlockEnabled && stored) {
    try {
      const result = await verifyToken(stored, { knownStatus: status });
      if (!result.ok) clearToken();
    } catch (err) {
      if (err?.code === "ADMIN_PASSWORD_NOT_SET") clearToken();   // 서버에 암호가 없으면 보관된 암호는 쓸 데가 없다
    }
  }
  startShell(status);
}

boot();
