import express from "express";
import { z } from "zod";
import type { Db } from "../../lib/db/database.js";
import {
  claimAnonymousAttempts,
  countAnonymousAttempts,
  createUser,
  deleteUser,
  findUserByProvider,
  insertAuthFlow,
  peekAuthFlow,
  takeAuthFlow,
  touchUserLogin,
  updateNickname,
  type UserRow
} from "../../lib/db/repos.js";
import {
  KakaoAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  unlinkKakaoUser,
  verifyIdToken
} from "../../lib/auth/kakao.js";
import {
  LOGIN_FLOW_COOKIE,
  SESSION_COOKIE,
  SIGNUP_COOKIE,
  createSession,
  destroySession,
  newToken,
  normalizeNickname,
  safeReturnTo,
  suggestNickname
} from "../../lib/auth/session.js";
import { TERMS_VERSION } from "../../lib/auth/terms.js";
import type { ServerConfig } from "../config.js";
import { clearCookie, sendApiError, setCookie } from "../http.js";
import { getAuth, requireCsrf, requireUser } from "../authContext.js";

const LOGIN_FLOW_TTL_MS = 10 * 60 * 1000;
const SIGNUP_FLOW_TTL_MS = 15 * 60 * 1000;

const SignupSchema = z.object({
  nickname: z.string(),
  agreeTerms: z.literal(true),
  agreePrivacy: z.literal(true),
  confirmAge14: z.literal(true)
});

const DevLoginSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/),
  nickname: z.string().optional(),
  returnTo: z.string().optional()
});

export interface AuthDeps {
  db: Db;
  config: ServerConfig;
  fetchImpl?: typeof fetch;
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    nickname: user.nickname,
    provider: user.provider,
    created_at: user.created_at,
    terms_version: user.terms_version
  };
}

function loginErrorRedirect(res: express.Response, reason: string, returnTo?: string) {
  const params = new URLSearchParams({ error: reason });
  if (returnTo) params.set("return", returnTo);
  return res.redirect(303, `/login.html?${params.toString()}`);
}

export function authRouter({ db, config, fetchImpl = fetch }: AuthDeps) {
  const router = express.Router();
  const kakaoEnabled = Boolean(config.auth.kakaoClientId);
  const policy = { idleDays: config.auth.sessionIdleDays, maxDays: config.auth.sessionMaxDays };

  // 로그인 성공: 세션을 만들고, 같은 브라우저에서 로그인 전에 한 체험 결과를 내 기록으로 옮긴다.
  function startSession(res: express.Response, user: UserRow) {
    const auth = getAuth(res);
    if (auth.sessionToken) destroySession(db, auth.sessionToken);
    const session = createSession(db, user.id, policy);
    setCookie(res, SESSION_COOKIE, session.token, { secure: config.cookieSecure, maxAgeSec: session.maxAgeSec });
    touchUserLogin(db, user.id);
    let claimed = 0;
    if (auth.anonId) claimed = claimAnonymousAttempts(db, auth.anonId, user.id);
    return { csrf: session.csrf, claimed };
  }

  // 외부 계정 확인이 끝난 뒤 공통 처리: 가입한 사람은 로그인, 처음이면 약관 동의 화면으로.
  function completeIdentity(res: express.Response, identity: { provider: string; providerUserId: string; nickname: string }, returnTo: string) {
    const existing = findUserByProvider(db, identity.provider, identity.providerUserId);
    if (existing) {
      const { claimed } = startSession(res, existing);
      return { status: "logged_in" as const, returnTo, claimed };
    }
    const flowId = insertAuthFlow(db, "signup", {
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      nickname: suggestNickname(identity.nickname),
      returnTo
    }, SIGNUP_FLOW_TTL_MS);
    setCookie(res, SIGNUP_COOKIE, flowId, { secure: config.cookieSecure, maxAgeSec: SIGNUP_FLOW_TTL_MS / 1000 });
    return { status: "signup_required" as const, returnTo };
  }

  router.get("/auth/kakao/start", (req, res) => {
    const returnTo = safeReturnTo(req.query.return);
    if (!kakaoEnabled) return loginErrorRedirect(res, "kakao_unavailable", returnTo);
    const state = newToken(18);
    const nonce = newToken(18);
    const pkce = createPkcePair();
    const flowId = insertAuthFlow(db, "login", { state, nonce, verifier: pkce.verifier, returnTo }, LOGIN_FLOW_TTL_MS);
    setCookie(res, LOGIN_FLOW_COOKIE, flowId, { secure: config.cookieSecure, maxAgeSec: LOGIN_FLOW_TTL_MS / 1000 });
    return res.redirect(302, buildAuthorizeUrl({
      clientId: config.auth.kakaoClientId,
      redirectUri: config.auth.kakaoRedirectUri,
      state,
      nonce,
      codeChallenge: pkce.challenge
    }));
  });

  router.get("/auth/kakao/callback", async (req, res) => {
    const auth = getAuth(res);
    const flowId = auth.cookies[LOGIN_FLOW_COOKIE];
    clearCookie(res, LOGIN_FLOW_COOKIE, config.cookieSecure);
    const flow = flowId ? takeAuthFlow(db, flowId, "login") : null;
    const returnTo = safeReturnTo(flow?.returnTo);
    // 사용자가 동의 화면에서 취소한 경우
    if (req.query.error) {
      const reason = req.query.error === "access_denied" ? "cancelled" : "failed";
      return loginErrorRedirect(res, reason, returnTo);
    }
    if (!flow || typeof req.query.state !== "string" || req.query.state !== flow.state) {
      return loginErrorRedirect(res, "expired", returnTo);
    }
    if (typeof req.query.code !== "string" || !req.query.code) return loginErrorRedirect(res, "failed", returnTo);
    try {
      const { idToken } = await exchangeCode({
        clientId: config.auth.kakaoClientId,
        clientSecret: config.auth.kakaoClientSecret || undefined,
        redirectUri: config.auth.kakaoRedirectUri,
        code: req.query.code,
        codeVerifier: String(flow.verifier ?? "")
      }, fetchImpl);
      const identity = await verifyIdToken(idToken, { clientId: config.auth.kakaoClientId, nonce: String(flow.nonce ?? "") }, fetchImpl);
      const result = completeIdentity(res, { provider: "kakao", providerUserId: identity.sub, nickname: identity.nickname }, returnTo);
      if (result.status === "signup_required") return res.redirect(303, "/login.html?step=signup");
      const suffix = result.claimed ? `${returnTo.includes("?") ? "&" : "?"}claimed=${result.claimed}` : "";
      return res.redirect(303, `${returnTo}${suffix}`);
    } catch (error) {
      const code = error instanceof KakaoAuthError ? error.code : "KAKAO_UNKNOWN";
      console.error("[auth] kakao login failed:", code, (error as Error).message);
      return loginErrorRedirect(res, "failed", returnTo);
    }
  });

  // 개발·테스트용 로그인: 소셜 계정 없이 같은 가입·로그인 흐름을 탄다. 운영에서는 꺼진다.
  router.post("/api/auth/dev-login", (req, res) => {
    if (!config.auth.devLogin) return sendApiError(res, 404, "NOT_FOUND", "No API route for POST /api/auth/dev-login.");
    const parsed = DevLoginSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendApiError(res, 400, "DEV_LOGIN_BAD_REQUEST", "id는 영문·숫자 2~32자여야 해.", parsed.error.issues);
    const result = completeIdentity(res, {
      provider: "dev",
      providerUserId: parsed.data.id,
      nickname: parsed.data.nickname ?? parsed.data.id
    }, safeReturnTo(parsed.data.returnTo));
    return res.json(result);
  });

  router.get("/api/auth/session", (_req, res) => {
    const auth = getAuth(res);
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      authenticated: Boolean(auth.user),
      user: auth.user ? publicUser(auth.user) : null,
      csrf_token: auth.session?.csrf_token ?? null,
      providers: { kakao: kakaoEnabled, dev: config.auth.devLogin },
      anonymous_results: auth.anonId && !auth.user ? countAnonymousAttempts(db, auth.anonId) : 0,
      terms_version: TERMS_VERSION
    });
  });

  router.get("/api/auth/signup", (_req, res) => {
    const auth = getAuth(res);
    const flowId = auth.cookies[SIGNUP_COOKIE];
    const flow = flowId ? peekAuthFlow(db, flowId, "signup") : null;
    if (!flow) return sendApiError(res, 404, "SIGNUP_NOT_PENDING", "가입 진행 정보가 없거나 만료됐어. 다시 로그인해줘.");
    return res.json({ nickname: flow.nickname, provider: flow.provider, terms_version: TERMS_VERSION });
  });

  router.post("/api/auth/signup", (req, res) => {
    const auth = getAuth(res);
    const parsed = SignupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendApiError(res, 400, "SIGNUP_CONSENT_REQUIRED", "이용약관·개인정보 처리방침 동의와 만 14세 이상 확인이 모두 필요해.", parsed.error.issues);
    }
    const nickname = normalizeNickname(parsed.data.nickname);
    if (!nickname) return sendApiError(res, 400, "NICKNAME_INVALID", "닉네임은 2~20자(한글·영문·숫자·공백·_-.)로 정해줘.");
    const flowId = auth.cookies[SIGNUP_COOKIE];
    const flow = flowId ? takeAuthFlow(db, flowId, "signup") : null;
    clearCookie(res, SIGNUP_COOKIE, config.cookieSecure);
    if (!flow) return sendApiError(res, 410, "SIGNUP_EXPIRED", "가입 진행 시간이 지났어. 다시 로그인해줘.");
    const provider = String(flow.provider);
    const providerUserId = String(flow.providerUserId);
    const user = findUserByProvider(db, provider, providerUserId)
      ?? createUser(db, { provider, providerUserId, nickname, termsVersion: TERMS_VERSION });
    const { csrf, claimed } = startSession(res, user);
    return res.status(201).json({ user: publicUser(user), csrf_token: csrf, returnTo: safeReturnTo(flow.returnTo), claimed });
  });

  router.post("/api/auth/logout", requireCsrf, (_req, res) => {
    const auth = getAuth(res);
    destroySession(db, auth.sessionToken ?? undefined);
    clearCookie(res, SESSION_COOKIE, config.cookieSecure);
    return res.json({ ok: true });
  });

  router.patch("/api/me", requireUser, requireCsrf, (req, res) => {
    const auth = getAuth(res);
    const nickname = normalizeNickname((req.body ?? {}).nickname);
    if (!nickname) return sendApiError(res, 400, "NICKNAME_INVALID", "닉네임은 2~20자(한글·영문·숫자·공백·_-.)로 정해줘.");
    updateNickname(db, auth.user!.id, nickname);
    return res.json({ user: publicUser({ ...auth.user!, nickname }) });
  });

  // 탈퇴: 카카오 연결을 끊고 계정과 모든 기록을 지운다.
  router.delete("/api/me", requireUser, requireCsrf, async (req, res) => {
    const auth = getAuth(res);
    const user = auth.user!;
    if ((req.body ?? {}).confirm !== "탈퇴") {
      return sendApiError(res, 400, "WITHDRAW_CONFIRM_REQUIRED", "확인 문구 '탈퇴'를 입력해줘.");
    }
    let kakaoUnlink: "done" | "skipped" | "failed" = "skipped";
    if (user.provider === "kakao") {
      if (config.auth.kakaoAdminKey) {
        try {
          await unlinkKakaoUser({ adminKey: config.auth.kakaoAdminKey, kakaoUserId: user.provider_user_id }, fetchImpl);
          kakaoUnlink = "done";
        } catch (error) {
          kakaoUnlink = "failed";
          console.error("[auth] kakao unlink failed:", (error as Error).message);
        }
      } else {
        console.warn("[auth] KAKAO_ADMIN_KEY가 없어 카카오 연결 끊기를 건너뛰었어.");
      }
    }
    deleteUser(db, user.id);
    clearCookie(res, SESSION_COOKIE, config.cookieSecure);
    return res.json({ ok: true, kakao_unlink: kakaoUnlink });
  });

  return router;
}
