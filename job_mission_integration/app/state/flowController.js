const AXES = ["AX1", "AX2", "AX3", "AX4", "AX5"];

function escapeHtml(value) {
  // 채점 실패 사유를 화면에 그대로 보여주므로 HTML 주입을 막아 둔다.
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[ch]));
}

function buildUnavailableEvaluation(mission, reason) {
  return {
    mission_id: mission.mission_id,
    prompt_version: "client-unavailable-v1",
    source: "unavailable",
    flags: ["low_confidence", "ambiguous"],
    axes: Object.fromEntries(AXES.map((axis) => [axis, {
      score: 0,
      confidence: 0,
      evidence: [],
      reason: `채점 중 오류가 발생했습니다. ${reason}`
    }]))
  };
}

export function bindAppEvents(ctx) {
  const {
    state,
    getCurrentMission,
    scoreAnswer,
    saveEvaluationLog,
    render,
    refreshMissionNextButton,
    advanceMissionFlow,
    resetState
  } = ctx;

  document.querySelectorAll(".jc").forEach((element) => element.addEventListener("click", () => {
    const jobCode = element.dataset.jc;
    // 단일 선택 모드: 같은 카드를 다시 누르면 해제, 다른 카드를 누르면 교체
    if (state.selectedJobs.length === 1 && state.selectedJobs[0] === jobCode) {
      state.selectedJobs = [];
    } else {
      state.selectedJobs = [jobCode];
    }
    render();
  }));

  const byId = (id) => document.getElementById(id);

  byId("btn-start")?.addEventListener("click", () => {
    state.screen = "preq";
    state.preqIndex = 0;
    render();
  });

  byId("btn-pnext")?.addEventListener("click", () => {
    const jobCode = state.selectedJobs[state.preqIndex];
    state.preqAnswers[jobCode] = {
      q1: byId("pq1")?.value || "",
      q2: byId("pq2")?.value || ""
    };
    if (state.preqIndex < state.selectedJobs.length - 1) {
      state.preqIndex += 1;
      render();
      return;
    }
    state.screen = "mission-list";
    state.missionJobIndex = 0;
    state.selectedMissionKey = null;
    render();
  });

  byId("btn-pback")?.addEventListener("click", () => {
    if (state.preqIndex > 0) {
      state.preqIndex -= 1;
    } else {
      state.screen = "select";
    }
    render();
  });

  document.querySelectorAll(".mc").forEach((card) => card.addEventListener("click", () => {
    state.selectedMissionKey = card.dataset.mk;
    render();
  }));

  byId("btn-ml-back")?.addEventListener("click", () => {
    state.screen = "preq";
    state.preqIndex = state.selectedJobs.length - 1;
    render();
  });

  byId("btn-ml-start")?.addEventListener("click", () => {
    if (!state.selectedMissionKey) return;
    state.screen = "mission";
    state.missionStepIndex = 0;
    state.missionAnswer = "";
    state.selectedOption = null;
    render();
  });

  byId("m-ans")?.addEventListener("input", (event) => {
    state.missionAnswer = event.target.value;
    refreshMissionNextButton();
  });

  byId("btn-mnext")?.addEventListener("click", () => {
    const mission = getCurrentMission();
    if (!mission) return;
    // 붙여넣고 바로 결과 보기를 누르면 state 갱신보다 클릭이 먼저 처리될 수 있어 textarea 값을 다시 읽는다.
    const answerInput = byId("m-ans");
    const answer = answerInput?.value ?? state.missionAnswer;
    state.missionAnswer = answer;
    if (answer.trim().length <= 10) {
      refreshMissionNextButton();
      return;
    }
    // 채점 요청이 중복 제출되면 결과 로그와 점수가 두 번 쌓일 수 있어 버튼을 잠근다.
    const nextButton = byId("btn-mnext");
    if (nextButton) nextButton.disabled = true;
    if (!state.missionScores[mission.job_code]) state.missionScores[mission.job_code] = [];

    const pending = scoreAnswer(answer, mission)
      .then((scored) => {
        state.missionScores[mission.job_code].push(scored.missionScore);
        saveEvaluationLog({
          schema_version: 1,
          session_id: state.sessionId || (state.sessionId = crypto.randomUUID?.() || String(Date.now())),
          created_at: new Date().toISOString(),
          user_key: "local-anonymous",
          job_code: mission.job_code,
          mission_key: mission.key || null,
          mission_id: mission.mission_id,
          mission_title: mission.title,
          answer,
          prompt_version: scored.evaluation.prompt_version,
          evaluation: scored.evaluation,
          mission_score: scored.missionScore
        });
      })
      .catch((error) => {
        // 실패한 채점을 0점으로 저장하면 결과가 왜곡되므로 상위 흐름에서 재시도 화면을 띄운다.
        console.warn("Background score failed:", error);
        throw error;
      });

    state.pendingScores.push(pending);
    advanceMissionFlow();
  });

  byId("btn-mission-back")?.addEventListener("click", () => {
    state.screen = "mission-list";
    state.missionAnswer = "";
    state.selectedOption = null;
    render();
  });

  byId("btn-restart")?.addEventListener("click", () => {
    resetState();
    delete state.sessionId;
    try {
      localStorage.removeItem("jobsim:evaluation_logs:v1");
    } catch (_) {
      // ignore localStorage failures
    }
    render();
  });
}

export function refreshMissionNextButton(ctx) {
  const { state, getCurrentMission } = ctx;
  const button = document.getElementById("btn-mnext");
  if (!button) return;
  const mission = getCurrentMission();
  if (!mission) return;
  const enabled = state.missionAnswer.trim().length > 10;
  button.disabled = !enabled;
  const charCt = document.querySelector(".char-ct");
  if (charCt) charCt.textContent = `${state.missionAnswer.length}자`;
}

export function advanceMissionFlow(ctx) {
  const { appNode, state, fetchResultSummary, render } = ctx;

  const showResult = async () => {
    await fetchResultSummary();
    state.screen = "result";
    render();
  };

  if (state.pendingScores.length > 0) {
    appNode.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:20px">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <div style="font-size:16px;font-weight:600">결과를 분석하고 있어요</div>
      <div style="font-size:13px;color:var(--sub);text-align:center">AI가 답변을 꼼꼼히 검토하고 있어요.<br>잠시만 기다려주세요.</div>
    </div>`;
    Promise.all(state.pendingScores).then(async () => {
      state.pendingScores = [];
      await showResult();
    }).catch((error) => {
      // 일부 채점이라도 실패하면 결과 화면으로 넘기지 않고 사용자가 다시 제출할 수 있게 한다.
      const reason = (error && error.message) ? error.message : String(error);
      state.pendingScores = [];
      appNode.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:18px;text-align:center;padding:24px">
        <div style="font-size:20px;font-weight:800;color:var(--danger)">채점에 실패했습니다</div>
        <div style="max-width:620px;color:var(--sub);line-height:1.7">
          AI 채점 요청이 완료되지 않아 0점 결과로 저장하지 않았습니다.<br>
          잠시 후 다시 시도해 주세요.
        </div>
        <pre style="max-width:760px;white-space:pre-wrap;text-align:left;background:var(--bg2);border:1px solid var(--b0);border-radius:8px;padding:12px;color:var(--t2);font-size:12px">${escapeHtml(reason)}</pre>
        <button class="btn btn-p" id="btn-score-retry">미션으로 돌아가기</button>
      </div>`;
      document.getElementById("btn-score-retry")?.addEventListener("click", () => {
        state.screen = "mission";
        render();
      });
    });
    return;
  }

  void showResult();
}
