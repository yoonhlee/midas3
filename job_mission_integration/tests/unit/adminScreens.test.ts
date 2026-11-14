import test from "node:test";
import assert from "node:assert/strict";
// 관리자 화면의 말(labels.js)과 근거 찾기(basis.js)는 순수 함수라 그대로 불러 테스트한다.
// @ts-expect-error 타입 선언이 없는 브라우저 JS 모듈
import { estimateText, errorText, pieceName, renamePieces, verdictView } from "../../app/admin/labels.js";
// @ts-expect-error 타입 선언이 없는 브라우저 JS 모듈
import { basisFor } from "../../app/admin/basis.js";

test("글자 바꾸기: 조각 번호를 읽을 수 있는 이름으로", () => {
  assert.equal(renamePieces("N.c.2.2와 N.doc.6, K.exec.1을 본다. N.x.9는 그대로."), "수행준거 2.2와 서류 6, 하는 일 문장을 본다. N.x.9는 그대로.");
  assert.deepEqual(["N.con.5", "N.eval.3", "K.act.3", "M.1", "zzz"].map(pieceName), ["고려사항 5", "평가 지침 3", "업무활동 3", "문장과 능력단위의 연결", "zzz"]);
});

test("판정과 예상 시간의 말", () => {
  assert.deepEqual(verdictView("doubt", 1), { text: "확인할 점 1건", tone: "quiet" });
  assert.deepEqual([verdictView("doubt").text, verdictView("fail").tone, verdictView(null).text, verdictView("review_failed").text], ["확인할 점 있음", "danger", "검수 안 함", "검수 실패"]);
  const est = { easy: { generate: { seconds: 60, usd: 0.25 }, review: { seconds: 20, usd: 0.06 } }, hard: { generate: { seconds: 125, usd: 0.4 }, review: { seconds: 40, usd: 0.12 } } };
  assert.deepEqual(estimateText(est, "hard", true), { time: "약 3분", cost: "약 $0.52" });
  assert.deepEqual(estimateText(est, "easy", false), { time: "약 1분", cost: "약 $0.25" });
  assert.equal(errorText("없는_코드"), "요청을 처리하지 못했습니다. (없는_코드)");
});

test("근거 찾기: 기록의 글을 그대로 보여 주고, 없는 부분은 null이다", () => {   // Review Focus 4
  const basis = { chain: [
    { step: 5, kind: "ai_decision", decided_by: "모델", materials: [{ material_id: "mat_001", role: "기준이 되는 절차 발췌", type_reason: "N.doc.6의 문서는 지켜야 할 기준이므로 메모로 담는다.", refs: [{ id: "N.doc.6", text: "보안 관련 규정, 지침, 절차 문서" }], borrowed_terms: [{ term: "모니터링 방법", in_mission: true }] }], tasks: [] },
    { step: 6, kind: "ai_decision", decided_by: "모델", items: [] }
  ] };
  const found = basisFor(basis, { kind: "material", id: "mat_001" })!;
  assert.deepEqual(found.why, ["기준이 되는 절차 발췌", "서류 6의 문서는 지켜야 할 기준이므로 메모로 담는다."]);
  assert.deepEqual(found.sources, [{ name: "서류 6", text: "보안 관련 규정, 지침, 절차 문서" }]);
  assert.ok(found.details.some((d: { label: string; value: string }) => d.value.includes("지어낸 값")));
  assert.equal(basisFor(basis, { kind: "material", id: "mat_999" }), null);
  assert.equal(basisFor(basis, { kind: "rubric", index: 0 }), null);
  assert.equal(basisFor(null, { kind: "task", id: "task_001" }), null);
  assert.equal(basisFor({}, { kind: "path", node: "unit" }), null);
});
