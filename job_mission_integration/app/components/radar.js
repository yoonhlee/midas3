/* 겹쳐 그리는 5축 레이더(SVG). 재도전 비교(U21)와 결과 카드(U03)에 쓴다. 값은 0~4점. */

export function radarSvg({ axes, labels, series, size = 300, idPrefix = "radar" }) {
  const cx = size / 2;
  const cy = size / 2 + 6;
  const r = size * 0.32;
  const n = axes.length;
  const point = (ratio, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + r * ratio * Math.cos(angle), cy + r * ratio * Math.sin(angle)];
  };
  const grid = [0.25, 0.5, 0.75, 1].map((ratio) => `<polygon points="${axes.map((_, i) => point(ratio, i).join(",")).join(" ")}" fill="none" stroke="#2a2c31" stroke-width="1"/>`).join("");
  const spokes = axes.map((_, i) => {
    const [x, y] = point(1, i);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#2a2c31"/>`;
  }).join("");
  const polys = series.map((s) => {
    const pts = axes.map((axis, i) => point(Math.max(0, Math.min(4, Number(s.values[axis]) || 0)) / 4, i).join(",")).join(" ");
    return `<polygon points="${pts}" fill="${s.fill}" stroke="${s.color}" stroke-width="2.5"${s.dashed ? " stroke-dasharray=\"6 4\"" : ""}/>`;
  }).join("");
  const text = axes.map((axis, i) => {
    const [x, y] = point(1.28, i);
    const anchor = x < cx - 6 ? "end" : x > cx + 6 ? "start" : "middle";
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}" style="fill:#f7f8f8;font-size:12px;font-weight:600">${labels[axis]}</text>`;
  }).join("");
  const title = series.map((s) => s.label).join(" vs ");
  return `<svg id="${idPrefix}" role="img" aria-label="${title} 레이더 차트" width="100%" viewBox="0 0 ${size} ${size + 12}" style="max-width:${size + 40}px;overflow:visible">${grid}${spokes}${polys}${text}</svg>`;
}

// 평가 로그에서 축별 평균 점수(0~4)
export function averageAxisScores(axes, logs) {
  return Object.fromEntries(axes.map((axis) => {
    const values = (logs || []).map((log) => Number(log?.evaluation?.axes?.[axis]?.score)).filter((v) => Number.isFinite(v));
    return [axis, values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0];
  }));
}
