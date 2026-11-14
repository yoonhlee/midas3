/* 비교 담기(U07-1): 로그인 없이 브라우저에 최대 3개까지 담고, 페이지를 옮겨도 남는다. */
import { esc, updateCompareBadge } from "./site.js";

const KEY = "jobsim:compare:v1";
export const COMPARE_MAX = 3;

export function readCompare() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((item) => item && /^K\d{9}$/.test(item.code)).slice(0, COMPARE_MAX) : [];
  } catch (_) {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (_) {
    // 저장소를 못 쓰면 이 페이지에서만 유지된다.
  }
  updateCompareBadge(list.length);
  renderTray();
  window.dispatchEvent(new CustomEvent("jobsim:compare-changed", { detail: list }));
}

export function isInCompare(code) {
  return readCompare().some((item) => item.code === code);
}

// 결과: "added" | "removed" | "full"
export function toggleCompare(job) {
  const list = readCompare();
  if (list.some((item) => item.code === job.code)) {
    write(list.filter((item) => item.code !== job.code));
    return "removed";
  }
  if (list.length >= COMPARE_MAX) return "full";
  write([...list, { code: job.code, name: job.name }]);
  return "added";
}

export function removeFromCompare(code) {
  write(readCompare().filter((item) => item.code !== code));
}

export function clearCompare() {
  write([]);
}

// 화면 오른쪽 아래 비교 바
export function renderTray() {
  let tray = document.getElementById("compare-tray");
  const list = readCompare();
  if (location.pathname.endsWith("/compare.html") || !list.length) {
    tray?.remove();
    return;
  }
  if (!tray) {
    tray = document.createElement("div");
    tray.id = "compare-tray";
    tray.className = "compare-tray";
    tray.setAttribute("role", "region");
    tray.setAttribute("aria-label", "비교 담기");
    document.body.appendChild(tray);
  }
  tray.innerHTML = `<span class="names">비교 ${list.length}/${COMPARE_MAX}: ${list.map((item) => esc(item.name)).join(", ")}</span>
    <a class="btn btn-sm btn-p" href="/compare.html">비교하기</a>`;
}

export function initCompareTray() {
  updateCompareBadge(readCompare().length);
  renderTray();
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) {
      updateCompareBadge(readCompare().length);
      renderTray();
    }
  });
}
