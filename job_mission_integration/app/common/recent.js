/* 최근 본 직무(U04-4): 브라우저에 최근 8개까지 기억한다. */
const KEY = "jobsim:recent-jobs:v1";
const MAX = 8;

export function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((item) => item && /^K\d{9}$/.test(item.code)) : [];
  } catch (_) {
    return [];
  }
}

export function pushRecent(job) {
  const list = [{ code: job.code, name: job.name, at: Date.now() }, ...readRecent().filter((item) => item.code !== job.code)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (_) {
    // 저장소를 못 쓰면 기억하지 않는다.
  }
}

export function clearRecent() {
  try {
    localStorage.removeItem(KEY);
  } catch (_) {
    // 무시
  }
}
