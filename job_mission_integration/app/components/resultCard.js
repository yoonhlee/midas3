/* 결과 카드(U03): 캔버스에 레이더·비슷한 직무 3개·한 줄 요약을 그려 PNG로 저장하거나 인쇄한다.
   답변 원문과 근거 인용은 넣지 않는다(공유될 수 있는 이미지라서). */

const W = 1080;
const H = 1350;
const COLORS = { bg: "#0f1011", panel: "#161718", line: "#2a2c31", text: "#f7f8f8", sub: "#b4b4b4", mute: "#8a8f98", accent: "#5e6ad2", accentSoft: "rgba(94,106,210,0.32)" };
const FONT = "\"Pretendard Variable\", Pretendard, \"Noto Sans KR\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif";

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const ch of String(text || "")) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch.trimStart();
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawRadar(ctx, { cx, cy, r, axes, labels, values, measured = axes }) {
  const n = axes.length;
  const point = (ratio, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + r * ratio * Math.cos(angle), cy + r * ratio * Math.sin(angle)];
  };
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  for (const ratio of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    axes.forEach((_, i) => {
      const [x, y] = point(ratio, i);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  axes.forEach((_, i) => {
    const [x, y] = point(1, i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
  });
  ctx.beginPath();
  axes.forEach((axis, i) => {
    const [x, y] = point(Math.max(0.03, Math.min(4, values[axis] || 0) / 4), i);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = COLORS.accentSoft;
  ctx.fill();
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  axes.forEach((axis, i) => {
    const [x, y] = point(1.24, i);
    ctx.textAlign = x < cx - 8 ? "right" : x > cx + 8 ? "left" : "center";
    ctx.textBaseline = "middle";
    ctx.fillText(labels[axis], x, y);
    ctx.font = `500 26px ${FONT}`;
    ctx.fillStyle = COLORS.mute;
    // 결과 화면 레이더와 같은 표기(4점 = 100%), 재지 않은 축은 '미측정'
    ctx.fillText(measured.includes(axis) ? `${Math.round(((values[axis] || 0) / 4) * 100)}%` : "미측정", x, y + 36);
    ctx.font = `600 30px ${FONT}`;
    ctx.fillStyle = COLORS.text;
  });
}

// 카드에 들어갈 내용만 골라낸다(테스트하기 쉽게 그리기와 분리)
export function buildCardData({ state, axes, axisLabels, jobDefs, averageAxisScores, roundOneLogs, withJosa }) {
  const code = state.selectedJobs[0];
  const job = jobDefs.find((j) => j.job_code === code);
  // 결과 화면 레이더와 같은 값: 미측정 축은 0으로 두고 카드에도 '미측정'으로 적는다.
  const coverage = state.resultSummary?.axisCoverage || {};
  const measuredSet = axes.filter((axis) => coverage[axis]?.measured !== false);
  const raw = averageAxisScores(axes, roundOneLogs(state));
  const values = Object.fromEntries(axes.map((axis) => [axis, measuredSet.includes(axis) ? raw[axis] : 0]));
  // 결과 해석(U17)과 같게, 이번 미션이 잰 축 안에서만 높고 낮음을 말한다.
  const ranked = (measuredSet.length ? measuredSet : axes).slice().sort((a, b) => values[b] - values[a]);
  const top = ranked[0];
  const low = ranked[ranked.length - 1];
  const similar = (state.resultSummary?.recommendations?.[code] || []).slice(0, 3).map((item) => ({ name: item.name, pct: item.similarityPct }));
  let summary = "이번 미션에서는 역량이 뚜렷하게 드러나지 않았어.";
  if (values[top] > 0) {
    summary = low && low !== top && values[low] < values[top]
      ? `${withJosa(axisLabels[top], "이", "가")} 가장 잘 드러났고, ${withJosa(axisLabels[low], "은", "는")} 상대적으로 덜 드러났어.`
      : `${withJosa(axisLabels[top], "이", "가")} 가장 잘 드러났어.`;
  }
  return {
    jobName: job?.job_name || code,
    missionCount: roundOneLogs(state).length,
    measured: measuredSet,
    compatibility: state.compatibility?.[code] ?? null,
    values,
    similar,
    summary,
    date: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  };
}

export async function drawResultCard(data, { axes, axisLabels }) {
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch (_) { /* 글꼴을 못 불러와도 기본 글꼴로 그린다 */ }
  }
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = COLORS.mute;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText(`JOBSIM 직무 체험 결과 · ${data.date}`, 72, 104);
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 60px ${FONT}`;
  ctx.fillText(data.jobName, 72, 186);
  ctx.fillStyle = COLORS.sub;
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(`미션 ${data.missionCount}개${data.compatibility !== null ? ` · 직무 유사도 ${data.compatibility}%` : ""}`, 72, 238);

  drawRadar(ctx, { cx: W / 2, cy: 560, r: 230, axes, labels: axisLabels, values: data.values, measured: data.measured || axes });

  // 한 줄 요약
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(72, 880, W - 144, 132);
  ctx.fillStyle = COLORS.text;
  ctx.font = `600 32px ${FONT}`;
  ctx.textAlign = "left";
  wrapText(ctx, data.summary, W - 200).slice(0, 2).forEach((line, i) => ctx.fillText(line, 100, 934 + i * 44));

  // 비슷한 직무 3개
  ctx.fillStyle = COLORS.mute;
  ctx.font = `600 28px ${FONT}`;
  ctx.fillText("내 결과와 결이 비슷한 직무", 72, 1076);
  const list = data.similar.length ? data.similar : [{ name: "추천 자료 없음", pct: null }];
  list.forEach((item, i) => {
    const y = 1130 + i * 52;
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(`${i + 1}`, 72, y);
    ctx.fillStyle = COLORS.text;
    ctx.font = `500 32px ${FONT}`;
    ctx.fillText(item.name, 112, y);
    if (item.pct !== null && item.pct !== undefined) {
      ctx.textAlign = "right";
      ctx.fillStyle = COLORS.sub;
      ctx.fillText(`${item.pct}%`, W - 72, y);
      ctx.textAlign = "left";
    }
    ctx.font = `600 28px ${FONT}`;
  });

  ctx.fillStyle = COLORS.mute;
  ctx.font = `400 22px ${FONT}`;
  wrapText(ctx, "점수는 미션 답변 기준(0~4점)이고, 유사도는 KNOW 재직자 직무 프로필과의 비교야. 답변 원문은 담지 않았어.", W - 144)
    .slice(0, 2)
    .forEach((line, i, lines) => ctx.fillText(line, 72, H - 40 - (lines.length - 1 - i) * 30));
  return canvas;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("이미지를 만들지 못했어"))), "image/png"));
}

export async function downloadCard(canvas, fileName) {
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 이미지를 다 불러온 뒤에 인쇄 창을 연다. 바로 열면 첫 번째 인쇄가 빈 페이지가 된다.
export async function printCard(canvas, img) {
  img.alt = "JOBSIM 결과 카드";
  img.hidden = false;
  await new Promise((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = canvas.toDataURL("image/png");
    if (img.complete && img.naturalWidth) resolve();
  });
  if (img.decode) {
    try { await img.decode(); } catch (_) { /* 디코드 실패해도 인쇄는 진행 */ }
  }
  document.body.classList.add("print-card");
  const cleanup = () => {
    document.body.classList.remove("print-card");
    img.hidden = true;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // 인쇄용 스타일이 적용된 화면이 한 번 그려진 다음에 연다.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.print();
}
