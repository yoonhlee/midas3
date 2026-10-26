/* 결과 화면 마지막 섹션: "지금 이 일을 뽑는 곳" — 체험한 직업의 고용24 채용공고 지도·목록 */

import { getJobPostings } from "../api-client/jobsimApi.js";
import { createPostingsMap } from "./postingsMap.js";

const PAGE_SIZE = 10;
const METRO = new Set(["서울", "인천", "경기"]);
const COMPANY_TYPES = [
  { key: "large", coTp: "01", label: "대기업" },
  { key: "public", coTp: "04", label: "공공기관" },
  { key: "foreign", coTp: "05", label: "외국계" }
];
const PERIOD_LABEL = { "D-0": "오늘", "D-3": "최근 3일", "W-1": "최근 1주", "W-2": "최근 2주", "M-1": "최근 한 달" };

const responseCache = new Map();
let active = null;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function safeHref(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch (_) {
    return "";
  }
}

function linkHtml(url, label, className) {
  const href = safeHref(url);
  if (!href) return "";
  return `<a class="${className}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function formatKst(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || "");
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}.${get("month")}.${get("day")} ${get("hour")}:${get("minute")}`;
}

function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : "";
}

function closeText(item) {
  if (item.close_type === "until_filled") {
    return item.close_date ? `채용시까지 (${shortDate(item.close_date)})` : "채용시까지";
  }
  if (item.close_type === "date" && item.close_date) return `${shortDate(item.close_date)} 마감`;
  return "마감일 미상";
}

function placeText(item) {
  return [item.sido, item.sigungu].filter(Boolean).join(" ") || "지역 미상";
}

function companyTypeLabel(key) {
  return COMPANY_TYPES.find((t) => t.key === key)?.label || "";
}

function badgeHtml(item, enabledTypes) {
  if (!item.company_type || !enabledTypes.has(item.company_type)) return "";
  return `<span class="pst-badge pst-badge-${esc(item.company_type)}">${esc(companyTypeLabel(item.company_type))}</span>`;
}

// 마감 임박순: 날짜 있는 것 → 채용시까지(날짜 없음) → 미상
function closeRank(item) {
  if (item.close_date) return 0;
  return item.close_type === "until_filled" ? 1 : 2;
}
function sortByClosing(items) {
  return [...items].sort((a, b) =>
    closeRank(a) - closeRank(b) ||
    String(a.close_date || "").localeCompare(String(b.close_date || "")) ||
    String(b.reg_date || "").localeCompare(String(a.reg_date || ""))
  );
}

function enabledCompanyTypes(data) {
  const applied = data.checks?.company_type_filter_applied || {};
  return new Set(COMPANY_TYPES.filter((t) => applied[t.coTp] === true).map((t) => t.key));
}

function skeletonHtml() {
  return `<div class="pst-skeleton" aria-hidden="true">
    <div class="pst-sk pst-sk-line"></div>
    <div class="pst-sk pst-sk-line short"></div>
    <div class="pst-sk pst-sk-map"></div>
  </div><span class="pst-sr">채용공고를 불러오는 중이야.</span>`;
}

function messageHtml(text, { retry = false } = {}) {
  return `<div class="pst-msg">${esc(text)}${retry ? ` <button type="button" class="pst-retry">다시 시도</button>` : ""}</div>`;
}

function sourceHtml(data) {
  const parts = ["출처: 고용24 채용정보 Open API"];
  if (data.fetched_at) parts.push(`${formatKst(data.fetched_at)} 기준`);
  parts.push("근무지 주소 기준");
  if (data.query?.mode === "keyword" && data.query.keyword) {
    parts.push(`'${data.query.keyword}' 검색 결과`);
  } else if (data.query?.occupation?.length) {
    parts.push(`직종 ${data.query.occupation.map((o) => `${o.code} ${o.name}`).join(", ")}`);
  }
  return `<p class="pst-source">${esc(parts.join(" · "))}. 지원 전에 공고 원문을 꼭 확인해.</p>`;
}

function summaryHtml(data, enabledTypes) {
  const c = data.counts;
  const period = PERIOD_LABEL[data.query?.regDate] || "최근";
  const total = c.kept;
  const pct = total ? Math.round((c.metro / total) * 100) : 0;
  const sentences = [
    `${period} 고용24에 올라온 ${esc(data.job_name)} 공고 중 지금 지원할 수 있는 건 <strong>${total}건</strong>이야. 수도권 ${c.metro}건(${pct}%), 비수도권 ${c.nonmetro}건이야.`
  ];
  if (c.region_unknown > 0) sentences.push(`지역을 알 수 없는 공고는 ${c.region_unknown}건이야.`);
  if (c.nonmetro > 0) {
    const top = Object.entries(c.by_sido || {}).filter(([sido, n]) => !METRO.has(sido) && n > 0).slice(0, 2);
    if (top.length) sentences.push(`비수도권에서는 ${top.map(([sido, n]) => `${esc(sido)}(${n}건)`).join(", ")}에 많아.`);
  }
  const typeParts = COMPANY_TYPES
    .filter((t) => enabledTypes.has(t.key) && (c.company_type?.[t.key] || 0) > 0)
    .map((t) => `${t.label} ${c.company_type[t.key]}건`);
  const typeLine = typeParts.length ? `<p class="pst-types">${esc(typeParts.join(" · "))}</p>` : "";
  return `<p class="pst-summary">${sentences.join(" ")}</p>${typeLine}`;
}

function chipsHtml(data) {
  const chips = Object.entries(data.counts.by_sido || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([sido, n]) => `<li class="pst-chip">${esc(sido)} <b>${n}</b></li>`);
  return chips.length ? `<ul class="pst-chips" aria-label="시도별 공고 수">${chips.join("")}</ul>` : "";
}

function filtersHtml(ctx) {
  const { data, filters, enabledTypes } = ctx;
  const region = [["all", "전국"], ["metro", "수도권"], ["nonmetro", "비수도권"]]
    .map(([key, label]) => `<button type="button" class="pst-filter" data-pst-region="${key}" aria-pressed="${filters.region === key}">${label}</button>`)
    .join("");
  const types = COMPANY_TYPES.filter((t) => enabledTypes.has(t.key) && (data.counts.company_type?.[t.key] || 0) > 0);
  const typeButtons = types.length
    ? `<div class="pst-filter-group" role="group" aria-label="기업형태">
        <button type="button" class="pst-filter" data-pst-ctype="all" aria-pressed="${filters.ctype === "all"}">전체</button>
        ${types.map((t) => `<button type="button" class="pst-filter" data-pst-ctype="${t.key}" aria-pressed="${filters.ctype === t.key}">${t.label}</button>`).join("")}
      </div>`
    : "";
  return `<div class="pst-filters">
    <div class="pst-filter-group" role="group" aria-label="지역">${region}</div>
    ${typeButtons}
  </div>`;
}

function filteredItems(ctx) {
  const { region, ctype } = ctx.filters;
  return ctx.items.filter((item) => {
    if (region === "metro" && item.is_metro !== true) return false;
    if (region === "nonmetro" && item.is_metro !== false) return false;
    if (ctype !== "all" && item.company_type !== ctype) return false;
    return true;
  });
}

function popupHtml(items, enabledTypes) {
  const rows = items.map((item) => `<li class="pst-pop-item">
      <div class="pst-pop-co">${esc(item.company || "회사명 없음")} ${badgeHtml(item, enabledTypes)}</div>
      <div class="pst-pop-title">${esc(item.title)}</div>
      <div class="pst-pop-meta">${esc(placeText(item))} · ${esc(closeText(item))}${item.geo_precision === "region" ? " · 대략 위치" : ""}</div>
      ${linkHtml(item.url, "공고 보기", "pst-pop-link")}
    </li>`).join("");
  return `<ul class="pst-pop">${rows}</ul>`;
}

function listItemHtml(item, enabledTypes) {
  return `<li class="pst-item">
    <div class="pst-item-head">
      <span class="pst-co">${esc(item.company || "회사명 없음")}</span>
      ${badgeHtml(item, enabledTypes)}
    </div>
    <div class="pst-title">${esc(item.title)}</div>
    <div class="pst-meta">
      <span>${esc(placeText(item))}</span>
      <span>${esc(closeText(item))}</span>
      ${item.salary_text ? `<span>${esc(item.salary_text)}</span>` : ""}
      ${item.geo_precision === "none" ? `<span class="pst-nomap">지도에 없음</span>` : ""}
    </div>
    ${linkHtml(item.url, "공고 보기 ↗", "pst-link")}
  </li>`;
}

function renderList(ctx) {
  const listRoot = ctx.root.querySelector(".pst-list-wrap");
  if (!listRoot) return;
  const items = filteredItems(ctx);
  const visible = items.slice(0, ctx.shown);
  const rest = items.length - visible.length;
  listRoot.innerHTML = `<div class="pst-list-head">
      <span class="pst-count" data-count="${items.length}">공고 ${items.length}건</span>
      <span class="pst-sort">마감 임박순</span>
    </div>
    ${items.length
      ? `<ul class="pst-list">${visible.map((item) => listItemHtml(item, ctx.enabledTypes)).join("")}</ul>`
      : `<p class="pst-msg">이 조건에 맞는 공고가 없어.</p>`}
    ${rest > 0 ? `<button type="button" class="pst-more">더 보기 (${rest}건 남음)</button>` : ""}`;
}

function updateFilterButtons(ctx) {
  ctx.root.querySelectorAll("[data-pst-region]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.pstRegion === ctx.filters.region));
  });
  ctx.root.querySelectorAll("[data-pst-ctype]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.pstCtype === ctx.filters.ctype));
  });
}

function applyFilters(ctx) {
  ctx.shown = PAGE_SIZE;
  updateFilterButtons(ctx);
  renderList(ctx);
  try {
    ctx.map?.setItems(filteredItems(ctx), { fit: true });
  } catch (error) {
    console.warn("[postings] 지도 갱신 실패", error);
  }
}

function bodyOf(ctx) {
  return ctx.root.querySelector(".pst-body");
}

async function mountMap(ctx) {
  const container = ctx.root.querySelector(".pst-map");
  if (!container) return;
  try {
    const map = await createPostingsMap(container, { renderPopup: (items) => popupHtml(items, ctx.enabledTypes) });
    if (!map) return;
    if (active !== ctx) {
      map.destroy();
      return;
    }
    ctx.map = map;
    map.setItems(filteredItems(ctx), { fit: ctx.filters.region !== "all" || ctx.filters.ctype !== "all" });
  } catch (error) {
    console.warn("[postings] 지도를 만들지 못했어", error);
    container.outerHTML = `<p class="pst-msg">지도를 불러오지 못했어. 아래 목록에서 공고를 볼 수 있어.</p>`;
  }
}

function renderData(ctx) {
  const body = bodyOf(ctx);
  if (!body) return;
  const data = ctx.data;
  const period = PERIOD_LABEL[data.query?.regDate] || "최근";
  switch (data.status) {
    case "unmapped":
      body.innerHTML = messageHtml("이 직업은 공고 연결을 준비 중이야.");
      return;
    case "unconfigured":
      body.innerHTML = messageHtml("채용공고 연동이 아직 설정되지 않았어.");
      return;
    case "error":
      body.innerHTML = messageHtml("공고를 불러오지 못했어. 잠시 후 다시 시도해줘.", { retry: true });
      return;
    default:
      break;
  }
  const stale = data.status === "stale"
    ? `<p class="pst-stale" role="status">공고 갱신이 늦어지고 있어. <strong>${esc(formatKst(data.fetched_at))}</strong> 기준이야.</p>`
    : "";
  if (data.status === "empty" || !data.counts || !data.items.length) {
    body.innerHTML = `${stale}${messageHtml(`${period} 동안 이 직종으로 올라온 공고가 없어. 공고는 매일 갱신돼.`)}${sourceHtml(data)}`;
    return;
  }

  ctx.enabledTypes = enabledCompanyTypes(data);
  ctx.items = sortByClosing(data.items);
  const hasCoords = ctx.items.some((item) => typeof item.lat === "number" && typeof item.lng === "number");
  const mapHtml = hasCoords
    ? `<div class="pst-map" role="region" aria-label="${esc(`${data.job_name} 채용공고 근무지 지도. 같은 내용을 아래 목록에서도 볼 수 있어.`)}"></div>
       <div class="pst-legend" aria-hidden="true">
         <span><i class="pst-dot pst-dot-exact"></i>정확한 위치</span>
         <span><i class="pst-dot pst-dot-approx"></i>구·군 단위 대략 위치</span>
       </div>`
    : "";
  body.innerHTML = `${stale}
    ${summaryHtml(data, ctx.enabledTypes)}
    ${chipsHtml(data)}
    ${filtersHtml(ctx)}
    ${mapHtml}
    <div class="pst-list-wrap"></div>
    ${sourceHtml(data)}`;
  renderList(ctx);
  // 좌표가 있는 공고가 없으면 Leaflet도 불러오지 않는다.
  if (hasCoords) void mountMap(ctx);
}

async function load(ctx) {
  const body = bodyOf(ctx);
  if (body) body.innerHTML = skeletonHtml();
  try {
    let data = responseCache.get(ctx.jobCode);
    if (!data) {
      data = await getJobPostings(ctx.jobCode);
      if (data?.status !== "error") responseCache.set(ctx.jobCode, data);
    }
    if (active !== ctx) return;
    ctx.data = data;
    renderData(ctx);
  } catch (error) {
    if (active !== ctx) return;
    console.warn("[postings] 공고를 불러오지 못했어", error);
    const target = bodyOf(ctx);
    if (target) target.innerHTML = messageHtml("공고를 불러오지 못했어. 잠시 후 다시 시도해줘.", { retry: true });
  }
}

function onClick(ctx, event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const region = target.closest("[data-pst-region]");
  if (region) {
    ctx.filters.region = region.dataset.pstRegion;
    applyFilters(ctx);
    return;
  }
  const ctype = target.closest("[data-pst-ctype]");
  if (ctype) {
    ctx.filters.ctype = ctype.dataset.pstCtype;
    applyFilters(ctx);
    return;
  }
  if (target.closest(".pst-more")) {
    ctx.shown += PAGE_SIZE;
    renderList(ctx);
    return;
  }
  if (target.closest(".pst-retry")) {
    responseCache.delete(ctx.jobCode);
    void load(ctx);
  }
}

export function renderPostingsSectionShell() {
  return `<div class="rs pst" id="postings-section" role="region" aria-labelledby="pst-title">
    <div class="rs-title" id="pst-title">지금 이 일을 뽑는 곳</div>
    <div class="pst-body" aria-live="polite">${skeletonHtml()}</div>
  </div>`;
}

export function unmountPostingsSection() {
  const ctx = active;
  active = null;
  if (!ctx) return;
  try {
    ctx.root.removeEventListener("click", ctx.handler);
    ctx.map?.destroy();
  } catch (error) {
    console.warn("[postings] 정리 중 오류", error);
  }
}

// 결과 화면 DOM이 생긴 뒤 호출한다. 어떤 오류도 결과 화면의 다른 섹션으로 번지지 않게 감싼다.
export function mountPostingsSection(root, { jobCode }) {
  try {
    unmountPostingsSection();
    if (!root) return;
    if (!/^K\d{9}$/.test(String(jobCode || ""))) {
      const body = root.querySelector(".pst-body");
      if (body) body.innerHTML = messageHtml("이 직업은 공고 연결을 준비 중이야.");
      return;
    }
    const ctx = {
      root,
      jobCode,
      data: null,
      items: [],
      enabledTypes: new Set(),
      filters: { region: "all", ctype: "all" },
      shown: PAGE_SIZE,
      map: null,
      handler: null
    };
    ctx.handler = (event) => {
      try {
        onClick(ctx, event);
      } catch (error) {
        console.warn("[postings] 처리 중 오류", error);
      }
    };
    root.addEventListener("click", ctx.handler);
    active = ctx;
    void load(ctx);
  } catch (error) {
    console.warn("[postings] 섹션을 열지 못했어", error);
  }
}
