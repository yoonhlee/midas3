import { ApiRequestError, api, esc, getSession, qs, renderFooter, renderHeader } from "./common/site.js";

const main = document.getElementById("main");
const returnTo = (() => {
  const raw = qs("return") || "/me.html";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/me.html";
})();

// 로그인 취소·실패 안내(U01-8)
const ERROR_MESSAGES = {
  cancelled: "카카오 로그인을 취소했어. 다시 하려면 아래 버튼을 눌러줘.",
  failed: "로그인 중에 문제가 생겼어. 잠시 후 다시 시도해줘. 계속되면 다른 브라우저로 해봐.",
  expired: "로그인 시간이 지났어. 처음부터 다시 시도해줘.",
  kakao_unavailable: "카카오 로그인이 아직 설정되지 않았어. 운영자에게 알려줘."
};

function renderLogin(session) {
  const error = qs("error");
  const anon = session.anonymous_results || 0;
  main.innerHTML = `
    <div class="eyebrow">로그인</div>
    <h1 class="page-h">기록을 남기려면 로그인해줘</h1>
    <p class="page-sub">직무 탐색·비교·체험은 로그인 없이 할 수 있어. 관심 직무 저장과 내 기록 보기에만 로그인이 필요해.</p>
    ${error ? `<div class="notice notice-err" role="alert">${esc(ERROR_MESSAGES[error] || ERROR_MESSAGES.failed)}</div>` : ""}
    ${anon ? `<div class="notice notice-ok">이 브라우저에서 로그인 전에 한 체험 결과 ${anon}개가 있어. 로그인하면 내 기록으로 옮겨줄게.</div>` : ""}
    <div class="card">
      ${session.providers?.kakao
        ? `<a class="btn btn-kakao" style="width:100%" href="/auth/kakao/start?return=${encodeURIComponent(returnTo)}">카카오로 시작하기</a>
           <p class="small muted" style="margin-top:10px">처음이면 약관 동의와 만 14세 이상 확인을 거쳐 가입돼. 비밀번호는 따로 만들지 않아.</p>`
        : `<p class="muted">카카오 로그인이 아직 설정되지 않았어.</p>`}
    </div>
    ${session.providers?.dev ? `<div class="card" style="margin-top:12px">
      <form id="dev-form">
        <p class="small muted" style="margin-bottom:8px">개발·테스트용 로그인이야. 운영 서버에서는 보이지 않아.</p>
        <div class="field"><label for="dev-id">테스트 계정 ID(영문·숫자)</label><input class="input" id="dev-id" required pattern="[A-Za-z0-9_\\-]{2,32}" value="tester"></div>
        <button class="btn" type="submit">개발용으로 로그인</button>
      </form></div>` : ""}
    <p class="small muted" style="margin-top:16px"><a href="/terms.html">이용약관</a> · <a href="/privacy.html">개인정보 처리방침</a></p>`;

  document.getElementById("dev-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = document.getElementById("dev-id").value.trim();
    try {
      const result = await api("POST", "/api/auth/dev-login", { id, nickname: id, returnTo });
      if (result.status === "signup_required") {
        location.href = "/login.html?step=signup";
      } else {
        location.href = withClaimed(result.returnTo || returnTo, result.claimed);
      }
    } catch (error) {
      main.insertAdjacentHTML("afterbegin", `<div class="notice notice-err" role="alert">${esc(error.message)}</div>`);
    }
  });
}

function withClaimed(url, claimed) {
  if (!claimed) return url;
  return `${url}${url.includes("?") ? "&" : "?"}claimed=${claimed}`;
}

// 첫 가입: 약관 동의, 만 14세 이상 확인, 닉네임(U01-1)
async function renderSignup() {
  let pending;
  try {
    pending = await api("GET", "/api/auth/signup");
  } catch (error) {
    main.innerHTML = `<div class="notice notice-err" role="alert">${esc(error.message)}</div><a class="btn" href="/login.html">다시 로그인</a>`;
    return;
  }
  main.innerHTML = `
    <div class="eyebrow">처음 오셨네</div>
    <h1 class="page-h">가입을 마무리해줘</h1>
    <p class="page-sub">아래 세 가지에 모두 동의해야 가입할 수 있어.</p>
    <form class="card" id="signup-form" novalidate>
      <div class="field"><label for="nickname">닉네임 (2~20자)</label>
        <input class="input" id="nickname" maxlength="20" required value="${esc(pending.nickname)}"></div>
      <label class="check"><input type="checkbox" id="agree-terms" required> <span>[필수] <a href="/terms.html" target="_blank" rel="noopener">이용약관</a>에 동의해.</span></label>
      <label class="check"><input type="checkbox" id="agree-privacy" required> <span>[필수] <a href="/privacy.html" target="_blank" rel="noopener">개인정보 수집·이용</a>에 동의해. 체험 답변은 채점을 위해 OpenAI(미국)로 전송돼.</span></label>
      <label class="check"><input type="checkbox" id="confirm-age" required> <span>[필수] 만 14세 이상이야.</span></label>
      <div id="signup-error"></div>
      <div class="btn-row" style="margin-top:14px"><button class="btn btn-p" type="submit">가입하고 시작하기</button><a class="btn" href="/login.html">취소</a></div>
    </form>
    <p class="small muted" style="margin-top:10px">약관 버전 ${esc(pending.terms_version)}</p>`;

  document.getElementById("signup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = document.getElementById("signup-error");
    const body = {
      nickname: document.getElementById("nickname").value,
      agreeTerms: document.getElementById("agree-terms").checked,
      agreePrivacy: document.getElementById("agree-privacy").checked,
      confirmAge14: document.getElementById("confirm-age").checked
    };
    if (!body.agreeTerms || !body.agreePrivacy || !body.confirmAge14) {
      errorBox.innerHTML = `<div class="notice notice-err" role="alert">필수 항목에 모두 동의해줘. 만 14세 미만은 가입할 수 없어.</div>`;
      return;
    }
    try {
      const result = await api("POST", "/api/auth/signup", body);
      location.href = withClaimed(result.returnTo || "/me.html", result.claimed);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.code === "SIGNUP_EXPIRED")) {
        location.href = "/login.html?error=expired";
        return;
      }
      errorBox.innerHTML = `<div class="notice notice-err" role="alert">${esc(error.message)}</div>`;
    }
  });
}

async function start() {
  renderHeader("me");
  renderFooter();
  if (qs("step") === "signup") return renderSignup();
  const session = await getSession();
  if (session.authenticated && !qs("error")) {
    main.innerHTML = `<div class="notice notice-ok">이미 ${esc(session.user.nickname)}(으)로 로그인했어.</div><a class="btn btn-p" href="${esc(returnTo)}">계속하기</a>`;
    return;
  }
  renderLogin(session);
}

start();
