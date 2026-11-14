import { createHash } from "node:crypto";
import { newToken } from "./session.js";

// 카카오 로그인(OpenID Connect). 공식 문서: https://developers.kakao.com/docs/latest/ko/kakaologin/rest-api
export const KAKAO_AUTHORIZE_URL = "https://kauth.kakao.com/oauth/authorize";
export const KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token";
export const KAKAO_TOKENINFO_URL = "https://kauth.kakao.com/oauth/tokeninfo";
export const KAKAO_UNLINK_URL = "https://kapi.kakao.com/v1/user/unlink";
export const KAKAO_ISSUER = "https://kauth.kakao.com";

const TIMEOUT_MS = 10_000;

export class KakaoAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "KakaoAuthError";
  }
}

export function createPkcePair() {
  const verifier = newToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    nonce: input.nonce,
    scope: "openid profile_nickname",
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256"
  });
  return `${KAKAO_AUTHORIZE_URL}?${params.toString()}`;
}

async function postForm(url: string, body: Record<string, string>, fetchImpl: typeof fetch, headers: Record<string, string> = {}) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", ...headers },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new KakaoAuthError(`카카오 서버에 연결하지 못했어: ${(error as Error).message}`, "KAKAO_NETWORK");
  }
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = String(data.error_description ?? data.msg ?? data.error ?? `HTTP ${response.status}`);
    throw new KakaoAuthError(`카카오 요청이 실패했어: ${detail}`, "KAKAO_HTTP");
  }
  return data;
}

export async function exchangeCode(
  input: { clientId: string; clientSecret?: string; redirectUri: string; code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch
) {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier
  };
  if (input.clientSecret) body.client_secret = input.clientSecret;
  const data = await postForm(KAKAO_TOKEN_URL, body, fetchImpl);
  const idToken = typeof data.id_token === "string" ? data.id_token : "";
  if (!idToken) {
    throw new KakaoAuthError("ID 토큰이 없어. 카카오 개발자 콘솔에서 OpenID Connect를 켜야 해.", "KAKAO_NO_ID_TOKEN");
  }
  return { idToken };
}

export interface KakaoIdentity {
  sub: string;
  nickname: string;
}

// ID 토큰 서명 검증은 카카오의 토큰 정보 API에 맡기고, 발급자·대상·nonce·만료는 여기서 다시 확인한다.
export async function verifyIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<KakaoIdentity> {
  const payload = await postForm(KAKAO_TOKENINFO_URL, { id_token: idToken }, fetchImpl);
  return checkIdTokenPayload(payload, expected, now);
}

export function checkIdTokenPayload(payload: Record<string, unknown>, expected: { clientId: string; nonce: string }, now = Date.now()): KakaoIdentity {
  if (payload.iss !== KAKAO_ISSUER) throw new KakaoAuthError("ID 토큰 발급자가 카카오가 아니야.", "KAKAO_BAD_ISSUER");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expected.clientId)) throw new KakaoAuthError("ID 토큰 대상 앱이 달라.", "KAKAO_BAD_AUDIENCE");
  if (!expected.nonce || payload.nonce !== expected.nonce) throw new KakaoAuthError("로그인 요청 정보(nonce)가 맞지 않아.", "KAKAO_BAD_NONCE");
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now) throw new KakaoAuthError("ID 토큰이 만료됐어.", "KAKAO_TOKEN_EXPIRED");
  const sub = String(payload.sub ?? "").trim();
  if (!sub) throw new KakaoAuthError("카카오 회원번호가 없어.", "KAKAO_NO_SUB");
  return { sub, nickname: String(payload.nickname ?? "").trim() };
}

// 탈퇴할 때 카카오와의 연결을 끊는다(앱 어드민 키 사용).
export async function unlinkKakaoUser(input: { adminKey: string; kakaoUserId: string }, fetchImpl: typeof fetch = fetch) {
  await postForm(
    KAKAO_UNLINK_URL,
    { target_id_type: "user_id", target_id: input.kakaoUserId },
    fetchImpl,
    { Authorization: `KakaoAK ${input.adminKey}` }
  );
}
