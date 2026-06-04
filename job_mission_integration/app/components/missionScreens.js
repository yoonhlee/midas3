function renderMaterial(material, esc) {
  const title = `<div class="mat-title">${esc(material.title || material.subtype || material.material_id)}</div>`;
  const description = material.description ? `<div class="mat-desc">${esc(material.description)}</div>` : "";
  const usage = material.used_for ? `<div class="mat-use">📝 ${esc(material.used_for)}</div>` : "";
  const data = material.data || {};

  let body = "";
  if (material.type === "chart") {
    body = renderChart(data, esc);
  } else if (material.type === "table") {
    body = renderTable(data, esc);
  } else if (material.type === "memo") {
    body = renderMemo(data, esc);
  } else if (material.type === "log") {
    body = renderLog(data, esc);
  } else if (material.type === "email") {
    body = renderEmail(data, esc);
  } else if (material.type === "schedule") {
    body = renderSchedule(data, esc);
  } else if (material.type === "checklist") {
    body = renderChecklist(data, esc);
  } else if (material.type === "card") {
    body = renderCard(data, esc);
  } else {
    body = `<div class="mat-fallback"><pre>${esc(JSON.stringify(data, null, 2))}</pre></div>`;
  }

  return `<div class="material mat-${esc(material.type || "other")}">
    ${title}${description}${usage}
    <div class="mat-body">${body}</div>
  </div>`;
}

function renderChartLegacy(data, esc) {
  // 기존 산출물 형식이 들어와도 미션 자료 화면이 비지 않도록 남겨 둔 fallback 렌더러다.
  const series = (data.series || []).filter((item) => Array.isArray(item.values) && item.values.length);
  const xValues = data.x_axis?.values || [];
  if (!series.length || !xValues.length) {
    if (Array.isArray(data.rows) && data.rows.length) return renderTable(data, esc);
    if (Array.isArray(data.items) && data.items.length) {
      return `<ul class="mat-items">${data.items.map((item) => `<li>${esc(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>`;
    }
    return "<div class=\"mat-empty\">표시할 차트 데이터가 없습니다.</div>";
  }

  const width = 480;
  const height = 200;
  const padding = 36;
  const allValues = series.flatMap((item) => item.values);
  const maxValue = Math.max(...allValues);
  const minValue = Math.min(0, Math.min(...allValues));
  const xStep = (width - padding * 2) / Math.max(xValues.length - 1, 1);
  const yScale = (value) => height - padding - (value - minValue) / (maxValue - minValue + 0.0001) * (height - padding * 2);
  const colors = ["var(--accent)", "var(--success)", "var(--warn)", "var(--danger)"];
  const chartType = data.chart_type || "line";

  let body = "";
  series.forEach((item, seriesIndex) => {
    const color = colors[seriesIndex % colors.length];
    if (chartType === "bar") {
      const barWidth = (width - padding * 2) / xValues.length * 0.7 / series.length;
      item.values.forEach((value, itemIndex) => {
        const x = padding + itemIndex * xStep - barWidth * series.length / 2 + barWidth * seriesIndex;
        const y = yScale(value);
        body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(height - padding - y).toFixed(1)}" fill="${color}" opacity="0.85"/>`;
      });
      return;
    }

    const path = item.values.map((value, itemIndex) => `${itemIndex === 0 ? "M" : "L"}${(padding + itemIndex * xStep).toFixed(1)},${yScale(value).toFixed(1)}`).join(" ");
    body += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`;
    item.values.forEach((value, itemIndex) => {
      body += `<circle cx="${(padding + itemIndex * xStep).toFixed(1)}" cy="${yScale(value).toFixed(1)}" r="3" fill="${color}"/>`;
    });
  });

  const xLabels = xValues.map((item, index) => `<text x="${(padding + index * xStep).toFixed(1)}" y="${height - 12}" fill="var(--sub)" font-size="10" text-anchor="middle">${esc(item)}</text>`).join("");
  const axisLine = `<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border)"/>`;
  const yLabels = `<text x="${padding - 6}" y="${(padding + 5).toFixed(1)}" fill="var(--sub)" font-size="10" text-anchor="end">${maxValue}</text>
                   <text x="${padding - 6}" y="${height - padding}" fill="var(--sub)" font-size="10" text-anchor="end">${minValue}</text>`;
  const legend = series.length > 1
    ? `<div class="chart-legend">${series.map((item, index) => `<span class="leg-item"><span class="leg-dot" style="background:${colors[index % colors.length]}"></span>${esc(item.name || (`계열 ${index + 1}`))}</span>`).join("")}</div>`
    : "";

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(data.chart_type || "chart")}">${axisLine}${body}${xLabels}${yLabels}</svg>${legend}`;
}

function renderChart(data, esc) {
  // bar/line 차트의 여백과 축 범위를 분리해 값 라벨이 축선이나 카드 밖으로 밀리지 않게 한다.
  const series = (data.series || []).filter((item) => Array.isArray(item.values) && item.values.length);
  const xValues = data.x_axis?.values || [];
  if (!series.length || !xValues.length) {
    return renderChartLegacy(data, esc);
  }

  const colors = ["var(--accent)", "var(--success)", "var(--warn)", "var(--danger)"];
  const chartType = data.chart_type || "line";
  const isBarChart = chartType === "bar";
  const width = 520;
  const height = isBarChart ? 240 : 220;
  const margin = isBarChart
    ? { top: 28, right: 18, bottom: 42, left: 52 }
    : { top: 26, right: 18, bottom: 40, left: 48 };
  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const allValues = series.flatMap((item) => item.values.map(Number)).filter(Number.isFinite);
  if (!allValues.length) return renderChartLegacy(data, esc);

  const rawMaxValue = Math.max(...allValues);
  const rawMinValue = Math.min(...allValues);
  const minValue = Math.min(0, rawMinValue);
  const niceCeil = (value) => {
    if (!Number.isFinite(value) || value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;
    const step = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return step * magnitude;
  };
  const maxValue = isBarChart ? niceCeil(rawMaxValue) : rawMaxValue;
  const yRange = Math.max(maxValue - minValue, 1);
  const yScale = (value) => plotBottom - ((value - minValue) / yRange) * plotHeight;
  const xStep = plotWidth / Math.max(xValues.length - 1, 1);
  const formatValue = (value) => Number.isInteger(value) ? String(value) : value.toFixed(1);
  const tickValues = isBarChart
    ? Array.from(new Set([minValue, maxValue / 2, maxValue].map((value) => Number(value.toFixed(2)))))
    : [minValue, maxValue];

  let body = "";
  series.forEach((item, seriesIndex) => {
    const color = colors[seriesIndex % colors.length];
    if (isBarChart) {
      const groupWidth = plotWidth / xValues.length;
      const barGap = Math.min(8, groupWidth * 0.08);
      const barWidth = Math.max(12, (groupWidth * 0.66 - barGap * (series.length - 1)) / series.length);
      item.values.forEach((rawValue, itemIndex) => {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return;
        const groupLeft = plotLeft + itemIndex * groupWidth;
        const groupCenter = groupLeft + groupWidth / 2;
        const barsWidth = barWidth * series.length + barGap * (series.length - 1);
        const x = groupCenter - barsWidth / 2 + (barWidth + barGap) * seriesIndex;
        const y = yScale(value);
        const barHeight = Math.max(0, plotBottom - y);
        body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${color}" opacity="0.9"/>`;
        body += `<text x="${(x + barWidth / 2).toFixed(1)}" y="${Math.max(plotTop + 10, y - 7).toFixed(1)}" fill="var(--sub)" font-size="10" text-anchor="middle">${formatValue(value)}</text>`;
      });
      return;
    }

    const path = item.values.map((rawValue, itemIndex) => {
      const value = Number(rawValue);
      const x = plotLeft + itemIndex * xStep;
      return `${itemIndex === 0 ? "M" : "L"}${x.toFixed(1)},${yScale(value).toFixed(1)}`;
    }).join(" ");
    body += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`;
    item.values.forEach((rawValue, itemIndex) => {
      const value = Number(rawValue);
      body += `<circle cx="${(plotLeft + itemIndex * xStep).toFixed(1)}" cy="${yScale(value).toFixed(1)}" r="3" fill="${color}"/>`;
    });
  });

  const xLabels = xValues.map((item, index) => {
    const x = isBarChart
      ? plotLeft + (index + 0.5) * (plotWidth / xValues.length)
      : plotLeft + index * xStep;
    return `<text x="${x.toFixed(1)}" y="${height - 16}" fill="var(--sub)" font-size="10" text-anchor="middle">${esc(item)}</text>`;
  }).join("");
  const grid = tickValues.map((value) => {
    const y = yScale(value);
    return `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" stroke="var(--border)" opacity="${value === minValue ? "0.9" : "0.45"}"/>`;
  }).join("");
  const yAxis = `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="var(--border)" opacity="0.65"/>`;
  const yLabels = tickValues.map((value) => `<text x="${plotLeft - 10}" y="${(yScale(value) + 3).toFixed(1)}" fill="var(--sub)" font-size="10" text-anchor="end">${formatValue(value)}</text>`).join("");
  const legend = series.length > 1
    ? `<div class="chart-legend">${series.map((item, index) => `<span class="leg-item"><span class="leg-dot" style="background:${colors[index % colors.length]}"></span>${esc(item.name || (`계열 ${index + 1}`))}</span>`).join("")}</div>`
    : "";

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(data.chart_type || "chart")}">${grid}${yAxis}${body}${xLabels}${yLabels}</svg>${legend}`;
}

function renderTable(data, esc) {
  const columns = data.columns || [];
  const rows = data.rows || [];
  if (!columns.length || !rows.length) return "<div class=\"mat-empty\">표시할 표 데이터가 없습니다.</div>";

  const header = columns.map((column) => `<th>${esc(column.label || column.key)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${esc(row[column.key] ?? "")}</td>`).join("")}</tr>`).join("");
  return `<table class="mat-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderMemo(data, esc) {
  const items = data.items || [];
  const entries = data.entries || [];
  const cards = data.cards || [];
  const thread = data.thread || [];
  if (items.length) {
    return `<ul class="mat-items">${items.map((item) => `<li>${esc(typeof item === "string" ? item : (item.text || JSON.stringify(item)))}</li>`).join("")}</ul>`;
  }
  if (entries.length) {
    return `<div class="mat-entries">${entries.map((entry) => `<div class="mat-entry"><strong>${esc(entry.title || entry.label || "")}</strong>${entry.text ? `<div>${esc(entry.text)}</div>` : ""}</div>`).join("")}</div>`;
  }
  if (cards.length) {
    return `<div class="mat-cards">${cards.map((card) => `<div class="mat-card-item"><strong>${esc(card.title || "")}</strong>${card.body ? `<div>${esc(card.body)}</div>` : ""}</div>`).join("")}</div>`;
  }
  if (thread.length) {
    return `<div class="mat-thread">${thread.map((item) => `<div class="mat-msg"><strong>${esc(item.speaker || "")}:</strong> ${esc(item.text || item.message || "")}</div>`).join("")}</div>`;
  }
  if (data.author) {
    return `<div class="mat-author">— ${esc(data.author)}</div>`;
  }
  return "<div class=\"mat-empty\">메모에 표시할 본문이 없습니다.</div>";
}

function renderLog(data, esc) {
  const entries = Array.isArray(data.entries) && data.entries.length ? data.entries : null;
  const items = Array.isArray(data.items) && data.items.length ? data.items : null;

  if (entries) {
    const rows = entries.map((e) => {
      const time = e.time || e.at || "";
      const actor = e.actor || e.who || "";
      const event = e.event || e.action || e.title || "";
      const note = e.note || e.result || e.message || "";
      return `<div class="log-entry">
        <div class="log-entry-head"><span class="log-time">${esc(time)}</span><span class="log-actor">${esc(actor)}</span><span class="log-event">${esc(event)}</span></div>
        ${note ? `<div class="log-note-text">${esc(note)}</div>` : ""}
      </div>`;
    }).join("");
    return `<div class="log-entries">${rows}</div>`;
  }

  if (items) {
    const statusIcon = (s) => ({ checked: "✓", issue: "!", warn: "⚠" }[s] || "·");
    return `<ul class="log-items">${items.map((item) => {
      const label = typeof item === "string" ? "" : (item.label || "");
      const text = typeof item === "string" ? item : (item.text || "");
      const status = typeof item === "string" ? "" : (item.status || "");
      return `<li class="log-item log-item-${esc(status)}"><span class="log-status">${statusIcon(status)}</span>${label ? `<span class="log-label">${esc(label)}</span> ` : ""}${esc(text)}</li>`;
    }).join("")}</ul>`;
  }

  return `<pre class="mat-log">${esc(JSON.stringify(data, null, 2))}</pre>`;
}

function renderEmail(data, esc) {
  const thread = Array.isArray(data.thread) ? data.thread : [];
  if (!thread.length) {
    const items = data.items || [];
    if (items.length) return `<ul class="mat-items">${items.map((item) => `<li>${esc(typeof item === "string" ? item : (item.text || item.label || JSON.stringify(item)))}</li>`).join("")}</ul>`;
    return `<div class="mat-empty">이메일 내용이 없습니다.</div>`;
  }
  return `<div class="email-thread">${thread.map((msg) => `<div class="email-msg">
    <div class="email-meta">
      ${msg.from ? `<span class="email-field"><span class="email-field-lbl">발신</span>${esc(msg.from)}</span>` : ""}
      ${msg.to ? `<span class="email-field"><span class="email-field-lbl">수신</span>${esc(msg.to)}</span>` : ""}
      ${msg.subject ? `<div class="email-subject">${esc(msg.subject)}</div>` : ""}
    </div>
    ${msg.body ? `<div class="email-body">${esc(msg.body)}</div>` : ""}
  </div>`).join("")}</div>`;
}

function renderSchedule(data, esc) {
  const items = Array.isArray(data.items) ? data.items : [];
  const hasScheduleFields = items.some((item) => item && (item.period || item.task || item.text || item.label));
  if (hasScheduleFields) {
    return `<div class="schedule-list">${items.map((item) => `<div class="schedule-item">
      ${item.period ? `<span class="sched-period">${esc(item.period)}</span>` : ""}
      <span class="sched-task">${esc([item.label, item.task].filter(Boolean).join(" · ") || item.text || "")}</span>
      ${[item.text, item.constraint]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .map((value) => `<div class="sched-constraint">${esc(value)}</div>`)
        .join("")}
    </div>`).join("")}</div>`;
  }
  if (Array.isArray(data.rows) && data.rows.length) return renderTable(data, esc);
  if (Array.isArray(data.series) && Array.isArray(data.x_axis?.values) && data.x_axis.values.length) {
    return renderChart(data, esc);
  }
  if (!items.length) return `<div class="mat-empty">일정 데이터가 없습니다.</div>`;
  return `<ul class="mat-items">${items.map((item) => `<li>${esc(typeof item === "string" ? item : (item.text || item.label || JSON.stringify(item)))}</li>`).join("")}</ul>`;
}

function renderChecklistLegacy(data, esc) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return `<div class="mat-empty">점검 항목이 없습니다.</div>`;
  const iconMap = { checked: "✓", unchecked: "○", issue: "!", warn: "⚠" };
  return `<ul class="checklist">${items.map((item) => {
    const label = typeof item === "string" ? item : (item.label || item.text || "");
    const status = typeof item === "object" ? (item.status || "unchecked") : "unchecked";
    const importance = typeof item === "object" ? (item.importance || "") : "";
    return `<li class="ck-item ck-${esc(status)}">
      <span class="ck-icon">${iconMap[status] || "·"}</span>
      <span class="ck-label">${esc(label)}</span>
      ${importance === "high" ? `<span class="ck-imp">중요</span>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

const CHECKLIST_STATUS_META = {
  // 항목 아이콘과 범례가 같은 설명을 쓰도록 상태별 의미를 한곳에 모았다.
  checked: { icon: "✓", label: "확인 완료", hint: "이미 확인된 항목" },
  unchecked: { icon: "○", label: "확인 필요", hint: "아직 확인해야 할 항목" },
  issue: { icon: "!", label: "주의 필요", hint: "먼저 점검해야 할 항목" },
  warn: { icon: "!", label: "높은 주의", hint: "위험도가 큰 항목" }
};

function normalizeChecklistStatus(status) {
  return CHECKLIST_STATUS_META[status] ? status : "unchecked";
}

function renderChecklist(data, esc) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return renderChecklistLegacy(data, esc);

  const statuses = Array.from(new Set(items.map((item) => normalizeChecklistStatus(
    typeof item === "object" ? (item.status || "unchecked") : "unchecked"
  ))));
  const legend = `<div class="checklist-legend" aria-label="체크리스트 마크 설명">${statuses.map((status) => {
    const meta = CHECKLIST_STATUS_META[status];
    return `<span class="ck-legend-item ck-legend-${esc(status)}" title="${esc(meta.hint)}"><span class="ck-legend-icon">${esc(meta.icon)}</span>${esc(meta.label)}</span>`;
  }).join("")}</div>`;

  return `${legend}<ul class="checklist">${items.map((item) => {
    const label = typeof item === "string" ? item : (item.label || item.text || "");
    const status = normalizeChecklistStatus(typeof item === "object" ? (item.status || "unchecked") : "unchecked");
    const importance = typeof item === "object" ? (item.importance || "") : "";
    const meta = CHECKLIST_STATUS_META[status];
    return `<li class="ck-item ck-${esc(status)}">
      <span class="ck-icon" title="${esc(meta.hint)}">${esc(meta.icon)}</span>
      <span class="ck-label">${esc(label)}</span>
      ${importance === "high" ? `<span class="ck-imp">중요</span>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

function renderCard(data, esc) {
  const attrLabels = { strength: "강점", weakness: "약점", fit: "적합도" };
  const cards = Array.isArray(data.cards) ? data.cards : [];
  if (!cards.length) return renderMemo(data, esc);
  return `<div class="opt-cards">${cards.map((card) => {
    const attrs = card.attributes && typeof card.attributes === "object" ? Object.entries(card.attributes) : [];
    return `<div class="opt-card">
      <div class="opt-card-title">${esc(card.title || card.label || "")}</div>
      ${card.body ? `<div class="opt-card-body">${esc(card.body)}</div>` : ""}
      ${attrs.length ? `<div class="opt-attrs">${attrs.map(([k, v]) => `<div class="opt-attr"><span class="opt-attr-key">${esc(attrLabels[k] || k)}</span><span class="opt-attr-val">${esc(String(v))}</span></div>`).join("")}</div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

export function renderMissionListScreen({ state, missions, jobDef, esc }) {
  const difficultyLabel = { easy: "쉬움", normal: "보통", hard: "어려움" };

  const cards = missions.map((mission) => {
    const isSelected = state.selectedMissionKey === mission.key;
    const missionSpec = (mission._raw || {}).mission || {};
    const difficulty = missionSpec.difficulty || {};
    const diffLevelKey = difficulty.level || "normal";
    const contextText = missionSpec.scenario?.context || "";

    return `<div class="mc${isSelected ? " sel" : ""}" data-mk="${esc(mission.key || mission.mission_id)}">
      <div class="mc-check">✓</div>
      <div class="mc-header">
        <div class="mc-title">${esc(mission.title)}</div>
        <div class="mc-badges">
          <span class="mc-diff mc-diff-${esc(diffLevelKey)}">${difficultyLabel[diffLevelKey] || esc(diffLevelKey)}</span>
          ${difficulty.estimated_time_minutes ? `<span class="mc-time">약 ${difficulty.estimated_time_minutes}분</span>` : ""}
        </div>
      </div>
      ${missionSpec.scenario?.role ? `<div class="mc-role">역할: ${esc(missionSpec.scenario.role)}</div>` : ""}
      ${contextText ? `<div class="mc-context">${esc(contextText.length > 120 ? contextText.slice(0, 120) + "…" : contextText)}</div>` : ""}
    </div>`;
  }).join("");

  return `<div class="sec-head">
    <div class="eyebrow">${jobDef.icon} ${esc(jobDef.job_name)}</div>
    <div class="sec-h">문제를 선택하세요</div>
    <div class="sec-sub">풀고 싶은 미션을 하나 선택하세요 · 선택한 미션만 수행합니다</div>
  </div>
  <div class="mission-list">${cards || `<div style="color:var(--t3);padding:24px 0">이 직무의 미션이 없습니다.</div>`}</div>
  <div style="display:flex;gap:10px;margin-top:24px">
    <button class="btn btn-g" id="btn-ml-back">← 이전</button>
    <button class="btn btn-p btn-lg" id="btn-ml-start" style="margin-left:auto"${state.selectedMissionKey ? "" : " disabled"}>미션 시작 →</button>
  </div>`;
}

export function renderSelectScreen({ state, jobDefs, renderBrand }) {
  const cards = jobDefs.map((job) => `<div class="jc${state.selectedJobs.includes(job.job_code) ? " sel" : ""}" data-jc="${job.job_code}">
      <div class="jc-check">✓</div>
      <div class="jc-icon">${job.icon}</div>
      <div class="jc-name">${job.job_name}</div>
      <div class="jc-meta">${job.desc || "미션 기반 탐색"}</div>
    </div>`).join("");

  return `<div class="sec-head">
    <div class="eyebrow">인터랙티브 체험</div>
    <div class="sec-h">체험할 직무를 선택하세요</div>
    <div class="sec-sub">직무를 1개 선택 · 직무당 약 15분 소요</div>
  </div>
  <div class="job-grid">${cards}</div>
  <div class="fr"><button class="btn btn-p btn-lg" id="btn-start"${state.selectedJobs.length ? "" : " disabled"}>시뮬레이션 시작하기 →</button></div>`;
}

export function renderPreQuestionScreen({ state, jobDefs, renderBrand }) {
  const jobCode = state.selectedJobs[state.preqIndex];
  const selectedJob = jobDefs.find((item) => item.job_code === jobCode);
  const answers = state.preqAnswers[jobCode] || { q1: "", q2: "" };
  const progress = Math.round(state.preqIndex / state.selectedJobs.length * 100);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[ch]));

  return `${renderBrand()}<div class="prog"><div class="prog-f" style="width:${progress}%"></div></div>
  <h1 class="stitle">시작 전 잠깐 — ${state.preqIndex + 1} / ${state.selectedJobs.length}</h1>
  <p class="sdesc">이 직무에 대한 첫인상을 솔직하게 적어주세요.</p>
  <div class="card" style="margin-bottom:14px">
    <div class="pq-lbl">${selectedJob.icon} ${selectedJob.job_name}</div>
    <div class="pq-txt">이 직무가 하루에 가장 많이 하는 일이 뭐일 것 같아?</div>
    <textarea id="pq1" rows="3">${esc(answers.q1)}</textarea>
  </div>
  <div class="card">
    <div class="pq-lbl">${selectedJob.icon} ${selectedJob.job_name}</div>
    <div class="pq-txt">이 직무에서 가장 자주 쓰는 능력이 뭐일 것 같아?</div>
    <textarea id="pq2" rows="3">${esc(answers.q2)}</textarea>
  </div>
  <div style="display:flex;gap:10px;margin-top:24px">
    <button class="btn btn-g" id="btn-pback">${state.preqIndex > 0 ? "← 이전 직무" : "← 직무 선택"}</button>
    <button class="btn btn-p" id="btn-pnext" style="margin-left:auto">${state.preqIndex < state.selectedJobs.length - 1 ? "다음 직무 →" : "미션 시작 →"}</button>
  </div>`;
}

export function renderMissionScreen({
  state,
  mission,
  jobDef,
  missionProgressPct,
  missionCount,
  renderBrand,
  isLastMission,
  esc
}) {
  const rawMission = mission._raw || {};
  const missionSpec = rawMission.mission || {};
  const scenario = missionSpec.scenario || {};
  const facts = rawMission.mission_facts || {};
  const tasks = missionSpec.tasks || [];
  const materials = missionSpec.materials || [];
  const submissionFormat = missionSpec.submission_format || {};

  const glossaryItems = Array.isArray(scenario.glossary) ? scenario.glossary : [];
  const glossaryUI = glossaryItems.length
    ? `<div class="glossary">
      <div class="glossary-hdr">📖 용어 설명</div>
      <div class="glossary-list">
        ${glossaryItems.map((g) => `<div class="glossary-item"><span class="glossary-term">${esc(g.term)}</span><span class="glossary-def">${esc(g.definition)}</span></div>`).join("")}
      </div>
    </div>`
    : "";

  const scenarioUI = `<div class="scenario">
    ${scenario.role ? `<div class="sc-role"><span class="sc-tag">역할</span> ${esc(scenario.role)}</div>` : ""}
    ${scenario.context ? `<p class="sc-context">${esc(scenario.context)}</p>` : ""}
    ${facts.main_issue ? `<div class="sc-issue"><span class="sc-tag">핵심 이슈</span> ${esc(facts.main_issue)}</div>` : ""}
    ${scenario.goal ? `<div class="sc-goal"><span class="sc-tag">목표</span> ${esc(scenario.goal)}</div>` : ""}
    ${(scenario.constraints || []).length ? `<div class="sc-constraints"><span class="sc-tag">제약</span><ul>${scenario.constraints.map((constraint) => `<li>${esc(constraint)}</li>`).join("")}</ul></div>` : ""}
    ${glossaryUI}
  </div>`;

  const materialsUI = materials.length
    ? `<div class="materials">
      <div class="mat-hdr">📎 참고 자료 (${materials.length})</div>
      ${materials.map((item) => renderMaterial(item, esc)).join("")}
    </div>`
    : "";

  const tasksUI = tasks.length
    ? `<div class="tasks-block">
      <div class="task-lbl">📋 수행 과제</div>
      <ol class="tasks-list">${tasks.map((task) => `<li>${esc(task.instruction)}</li>`).join("")}</ol>
    </div>`
    : `<div style="margin-bottom:20px"><div class="task-lbl">📋 수행 과제</div><div class="task-txt">${esc(mission.task)}</div></div>`;

  const submitHintUI = (submissionFormat.required_sections?.length || submissionFormat.length_hint)
    ? `<div class="submit-hint">
      ${submissionFormat.required_sections?.length ? `<div><strong>답변 구성:</strong> ${submissionFormat.required_sections.map(esc).join(" · ")}</div>` : ""}
      ${submissionFormat.length_hint ? `<div><strong>분량:</strong> ${esc(submissionFormat.length_hint)}</div>` : ""}
    </div>`
    : "";

  const answerReady = state.missionAnswer.trim().length > 10;

  return `<div class="mis-layout">
    <div class="mis-card">
      <div class="mis-breadcrumb">체험 <span>/</span> 미션 수행 <span>/</span> <span>${esc(jobDef.job_name)}</span></div>
      <div class="job-pill">${jobDef.icon} ${esc(jobDef.job_name)}</div>
      <div class="mis-q">${esc(mission.title)}</div>
      ${scenarioUI}
      <div class="mis-divider"></div>
      ${tasksUI}
      ${materialsUI}
    </div>
    <div class="mis-right">
      <div>
        <div class="panel-lbl">진행률</div>
        <div class="prog"><div class="prog-f" style="width:${missionProgressPct}%"></div></div>
        <div style="font-size:12px;color:var(--t3)">미션 ${state.missionStepIndex + 1} / ${missionCount}</div>
      </div>
      <div class="hr"></div>
      <div>
        <div class="panel-lbl">Your Answer</div>
        ${submitHintUI}
        <textarea id="m-ans" placeholder="여기에 답변을 작성하세요…">${esc(state.missionAnswer)}</textarea>
        <div class="char-ct">${state.missionAnswer.length}자</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-p" id="btn-mnext"${answerReady ? "" : " disabled"} style="width:100%">${isLastMission ? "결과 보기 →" : "다음 →"}</button>
        <button class="btn btn-g" id="btn-mission-back" style="width:100%">← 미션 다시 선택</button>
      </div>
    </div>
  </div>`;
}
